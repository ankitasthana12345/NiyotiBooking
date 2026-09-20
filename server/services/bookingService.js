const { randomUUID, createHash } = require("crypto");
const { getPool } = require("../config/db");

async function getBookingById(bookingId) {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT
        b."BookingId",
        b."BookingReference",
        b."EventId",
        b."AvailabilityId",
        b."CustomerName",
        b."Title" AS "CustomerTitle",
        b."Gender",
        b."Profession",
        b."CustomerEmail",
        b."PhoneNumber",
        b."Message",
        b."BookingDate",
        b."StartTime",
        b."EndTime",
        b."MeetingPlatform",
        b."MeetingLink",
        b."Status",
        e."Title",
        e."DurationMinutes",
        e."NotificationEmail"
      FROM "Bookings" b
      INNER JOIN "ConsultationEvents" e ON e."EventId" = b."EventId"
      WHERE b."BookingId" = $1`,
    [bookingId]
  );

  return result.rows[0] || null;
}

// Customers can only book slots up to this many days ahead. Must match the window
// used by availabilityController.js::listPublicAvailability.
const BOOKING_WINDOW_DAYS = 14;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

// One person = same email OR same phone number. MySQL named locks serialise
// concurrent bookings for the same person, because there's no existing row to
// SELECT ... FOR UPDATE when the person has no bookings yet.
function personLockNames(email, phoneDigits) {
  const keys = [`email:${email}`];
  if (phoneDigits) keys.push(`phone:${phoneDigits}`);
  return keys.map((key) => `bp:${createHash("sha1").update(key).digest("hex")}`).sort();
}

async function releasePersonLocks(client, names) {
  for (const name of names) {
    try {
      await client.query('SELECT RELEASE_LOCK($1) AS "ok"', [name]);
    } catch (_) {
      // The lock is dropped when the connection closes anyway.
    }
  }
}

async function acquirePersonLocks(client, names) {
  const acquired = [];
  for (const name of names) {
    const result = await client.query('SELECT GET_LOCK($1, 10) AS "ok"', [name]);
    if (Number(result.rows[0]?.ok) !== 1) {
      await releasePersonLocks(client, acquired);
      throw new Error("Another booking for this customer is in progress. Please try again.");
    }
    acquired.push(name);
  }
  return acquired;
}

async function hasUpcomingBookingForPerson(queryable, email, phoneDigits) {
  const result = await queryable.query(
    `SELECT "BookingId"
       FROM "Bookings"
      WHERE "Status" IN ('PENDING', 'CONFIRMED', 'RESCHEDULED')
        AND TIMESTAMP("BookingDate", "StartTime") > DATE_ADD(UTC_TIMESTAMP(), INTERVAL 330 MINUTE)
        AND (
          LOWER("CustomerEmail") = $1
          OR ($2 <> '' AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE("PhoneNumber", ' ', ''), '+', ''), '-', ''), '(', ''), ')', '') = $2)
        )
      LIMIT 1`,
    [email, phoneDigits]
  );
  return result.rows.length > 0;
}

// Ported from the SQL Server dbo.sp_CreatePublicBooking stored procedure: same
// lock-then-check-then-insert shape as rescheduleBooking below, using
// SELECT ... FOR UPDATE in place of WITH (UPDLOCK, HOLDLOCK). Validation order
// and thrown error text intentionally match the old THROW messages so
// bookingController.js's mapBookingError() substring matching keeps working
// unchanged.
async function createPublicBooking({
  eventId,
  availabilityId,
  customerName,
  title,
  gender,
  profession,
  customerEmail,
  phoneNumber,
  message,
}) {
  const pool = await getPool();

  const settingsResult = await pool.query(`SELECT "MinimumNoticeHours" FROM "BookingSettings" WHERE "SettingId" = 1`);
  const minimumNoticeHours = settingsResult.rows[0]?.MinimumNoticeHours ?? 24;

  const email = normalizeEmail(customerEmail);
  const phoneDigits = normalizePhone(phoneNumber);

  const client = await pool.connect();
  let heldLocks = [];
  try {
    // Locks must be taken before BEGIN so the transaction snapshot is created after
    // any concurrent booking for the same person has committed.
    heldLocks = await acquirePersonLocks(client, personLockNames(email, phoneDigits));
    await client.query("BEGIN");

    const slotResult = await client.query(
      `SELECT
          av."AvailableDate", av."StartTime", av."EndTime", av."Status" AS "SlotStatus",
          av."MeetingPlatform", av."MeetingLink",
          ce."RequiresApproval", ce."IsActive" AS "IsEventActive",
          TIMESTAMP(av."AvailableDate", av."StartTime") <= DATE_ADD(
            DATE_ADD(UTC_TIMESTAMP(), INTERVAL 330 MINUTE), INTERVAL $3 HOUR
          ) AS "NoticeViolated",
          av."AvailableDate" > DATE(
            DATE_ADD(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 330 MINUTE), INTERVAL ${BOOKING_WINDOW_DAYS} DAY)
          ) AS "BeyondWindow"
        FROM "Availability" av
        INNER JOIN "ConsultationEvents" ce ON ce."EventId" = av."EventId"
        WHERE av."AvailabilityId" = $1 AND av."EventId" = $2
        FOR UPDATE OF av`,
      [availabilityId, eventId, minimumNoticeHours]
    );

    const slot = slotResult.rows[0];
    if (!slot) {
      throw new Error("Selected slot was not found.");
    }
    if (!slot.IsEventActive) {
      throw new Error("Event is disabled.");
    }
    if (slot.SlotStatus !== "ENABLED") {
      throw new Error("Selected slot is not available.");
    }
    if (slot.NoticeViolated) {
      throw new Error("This slot no longer meets the minimum booking notice.");
    }

    if (slot.BeyondWindow) {
      throw new Error("This slot is outside the two-week booking window.");
    }

    if (await hasUpcomingBookingForPerson(client, email, phoneDigits)) {
      throw new Error("You already have an upcoming appointment with this email or phone number.");
    }

    const duplicateResult = await client.query(
      `SELECT "BookingId"
        FROM "Bookings"
        WHERE "AvailabilityId" = $1
          AND "Status" IN ('PENDING', 'CONFIRMED', 'RESCHEDULED')
        LIMIT 1
        FOR UPDATE`,
      [availabilityId]
    );

    if (duplicateResult.rows.length > 0) {
      throw new Error("This slot has already been booked.");
    }

    const bookingStatus = slot.RequiresApproval ? "PENDING" : "CONFIRMED";

    // The MySQL schema has no DEFAULT (UUID()) for BookingReference (unsupported on
    // the hosted DB), so it's generated here.
    const insertResult = await client.query(
      `INSERT INTO "Bookings"
        ("EventId", "AvailabilityId", "CustomerName", "Title", "Gender", "Profession", "CustomerEmail", "PhoneNumber", "Message",
         "BookingDate", "StartTime", "EndTime", "MeetingPlatform", "MeetingLink", "Status", "BookingReference")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING "BookingId"`,
      [
        eventId,
        availabilityId,
        customerName,
        title || null,
        gender || null,
        profession ? String(profession).trim() : null,
        customerEmail,
        phoneNumber || null,
        message || null,
        slot.AvailableDate,
        slot.StartTime,
        slot.EndTime,
        slot.MeetingPlatform,
        slot.MeetingLink,
        bookingStatus,
        randomUUID(),
      ]
    );

    await client.query("COMMIT");
    return getBookingById(insertResult.rows[0].BookingId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await releasePersonLocks(client, heldLocks);
    client.release();
  }
}

async function updateBookingStatus({ bookingId, status }) {
  const pool = await getPool();
  await pool.query(
    `UPDATE "Bookings"
     SET "Status" = $1,
         "UpdatedDate" = UTC_TIMESTAMP()
     WHERE "BookingId" = $2`,
    [status, bookingId]
  );

  return getBookingById(bookingId);
}

async function rescheduleBooking({ bookingId, newAvailabilityId }) {
  const pool = await getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const lockResult = await client.query(
      `SELECT "BookingId", "EventId"
       FROM "Bookings"
       WHERE "BookingId" = $1
       FOR UPDATE`,
      [bookingId]
    );

    const lockedBooking = lockResult.rows[0];
    if (!lockedBooking) {
      throw new Error("Booking not found");
    }

    const slotResult = await client.query(
      `SELECT "AvailabilityId", "AvailableDate", "StartTime", "EndTime", "MeetingPlatform", "MeetingLink", "Status"
       FROM "Availability"
       WHERE "AvailabilityId" = $1
         AND "EventId" = $2
       FOR UPDATE`,
      [newAvailabilityId, lockedBooking.EventId]
    );

    const slot = slotResult.rows[0];
    if (!slot) {
      throw new Error("Selected slot not found");
    }
    if (slot.Status !== "ENABLED") {
      throw new Error("Selected slot is not enabled");
    }

    const duplicateResult = await client.query(
      `SELECT "BookingId"
       FROM "Bookings"
       WHERE "AvailabilityId" = $1
         AND "Status" IN ('PENDING', 'CONFIRMED', 'RESCHEDULED')
       LIMIT 1
       FOR UPDATE`,
      [newAvailabilityId]
    );

    if (duplicateResult.rows.length > 0) {
      throw new Error("Selected slot is already booked");
    }

    await client.query(
      `UPDATE "Bookings"
       SET "AvailabilityId" = $1,
           "BookingDate" = $2,
           "StartTime" = $3,
           "EndTime" = $4,
           "MeetingPlatform" = $5,
           "MeetingLink" = $6,
           "Status" = 'RESCHEDULED',
           "UpdatedDate" = UTC_TIMESTAMP()
       WHERE "BookingId" = $7`,
      [slot.AvailabilityId, slot.AvailableDate, slot.StartTime, slot.EndTime, slot.MeetingPlatform, slot.MeetingLink, bookingId]
    );

    await client.query("COMMIT");
    return getBookingById(bookingId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  getBookingById,
  createPublicBooking,
  updateBookingStatus,
  rescheduleBooking,
};
