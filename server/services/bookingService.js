const { getPool, sql } = require("../config/db");

async function getBookingById(bookingId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("bookingId", sql.BigInt, bookingId)
    .query(`
      SELECT
        b.BookingId,
        b.BookingReference,
        b.EventId,
        b.AvailabilityId,
        b.CustomerName,
        b.CustomerEmail,
        b.PhoneNumber,
        b.Message,
        CONVERT(VARCHAR(10), b.BookingDate, 23) AS BookingDate,
        CONVERT(VARCHAR(8), b.StartTime, 108) AS StartTime,
        CONVERT(VARCHAR(8), b.EndTime, 108) AS EndTime,
        b.MeetingPlatform,
        b.MeetingLink,
        b.Status,
        e.Title,
        e.DurationMinutes,
        e.NotificationEmail
      FROM dbo.Bookings b
      INNER JOIN dbo.ConsultationEvents e ON e.EventId = b.EventId
      WHERE b.BookingId = @bookingId
    `);

  return result.recordset[0] || null;
}

async function createPublicBooking({
  eventId,
  availabilityId,
  customerName,
  customerEmail,
  phoneNumber,
  message,
}) {
  const pool = await getPool();

  const request = pool.request();
  request.input("EventId", sql.Int, eventId);
  request.input("AvailabilityId", sql.Int, availabilityId);
  request.input("CustomerName", sql.NVarChar(150), customerName);
  request.input("CustomerEmail", sql.NVarChar(255), customerEmail);
  request.input("PhoneNumber", sql.NVarChar(25), phoneNumber || null);
  request.input("Message", sql.NVarChar(2000), message || null);
  request.output("BookingId", sql.BigInt);
  request.output("BookingStatus", sql.NVarChar(20));

  const spResult = await request.execute("dbo.sp_CreatePublicBooking");
  const bookingId = spResult.output.BookingId;

  return getBookingById(bookingId);
}

async function updateBookingStatus({ bookingId, status }) {
  const pool = await getPool();
  await pool
    .request()
    .input("bookingId", sql.BigInt, bookingId)
    .input("status", sql.NVarChar(20), status)
    .query(`
      UPDATE dbo.Bookings
      SET Status = @status,
          UpdatedDate = SYSUTCDATETIME()
      WHERE BookingId = @bookingId
    `);

  return getBookingById(bookingId);
}

async function rescheduleBooking({ bookingId, newAvailabilityId }) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

  try {
    const lockReq = new sql.Request(tx);
    const lockResult = await lockReq
      .input("bookingId", sql.BigInt, bookingId)
      .query(`
        SELECT BookingId, EventId
        FROM dbo.Bookings WITH (UPDLOCK, HOLDLOCK)
        WHERE BookingId = @bookingId
      `);

    const lockedBooking = lockResult.recordset[0];
    if (!lockedBooking) {
      throw new Error("Booking not found");
    }

    const slotReq = new sql.Request(tx);
    const slotResult = await slotReq
      .input("availabilityId", sql.Int, newAvailabilityId)
      .input("eventId", sql.Int, lockedBooking.EventId)
      .query(`
        SELECT AvailabilityId, AvailableDate, StartTime, EndTime, MeetingPlatform, MeetingLink, Status
        FROM dbo.Availability WITH (UPDLOCK, HOLDLOCK)
        WHERE AvailabilityId = @availabilityId
          AND EventId = @eventId
      `);

    const slot = slotResult.recordset[0];
    if (!slot) {
      throw new Error("Selected slot not found");
    }
    if (slot.Status !== "ENABLED") {
      throw new Error("Selected slot is not enabled");
    }

    const duplicateReq = new sql.Request(tx);
    const duplicateResult = await duplicateReq
      .input("availabilityId", sql.Int, newAvailabilityId)
      .query(`
        SELECT TOP 1 BookingId
        FROM dbo.Bookings WITH (UPDLOCK, HOLDLOCK)
        WHERE AvailabilityId = @availabilityId
          AND Status IN ('PENDING', 'CONFIRMED', 'RESCHEDULED')
      `);

    if (duplicateResult.recordset.length > 0) {
      throw new Error("Selected slot is already booked");
    }

    const updateReq = new sql.Request(tx);
    await updateReq
      .input("bookingId", sql.BigInt, bookingId)
      .input("availabilityId", sql.Int, slot.AvailabilityId)
      .input("bookingDate", sql.Date, slot.AvailableDate)
      .input("startTime", sql.Time, slot.StartTime)
      .input("endTime", sql.Time, slot.EndTime)
      .input("meetingPlatform", sql.NVarChar(30), slot.MeetingPlatform)
      .input("meetingLink", sql.NVarChar(1000), slot.MeetingLink)
      .query(`
        UPDATE dbo.Bookings
        SET AvailabilityId = @availabilityId,
            BookingDate = @bookingDate,
            StartTime = @startTime,
            EndTime = @endTime,
            MeetingPlatform = @meetingPlatform,
            MeetingLink = @meetingLink,
            Status = 'RESCHEDULED',
            UpdatedDate = SYSUTCDATETIME()
        WHERE BookingId = @bookingId
      `);

    await tx.commit();
    return getBookingById(bookingId);
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

module.exports = {
  getBookingById,
  createPublicBooking,
  updateBookingStatus,
  rescheduleBooking,
};
