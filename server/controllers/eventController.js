const { getPool, sql } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { successResponse, errorResponse } = require("../utils/apiResponse");

const listEvents = asyncHandler(async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT
      EventId,
      Title,
      Description,
      DurationMinutes,
      BufferBeforeMinutes,
      BufferAfterMinutes,
      MeetingPlatform,
      MeetingLink,
      IsPaid,
      Price,
      Currency,
      RequiresApproval,
      NotificationEmail,
      IsActive,
      CreatedDate,
      UpdatedDate
    FROM dbo.ConsultationEvents
    ORDER BY CreatedDate DESC
  `);

  return successResponse(res, "Events fetched", { events: result.recordset });
});

const getEventById = asyncHandler(async (req, res) => {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("eventId", sql.Int, Number(req.params.id))
    .query(`
      SELECT
        EventId,
        Title,
        Description,
        DurationMinutes,
        BufferBeforeMinutes,
        BufferAfterMinutes,
        MeetingPlatform,
        MeetingLink,
        IsPaid,
        Price,
        Currency,
        RequiresApproval,
        NotificationEmail,
        IsActive,
        CreatedDate,
        UpdatedDate
      FROM dbo.ConsultationEvents
      WHERE EventId = @eventId
    `);

  const event = result.recordset[0];
  if (!event) {
    return errorResponse(res, "Event not found", "EVENT_NOT_FOUND", 404);
  }

  return successResponse(res, "Event fetched", { event });
});

const createEvent = asyncHandler(async (req, res) => {
  const {
    title,
    description,
    durationMinutes,
    bufferBeforeMinutes,
    bufferAfterMinutes,
    meetingPlatform,
    meetingLink,
    isPaid,
    price,
    currency,
    requiresApproval,
    notificationEmail,
    isActive,
  } = req.body;

  const pool = await getPool();
  const result = await pool
    .request()
    .input("title", sql.NVarChar(200), title)
    .input("description", sql.NVarChar(2000), description || null)
    .input("durationMinutes", sql.Int, durationMinutes)
    .input("bufferBeforeMinutes", sql.Int, bufferBeforeMinutes || 0)
    .input("bufferAfterMinutes", sql.Int, bufferAfterMinutes || 0)
    .input("meetingPlatform", sql.NVarChar(30), meetingPlatform)
    .input("meetingLink", sql.NVarChar(1000), meetingLink || null)
    .input("isPaid", sql.Bit, Boolean(isPaid))
    .input("price", sql.Decimal(10, 2), Number(price || 0))
    .input("currency", sql.Char(3), (currency || "INR").toUpperCase())
    .input("requiresApproval", sql.Bit, Boolean(requiresApproval))
    .input("notificationEmail", sql.NVarChar(255), notificationEmail || null)
    .input("isActive", sql.Bit, isActive === undefined ? true : Boolean(isActive))
    .query(`
      DECLARE @InsertedIds TABLE (EventId INT);

      INSERT INTO dbo.ConsultationEvents
      (
        Title, Description, DurationMinutes,
        BufferBeforeMinutes, BufferAfterMinutes,
        MeetingPlatform, MeetingLink,
        IsPaid, Price, Currency,
        RequiresApproval, NotificationEmail, IsActive
      )
      OUTPUT INSERTED.EventId INTO @InsertedIds (EventId)
      VALUES
      (
        @title, @description, @durationMinutes,
        @bufferBeforeMinutes, @bufferAfterMinutes,
        @meetingPlatform, @meetingLink,
        @isPaid, @price, @currency,
        @requiresApproval, @notificationEmail, @isActive
      );

      SELECT TOP 1 EventId FROM @InsertedIds;
    `);

  return successResponse(
    res,
    "Event created successfully",
    { eventId: result.recordset[0].EventId },
    201
  );
});

const updateEvent = asyncHandler(async (req, res) => {
  const eventId = Number(req.params.id);
  const {
    title,
    description,
    durationMinutes,
    bufferBeforeMinutes,
    bufferAfterMinutes,
    meetingPlatform,
    meetingLink,
    isPaid,
    price,
    currency,
    requiresApproval,
    notificationEmail,
    isActive,
  } = req.body;

  const pool = await getPool();
  const result = await pool
    .request()
    .input("eventId", sql.Int, eventId)
    .input("title", sql.NVarChar(200), title)
    .input("description", sql.NVarChar(2000), description || null)
    .input("durationMinutes", sql.Int, durationMinutes)
    .input("bufferBeforeMinutes", sql.Int, bufferBeforeMinutes || 0)
    .input("bufferAfterMinutes", sql.Int, bufferAfterMinutes || 0)
    .input("meetingPlatform", sql.NVarChar(30), meetingPlatform)
    .input("meetingLink", sql.NVarChar(1000), meetingLink || null)
    .input("isPaid", sql.Bit, Boolean(isPaid))
    .input("price", sql.Decimal(10, 2), Number(price || 0))
    .input("currency", sql.Char(3), (currency || "INR").toUpperCase())
    .input("requiresApproval", sql.Bit, Boolean(requiresApproval))
    .input("notificationEmail", sql.NVarChar(255), notificationEmail || null)
    .input("isActive", sql.Bit, Boolean(isActive))
    .query(`
      UPDATE dbo.ConsultationEvents
      SET
        Title = @title,
        Description = @description,
        DurationMinutes = @durationMinutes,
        BufferBeforeMinutes = @bufferBeforeMinutes,
        BufferAfterMinutes = @bufferAfterMinutes,
        MeetingPlatform = @meetingPlatform,
        MeetingLink = @meetingLink,
        IsPaid = @isPaid,
        Price = @price,
        Currency = @currency,
        RequiresApproval = @requiresApproval,
        NotificationEmail = @notificationEmail,
        IsActive = @isActive,
        UpdatedDate = SYSUTCDATETIME()
      WHERE EventId = @eventId
    `);

  if (result.rowsAffected[0] === 0) {
    return errorResponse(res, "Event not found", "EVENT_NOT_FOUND", 404);
  }

  return successResponse(res, "Event updated successfully");
});

const deleteEvent = asyncHandler(async (req, res) => {
  const eventId = Number(req.params.id);
  const pool = await getPool();

  const result = await pool
    .request()
    .input("eventId", sql.Int, eventId)
    .query("DELETE FROM dbo.ConsultationEvents WHERE EventId = @eventId");

  if (result.rowsAffected[0] === 0) {
    return errorResponse(res, "Event not found", "EVENT_NOT_FOUND", 404);
  }

  return successResponse(res, "Event deleted successfully");
});

const listPublicEvents = asyncHandler(async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        EventId,
        Title,
        Description,
        DurationMinutes,
        BufferBeforeMinutes,
        BufferAfterMinutes,
        MeetingPlatform,
        MeetingLink,
        IsPaid,
        Price,
        Currency,
        RequiresApproval
      FROM dbo.ConsultationEvents
      WHERE IsActive = 1
      ORDER BY CreatedDate DESC
    `);

    return successResponse(res, "Public events fetched", { events: result.recordset });
  } catch (err) {
    // If DB is unavailable, return an empty events list so public UI can render
    return successResponse(res, "Public events fetched (db unavailable)", { events: [] });
  }
});

module.exports = {
  listEvents,
  getEventById,
  createEvent,
  updateEvent,
  deleteEvent,
  listPublicEvents,
};
