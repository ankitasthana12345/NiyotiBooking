const { getPool } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { successResponse, errorResponse } = require("../utils/apiResponse");

const listEvents = asyncHandler(async (req, res) => {
  const pool = await getPool();
  const result = await pool.query(`
    SELECT
      "EventId",
      "Title",
      "Description",
      "DurationMinutes",
      "BufferBeforeMinutes",
      "BufferAfterMinutes",
      "MeetingPlatform",
      "MeetingLink",
      "IsPaid",
      "Price",
      "Currency",
      "RequiresApproval",
      "NotificationEmail",
      "IsActive",
      "CreatedDate",
      "UpdatedDate"
    FROM "ConsultationEvents"
    ORDER BY "CreatedDate" DESC
  `);

  return successResponse(res, "Events fetched", { events: result.rows });
});

const getEventById = asyncHandler(async (req, res) => {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT
        "EventId",
        "Title",
        "Description",
        "DurationMinutes",
        "BufferBeforeMinutes",
        "BufferAfterMinutes",
        "MeetingPlatform",
        "MeetingLink",
        "IsPaid",
        "Price",
        "Currency",
        "RequiresApproval",
        "NotificationEmail",
        "IsActive",
        "CreatedDate",
        "UpdatedDate"
      FROM "ConsultationEvents"
      WHERE "EventId" = $1`,
    [Number(req.params.id)]
  );

  const event = result.rows[0];
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
  const result = await pool.query(
    `INSERT INTO "ConsultationEvents"
      ("Title", "Description", "DurationMinutes",
       "BufferBeforeMinutes", "BufferAfterMinutes",
       "MeetingPlatform", "MeetingLink",
       "IsPaid", "Price", "Currency",
       "RequiresApproval", "NotificationEmail", "IsActive")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING "EventId"`,
    [
      title,
      description || null,
      durationMinutes,
      bufferBeforeMinutes || 0,
      bufferAfterMinutes || 0,
      meetingPlatform,
      meetingLink || null,
      Boolean(isPaid),
      Number(price || 0),
      (currency || "INR").toUpperCase(),
      Boolean(requiresApproval),
      notificationEmail || null,
      isActive === undefined ? true : Boolean(isActive),
    ]
  );

  return successResponse(
    res,
    "Event created successfully",
    { eventId: result.rows[0].EventId },
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
  const result = await pool.query(
    `UPDATE "ConsultationEvents"
     SET
       "Title" = $1,
       "Description" = $2,
       "DurationMinutes" = $3,
       "BufferBeforeMinutes" = $4,
       "BufferAfterMinutes" = $5,
       "MeetingPlatform" = $6,
       "MeetingLink" = $7,
       "IsPaid" = $8,
       "Price" = $9,
       "Currency" = $10,
       "RequiresApproval" = $11,
       "NotificationEmail" = $12,
       "IsActive" = $13,
       "UpdatedDate" = UTC_TIMESTAMP()
     WHERE "EventId" = $14`,
    [
      title,
      description || null,
      durationMinutes,
      bufferBeforeMinutes || 0,
      bufferAfterMinutes || 0,
      meetingPlatform,
      meetingLink || null,
      Boolean(isPaid),
      Number(price || 0),
      (currency || "INR").toUpperCase(),
      Boolean(requiresApproval),
      notificationEmail || null,
      Boolean(isActive),
      eventId,
    ]
  );

  if (result.rowCount === 0) {
    return errorResponse(res, "Event not found", "EVENT_NOT_FOUND", 404);
  }

  return successResponse(res, "Event updated successfully");
});

const deleteEvent = asyncHandler(async (req, res) => {
  const eventId = Number(req.params.id);
  const pool = await getPool();

  const result = await pool.query('DELETE FROM "ConsultationEvents" WHERE "EventId" = $1', [eventId]);

  if (result.rowCount === 0) {
    return errorResponse(res, "Event not found", "EVENT_NOT_FOUND", 404);
  }

  return successResponse(res, "Event deleted successfully");
});

const listPublicEvents = asyncHandler(async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.query(`
      SELECT
        "EventId",
        "Title",
        "Description",
        "DurationMinutes",
        "BufferBeforeMinutes",
        "BufferAfterMinutes",
        "MeetingPlatform",
        "MeetingLink",
        "IsPaid",
        "Price",
        "Currency",
        "RequiresApproval"
      FROM "ConsultationEvents"
      WHERE "IsActive" = TRUE
      ORDER BY "CreatedDate" DESC
    `);

    return successResponse(res, "Public events fetched", { events: result.rows });
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
