const { getPool } = require("../config/db");
const logger = require("../config/logger");
const asyncHandler = require("../utils/asyncHandler");
const { successResponse, errorResponse } = require("../utils/apiResponse");

function toDateTime(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}`);
}

// NOTE: must read local (server) time fields, not toISOString() (which converts to
// UTC) — on an IST machine that silently shifts every stored time back 5.5 hours.
function timeString(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function localDateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Stands in for the Postgres trg_Availability_NoOverlap trigger, which the MySQL
// schema (database.sql) can't include. Not race-proof against two simultaneous
// admin writes, but availability is admin-only so that's an acceptable tradeoff.
async function hasOverlappingSlot(queryable, eventId, date, startTime, endTime, excludeId = 0) {
  const result = await queryable.query(
    `SELECT "AvailabilityId"
       FROM "Availability"
      WHERE "EventId" = $1
        AND "AvailableDate" = $2
        AND "StartTime" < $3
        AND "EndTime" > $4
        AND "AvailabilityId" <> $5
      LIMIT 1`,
    [eventId, date, endTime, startTime, excludeId]
  );
  return result.rows.length > 0;
}

async function eventIdForSlot(queryable, availabilityId) {
  const result = await queryable.query('SELECT "EventId" FROM "Availability" WHERE "AvailabilityId" = $1', [availabilityId]);
  return result.rows[0]?.EventId ?? 0;
}

// Slots always belong to a consultation event (FK), but admins shouldn't have to
// set one up before generating availability. Use the requested event if it exists,
// else the first active (or any) event, else create a default one so a fresh
// database works out of the box.
async function resolveEventId(pool, requestedId) {
  if (requestedId) {
    const found = await pool.query('SELECT "EventId" FROM "ConsultationEvents" WHERE "EventId" = $1', [Number(requestedId)]);
    if (found.rows.length > 0) return Number(found.rows[0].EventId);
  }

  // Same ordering as listPublicEvents (newest active first), because the public
  // booking page shows slots for the first event in that list.
  const existing = await pool.query(
    'SELECT "EventId" FROM "ConsultationEvents" ORDER BY "IsActive" DESC, "CreatedDate" DESC, "EventId" DESC LIMIT 1'
  );
  if (existing.rows.length > 0) return Number(existing.rows[0].EventId);

  const created = await pool.query(
    `INSERT INTO "ConsultationEvents"
      ("Title", "Description", "DurationMinutes", "MeetingPlatform", "RequiresApproval", "IsActive")
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING "EventId"`,
    ["Consultation", "Book a consultation slot.", 30, "Google Meet", true, true]
  );
  logger.info("Created default consultation event", { eventId: created.rows[0].EventId });
  return Number(created.rows[0].EventId);
}

const PAST_MIDNIGHT_REASON = "Slot would run past midnight";
const OVERLAP_MESSAGE ="This slot overlaps an existing slot for the same event and date";

const listAvailability = asyncHandler(async (req, res) => {
  const pool = await getPool();
  const eventId = req.query.eventId ? Number(req.query.eventId) : null;

  const params = [];
  let query = `
    SELECT
      av."AvailabilityId",
      av."EventId",
      ce."Title" AS "EventTitle",
      av."AvailableDate",
      av."StartTime",
      av."EndTime",
      av."DurationMinutes",
      av."BufferBeforeMinutes",
      av."BufferAfterMinutes",
      av."MeetingPlatform",
      av."MeetingLink",
      av."Status",
      av."CreatedDate",
      av."UpdatedDate",
      CASE WHEN EXISTS (
        SELECT 1 FROM "Bookings" b
        WHERE b."AvailabilityId" = av."AvailabilityId"
          AND b."Status" IN ('PENDING', 'CONFIRMED', 'RESCHEDULED')
      ) THEN 1 ELSE 0 END AS "IsBooked"
    FROM "Availability" av
    INNER JOIN "ConsultationEvents" ce ON ce."EventId" = av."EventId"
  `;

  if (eventId) {
    params.push(eventId);
    query += ` WHERE av."EventId" = $${params.length} `;
  }

  query += ' ORDER BY av."AvailableDate", av."StartTime" ';
  const result = await pool.query(query, params);

  return successResponse(res, "Availability fetched", { availability: result.rows });
});

const getAvailabilityByEventId = asyncHandler(async (req, res) => {
  try {
    const pool = await getPool();
    const eventId = Number(req.params.eventId);

    const result = await pool.query(
      `SELECT
          av."AvailabilityId",
          av."EventId",
          av."AvailableDate",
          av."StartTime",
          av."EndTime",
          av."DurationMinutes",
          av."BufferBeforeMinutes",
          av."BufferAfterMinutes",
          av."MeetingPlatform",
          av."MeetingLink",
          av."Status",
          CASE WHEN EXISTS (
            SELECT 1 FROM "Bookings" b
            WHERE b."AvailabilityId" = av."AvailabilityId"
              AND b."Status" IN ('PENDING', 'CONFIRMED', 'RESCHEDULED')
          ) THEN 1 ELSE 0 END AS "IsBooked"
        FROM "Availability" av
        WHERE av."EventId" = $1
        ORDER BY av."AvailableDate", av."StartTime"`,
      [eventId]
    );

    return successResponse(res, "Availability fetched", { availability: result.rows });
  } catch (err) {
    // If DB unavailable, return empty availability so client can continue
    return successResponse(res, "Availability fetched (db unavailable)", { availability: [] });
  }
});

const ALLOWED_MEETING_PLATFORMS = ["Google Meet", "Zoom", "Microsoft Teams", "Custom"];
const URL_PATTERN = /^https?:\/\/[^\s]+$/i;

const createAvailability = asyncHandler(async (req, res) => {
  const {
    eventId,
    availableDate,
    startTime,
    endTime,
    durationMinutes,
    bufferBeforeMinutes,
    bufferAfterMinutes,
    meetingPlatform,
    meetingLink,
    status,
  } = req.body;

  if (meetingPlatform && !ALLOWED_MEETING_PLATFORMS.includes(meetingPlatform)) {
    return errorResponse(res, "Invalid meeting platform", "INVALID_MEETING_PLATFORM", 400);
  }

  if (meetingLink && !URL_PATTERN.test(meetingLink)) {
    return errorResponse(res, "Meeting link must be a valid http(s) URL", "INVALID_MEETING_LINK", 400);
  }

  const startAt = toDateTime(availableDate, startTime);
  const endAt = toDateTime(availableDate, endTime);
  const before = Number(bufferBeforeMinutes || 0);
  const after = Number(bufferAfterMinutes || 0);
  const duration = Number(durationMinutes);
  const stepMinutes = duration + before + after;

  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || startAt >= endAt) {
    return errorResponse(res, "Invalid availability time window", "INVALID_TIME_WINDOW", 400);
  }

  if (startAt <= new Date()) {
    return errorResponse(res, "Cannot create a slot in the past", "PAST_SLOT", 400);
  }

  if (stepMinutes <= 0) {
    return errorResponse(res, "Invalid duration/buffer combination", "INVALID_SLOT_CONFIG", 400);
  }

  const pool = await getPool();
  const resolvedEventId = await resolveEventId(pool, eventId);

  const slots = [];
  let pointer = new Date(startAt);
  while (pointer < endAt) {
    const slotStart = new Date(pointer);
    const slotEnd = new Date(pointer.getTime() + duration * 60000);
    if (slotEnd > endAt) break;

    slots.push({
      start: timeString(slotStart),
      end: timeString(slotEnd),
    });

    pointer = new Date(pointer.getTime() + stepMinutes * 60000);
  }

  if (slots.length === 0) {
    return errorResponse(res, "No valid slots could be generated for this window", "NO_SLOTS_GENERATED", 400);
  }

  const client = await pool.connect();
  const insertedIds = [];
  try {
    await client.query("BEGIN");

    for (const slot of slots) {
      if (await hasOverlappingSlot(client, resolvedEventId, availableDate, slot.start, slot.end)) {
        const overlapError = new Error(OVERLAP_MESSAGE);
        overlapError.code = "SLOT_OVERLAP";
        throw overlapError;
      }

      const insertResult = await client.query(
        `INSERT INTO "Availability"
          ("EventId", "AvailableDate", "StartTime", "EndTime",
           "DurationMinutes", "BufferBeforeMinutes", "BufferAfterMinutes", "MeetingPlatform", "MeetingLink", "Status")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING "AvailabilityId"`,
        [
          resolvedEventId,
          availableDate,
          slot.start,
          slot.end,
          duration,
          before,
          after,
          meetingPlatform || "Google Meet",
          meetingLink || null,
          status || "ENABLED",
        ]
      );

      insertedIds.push(insertResult.rows[0].AvailabilityId);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "SLOT_OVERLAP") {
      return errorResponse(res, error.message, "SLOT_OVERLAP", 409);
    }
    throw error;
  } finally {
    client.release();
  }

  return successResponse(
    res,
    "Availability slots created",
    { availabilityIds: insertedIds, slotsGenerated: insertedIds.length },
    201
  );
});

const ALLOWED_DURATIONS = [15, 30, 45, 60, 90, 120];
const TIME_24H_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_RANGE_DAYS = 7;
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const createWeeklyAvailability = asyncHandler(async (req, res) => {
  const {
    eventId,
    startDate,
    endDate,
    durationMinutes,
    meetingPlatform,
    meetingLink,
    status,
    weeklySchedule,
  } = req.body;

  if (meetingPlatform && !ALLOWED_MEETING_PLATFORMS.includes(meetingPlatform)) {
    return errorResponse(res, "Invalid meeting platform", "INVALID_MEETING_PLATFORM", 400);
  }

  if (meetingLink && !URL_PATTERN.test(meetingLink)) {
    return errorResponse(res, "Meeting link must be a valid http(s) URL", "INVALID_MEETING_LINK", 400);
  }

  const duration = Number(durationMinutes);
  if (!ALLOWED_DURATIONS.includes(duration)) {
    return errorResponse(res, "Invalid duration", "INVALID_DURATION", 400);
  }

  // Slot times are IST wall-clock. Use UTC-based date math and compare against
  // "now in IST" as a string so the result doesn't depend on the server's timezone.
  const rangeStart = new Date(`${String(startDate).slice(0, 10)}T00:00:00Z`);
  const rangeEnd = new Date(`${String(endDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime()) || rangeStart > rangeEnd) {
    return errorResponse(res, "Invalid date range", "INVALID_DATE_RANGE", 400);
  }

  const dayCount = Math.round((rangeEnd - rangeStart) / 86400000) + 1;
  // A range of at most 7 days maps each weekday to exactly one calendar date, so the
  // weekly schedule below is unambiguous (Mon-Fri = 5 dates, Fri-Wed = Fri..Wed).
  if (dayCount > MAX_RANGE_DAYS) {
    return errorResponse(res, `Date range is too large (max ${MAX_RANGE_DAYS} days)`, "RANGE_TOO_LARGE", 400);
  }

  if (!Array.isArray(weeklySchedule) || weeklySchedule.length !== 7) {
    return errorResponse(res, "weeklySchedule must include all 7 days", "INVALID_WEEKLY_SCHEDULE", 400);
  }

  const scheduleByDay = new Map();
  for (const entry of weeklySchedule) {
    const dow = Number(entry.dayOfWeek);
    if (Number.isNaN(dow) || dow < 0 || dow > 6) {
      return errorResponse(res, "Invalid dayOfWeek in weeklySchedule", "INVALID_WEEKLY_SCHEDULE", 400);
    }
    if (entry.enabled) {
      const times = Array.isArray(entry.times) ? entry.times : [];
      if (times.length === 0 || times.length > 50) {
        return errorResponse(res, `${DAY_LABELS[dow]} must have 1-50 times`, "INVALID_WEEKLY_SCHEDULE", 400);
      }
      if (times.some((t) => !TIME_24H_PATTERN.test(t || ""))) {
        return errorResponse(res, `Invalid time entry for ${DAY_LABELS[dow]}`, "INVALID_WEEKLY_SCHEDULE", 400);
      }
    }
    scheduleByDay.set(dow, entry);
  }

  if (![...scheduleByDay.values()].some((entry) => entry.enabled)) {
    return errorResponse(res, "Select at least one day of the week", "INVALID_WEEKLY_SCHEDULE", 400);
  }

  const candidateSlots = [];
  const skipped = [];
  const cursor = new Date(rangeStart);
  const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 16);

  while (cursor <= rangeEnd) {
    const entry = scheduleByDay.get(cursor.getUTCDay());
    if (entry && entry.enabled) {
      const dateStr = cursor.toISOString().slice(0, 10);

      for (const time of entry.times) {
        if (`${dateStr}T${time}` > nowIST) {
          const [h, m] = time.split(":").map(Number);
          const endMinutes = h * 60 + m + duration;
          if (endMinutes > 24 * 60) {
            // A slot can't run past midnight (EndTime would be earlier than StartTime).
            skipped.push({ date: dateStr, startTime: time, reason: PAST_MIDNIGHT_REASON });
            continue;
          }
          candidateSlots.push({
            availableDate: dateStr,
            startTime: time,
            endTime: `${String(Math.floor(endMinutes / 60) % 24).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`,
          });
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  if (candidateSlots.length === 0) {
    return errorResponse(
      res,
      skipped.length
        ? "No valid slots could be generated: the chosen times run past midnight for this duration"
        : "No valid slots could be generated for this schedule (all times are in the past)",
      "NO_SLOTS_GENERATED",
      400
    );
  }

  const pool = await getPool();
  const resolvedEventId = await resolveEventId(pool, eventId);
  const insertedIds = [];

  for (const slot of candidateSlots) {
    try {
      if (await hasOverlappingSlot(pool, resolvedEventId, slot.availableDate, slot.startTime, slot.endTime)) {
        throw new Error(OVERLAP_MESSAGE);
      }

      const insertResult = await pool.query(
        `INSERT INTO "Availability"
          ("EventId", "AvailableDate", "StartTime", "EndTime", "DurationMinutes", "MeetingPlatform", "MeetingLink", "Status")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING "AvailabilityId"`,
        [
          resolvedEventId,
          slot.availableDate,
          slot.startTime,
          slot.endTime,
          duration,
          meetingPlatform || "Google Meet",
          meetingLink || null,
          status || "ENABLED",
        ]
      );

      insertedIds.push(insertResult.rows[0].AvailabilityId);
    } catch (error) {
      // A duplicate start time hits the unique index; that's just an overlap.
      const reason = error.code === "ER_DUP_ENTRY" ? OVERLAP_MESSAGE : error.message;
      if (reason !== OVERLAP_MESSAGE) {
        logger.error("Weekly availability insert failed", { message: error.message, code: error.code, slot });
      }
      skipped.push({ date: slot.availableDate, startTime: slot.startTime, reason });
    }
  }

  if (insertedIds.length === 0) {
    const realFailure = skipped.find((s) => s.reason !== OVERLAP_MESSAGE && s.reason !== PAST_MIDNIGHT_REASON);
    if (realFailure) {
      return errorResponse(res, `Could not create slots: ${realFailure.reason}`, "SLOT_INSERT_FAILED", 500);
    }
    return errorResponse(res, `All ${skipped.length} candidate slot(s) were skipped (they overlap existing slots)`, "ALL_SLOTS_SKIPPED", 409);
  }

  return successResponse(
    res,
    `Generated ${insertedIds.length} slot(s)${skipped.length ? `, skipped ${skipped.length}` : ""}`,
    { availabilityIds: insertedIds, slotsGenerated: insertedIds.length, skipped },
    201
  );
});

const updateAvailability = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const {
    availableDate,
    startTime,
    endTime,
    durationMinutes,
    bufferBeforeMinutes,
    bufferAfterMinutes,
    meetingPlatform,
    meetingLink,
    status,
  } = req.body;

  if (meetingPlatform && !ALLOWED_MEETING_PLATFORMS.includes(meetingPlatform)) {
    return errorResponse(res, "Invalid meeting platform", "INVALID_MEETING_PLATFORM", 400);
  }

  if (meetingLink && !URL_PATTERN.test(meetingLink)) {
    return errorResponse(res, "Meeting link must be a valid http(s) URL", "INVALID_MEETING_LINK", 400);
  }

  const pool = await getPool();

  if (await hasOverlappingSlot(pool, await eventIdForSlot(pool, id), availableDate, startTime, endTime, id)) {
    return errorResponse(res, OVERLAP_MESSAGE, "SLOT_OVERLAP", 409);
  }

  const result = await pool.query(
    `UPDATE "Availability"
     SET
       "AvailableDate" = $1,
       "StartTime" = $2,
       "EndTime" = $3,
       "DurationMinutes" = $4,
       "BufferBeforeMinutes" = $5,
       "BufferAfterMinutes" = $6,
       "MeetingPlatform" = $7,
       "MeetingLink" = $8,
       "Status" = $9,
       "UpdatedDate" = UTC_TIMESTAMP()
     WHERE "AvailabilityId" = $10`,
    [
      availableDate,
      startTime,
      endTime,
      durationMinutes,
      bufferBeforeMinutes || 0,
      bufferAfterMinutes || 0,
      meetingPlatform || "Google Meet",
      meetingLink || null,
      status,
      id,
    ]
  );

  if (result.rowCount === 0) {
    return errorResponse(res, "Availability not found", "AVAILABILITY_NOT_FOUND", 404);
  }

  return successResponse(res, "Availability updated");
});

const deleteAvailability = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const pool = await getPool();

  try {
    const result = await pool.query('DELETE FROM "Availability" WHERE "AvailabilityId" = $1', [id]);

    if (result.rowCount === 0) {
      return errorResponse(res, "Availability not found", "AVAILABILITY_NOT_FOUND", 404);
    }

    return successResponse(res, "Availability deleted", { fellBackToDisable: false });
  } catch (error) {
    // This slot has booking history (even a rejected/cancelled one) referencing it via
    // FK, so it can't be hard-deleted without losing that history. Disabling it instead
    // achieves what the admin actually wants — it stops appearing to customers — without
    // breaking referential integrity.
    if (error.code !== "23503") {
      throw error;
    }

    const disableResult = await pool.query(
      `UPDATE "Availability" SET "Status" = 'DISABLED', "UpdatedDate" = UTC_TIMESTAMP() WHERE "AvailabilityId" = $1`,
      [id]
    );

    if (disableResult.rowCount === 0) {
      return errorResponse(res, "Availability not found", "AVAILABILITY_NOT_FOUND", 404);
    }

    return successResponse(
      res,
      "This slot has booking history, so it can't be permanently deleted — it has been disabled instead and will no longer be shown to customers.",
      { fellBackToDisable: true }
    );
  }
});

const disableAllAvailability = asyncHandler(async (req, res) => {
  const pool = await getPool();
  const result = await pool.query(
    `UPDATE "Availability"
        SET "Status" = 'DISABLED', "UpdatedDate" = UTC_TIMESTAMP()
      WHERE "Status" <> 'DISABLED'`
  );

  return successResponse(res, "All availability slots disabled", {
    slotsDisabled: result.rowCount,
    hardDeleted: false,
  });
});

const enableAvailability = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const pool = await getPool();
  const result = await pool.query(
    `UPDATE "Availability" SET "Status" = 'ENABLED', "UpdatedDate" = UTC_TIMESTAMP() WHERE "AvailabilityId" = $1`,
    [id]
  );

  if (result.rowCount === 0) {
    return errorResponse(res, "Availability not found", "AVAILABILITY_NOT_FOUND", 404);
  }

  return successResponse(res, "Availability enabled");
});

const disableAvailability = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const pool = await getPool();
  const result = await pool.query(
    `UPDATE "Availability" SET "Status" = 'DISABLED', "UpdatedDate" = UTC_TIMESTAMP() WHERE "AvailabilityId" = $1`,
    [id]
  );

  if (result.rowCount === 0) {
    return errorResponse(res, "Availability not found", "AVAILABILITY_NOT_FOUND", 404);
  }

  return successResponse(res, "Availability disabled");
});

const ALLOWED_NOTICE_HOURS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24, 36, 48];

const getBookingSettings = asyncHandler(async (req, res) => {
  const pool = await getPool();
  const result = await pool.query(`SELECT "MinimumNoticeHours" FROM "BookingSettings" WHERE "SettingId" = 1`);

  const minimumNoticeHours = result.rows[0]?.MinimumNoticeHours ?? 24;
  return successResponse(res, "Booking settings fetched", { minimumNoticeHours });
});

const updateBookingSettings = asyncHandler(async (req, res) => {
  const { minimumNoticeHours } = req.body;

  if (!ALLOWED_NOTICE_HOURS.includes(Number(minimumNoticeHours))) {
    return errorResponse(res, "Invalid minimum notice hours", "INVALID_NOTICE_HOURS", 400);
  }

  const pool = await getPool();
  await pool.query(
    `UPDATE "BookingSettings"
     SET "MinimumNoticeHours" = $1, "UpdatedDate" = UTC_TIMESTAMP()
     WHERE "SettingId" = 1`,
    [Number(minimumNoticeHours)]
  );

  return successResponse(res, "Booking settings updated", { minimumNoticeHours: Number(minimumNoticeHours) });
});

const listPublicAvailability = asyncHandler(async (req, res) => {
  const eventId = Number(req.params.eventId);
  const pool = await getPool();

  const result = await pool.query(
    `SELECT
        av."AvailabilityId",
        av."EventId",
        av."AvailableDate",
        av."StartTime",
        av."EndTime",
        av."MeetingPlatform",
        av."MeetingLink",
        av."Status",
        e."DurationMinutes",
        e."BufferBeforeMinutes",
        e."BufferAfterMinutes"
      FROM "Availability" av
      INNER JOIN "ConsultationEvents" e ON e."EventId" = av."EventId"
      WHERE av."EventId" = $1
        AND av."Status" = 'ENABLED'
        AND e."IsActive" = TRUE
        AND TIMESTAMP(av."AvailableDate", av."StartTime") > DATE_ADD(
          DATE_ADD(UTC_TIMESTAMP(), INTERVAL 330 MINUTE),
          INTERVAL (SELECT "MinimumNoticeHours" FROM "BookingSettings" WHERE "SettingId" = 1) HOUR
        )
        AND av."AvailableDate" <= DATE(DATE_ADD(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 330 MINUTE), INTERVAL 14 DAY))
        AND NOT EXISTS (
          SELECT 1
          FROM "Bookings" b
          WHERE b."AvailabilityId" = av."AvailabilityId"
            AND b."Status" IN ('PENDING', 'CONFIRMED', 'RESCHEDULED')
        )
      ORDER BY av."AvailableDate", av."StartTime"`,
    [eventId]
  );

  return successResponse(res, "Public availability fetched", { availability: result.rows });
});

module.exports = {
  listAvailability,
  getAvailabilityByEventId,
  createAvailability,
  createWeeklyAvailability,
  updateAvailability,
  deleteAvailability,
  disableAllAvailability,
  enableAvailability,
  disableAvailability,
  getBookingSettings,
  updateBookingSettings,
  listPublicAvailability,
};
