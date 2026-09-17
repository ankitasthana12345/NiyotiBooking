const { getPool, sql } = require("../config/db");
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

const listAvailability = asyncHandler(async (req, res) => {
  const pool = await getPool();
  const eventId = req.query.eventId ? Number(req.query.eventId) : null;

  const request = pool.request();
  let query = `
    SELECT
      av.AvailabilityId,
      av.EventId,
      ce.Title AS EventTitle,
      CONVERT(VARCHAR(10), av.AvailableDate, 23) AS AvailableDate,
      CONVERT(VARCHAR(8), av.StartTime, 108) AS StartTime,
      CONVERT(VARCHAR(8), av.EndTime, 108) AS EndTime,
      av.DurationMinutes,
      av.BufferBeforeMinutes,
      av.BufferAfterMinutes,
      av.MeetingPlatform,
      av.MeetingLink,
      av.Status,
      av.CreatedDate,
      av.UpdatedDate
    FROM dbo.Availability av
    INNER JOIN dbo.ConsultationEvents ce ON ce.EventId = av.EventId
  `;

  if (eventId) {
    request.input("eventId", sql.Int, eventId);
    query += " WHERE av.EventId = @eventId ";
  }

  query += " ORDER BY av.AvailableDate, av.StartTime ";
  const result = await request.query(query);

  return successResponse(res, "Availability fetched", { availability: result.recordset });
});

const getAvailabilityByEventId = asyncHandler(async (req, res) => {
  try {
    const pool = await getPool();
    const eventId = Number(req.params.eventId);

    const result = await pool
      .request()
      .input("eventId", sql.Int, eventId)
      .query(`
        SELECT
          av.AvailabilityId,
          av.EventId,
          CONVERT(VARCHAR(10), av.AvailableDate, 23) AS AvailableDate,
          CONVERT(VARCHAR(8), av.StartTime, 108) AS StartTime,
          CONVERT(VARCHAR(8), av.EndTime, 108) AS EndTime,
          av.DurationMinutes,
          av.BufferBeforeMinutes,
          av.BufferAfterMinutes,
          av.MeetingPlatform,
          av.MeetingLink,
          av.Status,
          CASE WHEN EXISTS (
            SELECT 1 FROM dbo.Bookings b
            WHERE b.AvailabilityId = av.AvailabilityId
              AND b.Status IN ('PENDING', 'CONFIRMED', 'RESCHEDULED')
          ) THEN 1 ELSE 0 END AS IsBooked
        FROM dbo.Availability av
        WHERE av.EventId = @eventId
        ORDER BY av.AvailableDate, av.StartTime
      `);

    return successResponse(res, "Availability fetched", { availability: result.recordset });
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

  const tx = new sql.Transaction(pool);
  await tx.begin();

  const insertedIds = [];
  try {
    for (const slot of slots) {
      const insertResult = await new sql.Request(tx)
        .input("eventId", sql.Int, Number(eventId))
        .input("availableDate", sql.Date, availableDate)
        .input("startTime", sql.Time, slot.start)
        .input("endTime", sql.Time, slot.end)
        .input("durationMinutes", sql.Int, duration)
        .input("bufferBeforeMinutes", sql.Int, before)
        .input("bufferAfterMinutes", sql.Int, after)
        .input("meetingPlatform", sql.NVarChar(30), meetingPlatform || "Google Meet")
        .input("meetingLink", sql.NVarChar(1000), meetingLink || null)
        .input("status", sql.NVarChar(20), status || "ENABLED")
        .query(`
          DECLARE @InsertedIds TABLE (AvailabilityId INT);

          INSERT INTO dbo.Availability
          (
            EventId, AvailableDate, StartTime, EndTime,
            DurationMinutes, BufferBeforeMinutes, BufferAfterMinutes, MeetingPlatform, MeetingLink, Status
          )
          OUTPUT INSERTED.AvailabilityId INTO @InsertedIds (AvailabilityId)
          VALUES
          (
            @eventId, @availableDate, @startTime, @endTime,
            @durationMinutes, @bufferBeforeMinutes, @bufferAfterMinutes, @meetingPlatform, @meetingLink, @status
          );

          SELECT TOP 1 AvailabilityId FROM @InsertedIds;
        `);

      insertedIds.push(insertResult.recordset[0].AvailabilityId);
    }

    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
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

  const rangeStart = new Date(`${startDate}T00:00:00`);
  const rangeEnd = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime()) || rangeStart > rangeEnd) {
    return errorResponse(res, "Invalid date range", "INVALID_DATE_RANGE", 400);
  }

  const dayCount = Math.round((rangeEnd - rangeStart) / 86400000) + 1;
  if (dayCount > 366) {
    return errorResponse(res, "Date range is too large (max 366 days)", "RANGE_TOO_LARGE", 400);
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
  const cursor = new Date(rangeStart);
  const now = new Date();

  while (cursor <= rangeEnd) {
    const entry = scheduleByDay.get(cursor.getDay());
    if (entry && entry.enabled) {
      const dateStr = localDateString(cursor);

      for (const time of entry.times) {
        const slotStartAt = new Date(`${dateStr}T${time}`);
        const slotEndAt = new Date(slotStartAt.getTime() + duration * 60000);

        if (slotStartAt > now) {
          candidateSlots.push({
            availableDate: dateStr,
            startTime: time,
            endTime: `${String(slotEndAt.getHours()).padStart(2, "0")}:${String(slotEndAt.getMinutes()).padStart(2, "0")}`,
          });
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  if (candidateSlots.length === 0) {
    return errorResponse(res, "No valid slots could be generated for this schedule", "NO_SLOTS_GENERATED", 400);
  }

  const pool = await getPool();
  const insertedIds = [];
  const skipped = [];

  for (const slot of candidateSlots) {
    try {
      const insertResult = await pool
        .request()
        .input("eventId", sql.Int, Number(eventId))
        .input("availableDate", sql.Date, slot.availableDate)
        .input("startTime", sql.Time, slot.startTime)
        .input("endTime", sql.Time, slot.endTime)
        .input("durationMinutes", sql.Int, duration)
        .input("meetingPlatform", sql.NVarChar(30), meetingPlatform || "Google Meet")
        .input("meetingLink", sql.NVarChar(1000), meetingLink || null)
        .input("status", sql.NVarChar(20), status || "ENABLED")
        .query(`
          DECLARE @InsertedIds TABLE (AvailabilityId INT);

          INSERT INTO dbo.Availability
          (
            EventId, AvailableDate, StartTime, EndTime,
            DurationMinutes, MeetingPlatform, MeetingLink, Status
          )
          OUTPUT INSERTED.AvailabilityId INTO @InsertedIds (AvailabilityId)
          VALUES
          (
            @eventId, @availableDate, @startTime, @endTime,
            @durationMinutes, @meetingPlatform, @meetingLink, @status
          );

          SELECT TOP 1 AvailabilityId FROM @InsertedIds;
        `);

      insertedIds.push(insertResult.recordset[0].AvailabilityId);
    } catch (error) {
      skipped.push({ date: slot.availableDate, startTime: slot.startTime, reason: error.message });
    }
  }

  if (insertedIds.length === 0) {
    return errorResponse(res, `All ${skipped.length} candidate slot(s) were skipped (likely overlaps)`, "ALL_SLOTS_SKIPPED", 409);
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
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .input("availableDate", sql.Date, availableDate)
    .input("startTime", sql.Time, startTime)
    .input("endTime", sql.Time, endTime)
    .input("durationMinutes", sql.Int, durationMinutes)
    .input("bufferBeforeMinutes", sql.Int, bufferBeforeMinutes || 0)
    .input("bufferAfterMinutes", sql.Int, bufferAfterMinutes || 0)
    .input("meetingPlatform", sql.NVarChar(30), meetingPlatform || "Google Meet")
    .input("meetingLink", sql.NVarChar(1000), meetingLink || null)
    .input("status", sql.NVarChar(20), status)
    .query(`
      UPDATE dbo.Availability
      SET
        AvailableDate = @availableDate,
        StartTime = @startTime,
        EndTime = @endTime,
        DurationMinutes = @durationMinutes,
        BufferBeforeMinutes = @bufferBeforeMinutes,
        BufferAfterMinutes = @bufferAfterMinutes,
        MeetingPlatform = @meetingPlatform,
        MeetingLink = @meetingLink,
        Status = @status,
        UpdatedDate = SYSUTCDATETIME()
      WHERE AvailabilityId = @id
    `);

  if (result.rowsAffected[0] === 0) {
    return errorResponse(res, "Availability not found", "AVAILABILITY_NOT_FOUND", 404);
  }

  return successResponse(res, "Availability updated");
});

const deleteAvailability = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const pool = await getPool();

  try {
    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .query("DELETE FROM dbo.Availability WHERE AvailabilityId = @id");

    if (result.rowsAffected[0] === 0) {
      return errorResponse(res, "Availability not found", "AVAILABILITY_NOT_FOUND", 404);
    }

    return successResponse(res, "Availability deleted", { fellBackToDisable: false });
  } catch (error) {
    // This slot has booking history (even a rejected/cancelled one) referencing it via
    // FK, so it can't be hard-deleted without losing that history. Disabling it instead
    // achieves what the admin actually wants — it stops appearing to customers — without
    // breaking referential integrity.
    if (!/REFERENCE constraint|FK_Bookings_Availability/i.test(error.message || "")) {
      throw error;
    }

    const disableResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query("UPDATE dbo.Availability SET Status = 'DISABLED', UpdatedDate = SYSUTCDATETIME() WHERE AvailabilityId = @id");

    if (disableResult.rowsAffected[0] === 0) {
      return errorResponse(res, "Availability not found", "AVAILABILITY_NOT_FOUND", 404);
    }

    return successResponse(
      res,
      "This slot has booking history, so it can't be permanently deleted — it has been disabled instead and will no longer be shown to customers.",
      { fellBackToDisable: true }
    );
  }
});

const enableAvailability = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("UPDATE dbo.Availability SET Status = 'ENABLED', UpdatedDate = SYSUTCDATETIME() WHERE AvailabilityId = @id");

  if (result.rowsAffected[0] === 0) {
    return errorResponse(res, "Availability not found", "AVAILABILITY_NOT_FOUND", 404);
  }

  return successResponse(res, "Availability enabled");
});

const disableAvailability = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("UPDATE dbo.Availability SET Status = 'DISABLED', UpdatedDate = SYSUTCDATETIME() WHERE AvailabilityId = @id");

  if (result.rowsAffected[0] === 0) {
    return errorResponse(res, "Availability not found", "AVAILABILITY_NOT_FOUND", 404);
  }

  return successResponse(res, "Availability disabled");
});

const ALLOWED_NOTICE_HOURS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24, 36, 48];

const getBookingSettings = asyncHandler(async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT MinimumNoticeHours FROM dbo.BookingSettings WHERE SettingId = 1
  `);

  const minimumNoticeHours = result.recordset[0]?.MinimumNoticeHours ?? 24;
  return successResponse(res, "Booking settings fetched", { minimumNoticeHours });
});

const updateBookingSettings = asyncHandler(async (req, res) => {
  const { minimumNoticeHours } = req.body;

  if (!ALLOWED_NOTICE_HOURS.includes(Number(minimumNoticeHours))) {
    return errorResponse(res, "Invalid minimum notice hours", "INVALID_NOTICE_HOURS", 400);
  }

  const pool = await getPool();
  await pool
    .request()
    .input("minimumNoticeHours", sql.Int, Number(minimumNoticeHours))
    .query(`
      UPDATE dbo.BookingSettings
      SET MinimumNoticeHours = @minimumNoticeHours, UpdatedDate = SYSUTCDATETIME()
      WHERE SettingId = 1
    `);

  return successResponse(res, "Booking settings updated", { minimumNoticeHours: Number(minimumNoticeHours) });
});

const listPublicAvailability = asyncHandler(async (req, res) => {
  const eventId = Number(req.params.eventId);
  const pool = await getPool();

  const result = await pool
    .request()
    .input("eventId", sql.Int, eventId)
    .query(`
      SELECT
        av.AvailabilityId,
        av.EventId,
        CONVERT(VARCHAR(10), av.AvailableDate, 23) AS AvailableDate,
        CONVERT(VARCHAR(8), av.StartTime, 108) AS StartTime,
        CONVERT(VARCHAR(8), av.EndTime, 108) AS EndTime,
        av.MeetingPlatform,
        av.MeetingLink,
        av.Status,
        e.DurationMinutes,
        e.BufferBeforeMinutes,
        e.BufferAfterMinutes
      FROM dbo.Availability av
      INNER JOIN dbo.ConsultationEvents e ON e.EventId = av.EventId
      WHERE av.EventId = @eventId
        AND av.Status = 'ENABLED'
        AND e.IsActive = 1
        AND DATETIMEFROMPARTS(
          YEAR(av.AvailableDate), MONTH(av.AvailableDate), DAY(av.AvailableDate),
          DATEPART(HOUR, av.StartTime), DATEPART(MINUTE, av.StartTime), DATEPART(SECOND, av.StartTime), 0
        ) > DATEADD(
          HOUR,
          (SELECT MinimumNoticeHours FROM dbo.BookingSettings WHERE SettingId = 1),
          DATEADD(MINUTE, 330, SYSUTCDATETIME())
        )
        AND av.AvailableDate <= CONVERT(DATE, DATEADD(DAY, 14, DATEADD(MINUTE, 330, SYSUTCDATETIME())))
        AND NOT EXISTS (
          SELECT 1
          FROM dbo.Bookings b
          WHERE b.AvailabilityId = av.AvailabilityId
            AND b.Status IN ('PENDING', 'CONFIRMED', 'RESCHEDULED')
        )
      ORDER BY av.AvailableDate, av.StartTime
    `);

  return successResponse(res, "Public availability fetched", { availability: result.recordset });
});

module.exports = {
  listAvailability,
  getAvailabilityByEventId,
  createAvailability,
  createWeeklyAvailability,
  updateAvailability,
  deleteAvailability,
  enableAvailability,
  disableAvailability,
  getBookingSettings,
  updateBookingSettings,
  listPublicAvailability,
};
