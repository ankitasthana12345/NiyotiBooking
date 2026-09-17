const { getPool } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { successResponse, errorResponse } = require("../utils/apiResponse");
const {
  createPublicBooking,
  getBookingById,
  updateBookingStatus,
  rescheduleBooking,
} = require("../services/bookingService");
const { sendBookingNotifications } = require("../services/emailService");

function mapBookingError(res, error) {
  const message = error.message || "Booking failed";

  if (message.includes("already been booked") || message.includes("already booked")) {
    return errorResponse(res, "Selected slot is already booked", "SLOT_ALREADY_BOOKED", 409);
  }

  if (message.includes("not available") || message.includes("not enabled")) {
    return errorResponse(res, "Selected slot is unavailable", "SLOT_UNAVAILABLE", 400);
  }

  if (message.includes("in the past") || message.includes("minimum booking notice")) {
    return errorResponse(res, "This slot no longer meets the minimum booking notice", "MINIMUM_NOTICE_NOT_MET", 400);
  }

  if (message.includes("was not found") || message.includes("not found")) {
    return errorResponse(res, "Selected slot was not found", "SLOT_NOT_FOUND", 404);
  }

  if (message.includes("disabled")) {
    return errorResponse(res, "This event is currently disabled", "EVENT_DISABLED", 400);
  }

  throw error;
}

const listBookings = asyncHandler(async (req, res) => {
  const pool = await getPool();
  const { status, email, eventId, fromDate, toDate, q } = req.query;

  let query = `
    SELECT
      b."BookingId",
      b."BookingReference",
      b."EventId",
      e."Title",
      b."AvailabilityId",
      b."CustomerName",
      b."CustomerEmail",
      b."PhoneNumber",
      b."Message",
      b."BookingDate",
      b."StartTime",
      b."EndTime",
      b."MeetingPlatform",
      b."MeetingLink",
      b."Status",
      b."CreatedDate"
    FROM "Bookings" b
    INNER JOIN "ConsultationEvents" e ON e."EventId" = b."EventId"
    WHERE 1=1
  `;

  const params = [];

  if (status) {
    params.push(status);
    query += ` AND b."Status" = $${params.length} `;
  }

  if (email) {
    params.push(email);
    query += ` AND b."CustomerEmail" = $${params.length} `;
  }

  if (eventId) {
    params.push(Number(eventId));
    query += ` AND b."EventId" = $${params.length} `;
  }

  if (fromDate) {
    params.push(fromDate);
    query += ` AND b."BookingDate" >= $${params.length} `;
  }

  if (toDate) {
    params.push(toDate);
    query += ` AND b."BookingDate" <= $${params.length} `;
  }

  if (q) {
    params.push(`%${q}%`);
    query += ` AND (b."CustomerName" LIKE $${params.length} OR b."CustomerEmail" LIKE $${params.length} OR b."PhoneNumber" LIKE $${params.length}) `;
  }

  query += ' ORDER BY b."BookingDate" DESC, b."StartTime" DESC ';

  const result = await pool.query(query, params);
  return successResponse(res, "Bookings fetched", { bookings: result.rows });
});

const getBooking = asyncHandler(async (req, res) => {
  const bookingId = Number(req.params.id);
  const booking = await getBookingById(bookingId);

  if (!booking) {
    return errorResponse(res, "Booking not found", "BOOKING_NOT_FOUND", 404);
  }

  return successResponse(res, "Booking fetched", { booking });
});

const createBookingByAdmin = asyncHandler(async (req, res) => {
  const { eventId, availabilityId, customerName, customerEmail, phoneNumber, message } = req.body;
  let booking;
  try {
    booking = await createPublicBooking({
      eventId: Number(eventId),
      availabilityId: Number(availabilityId),
      customerName,
      customerEmail,
      phoneNumber,
      message,
    });
  } catch (error) {
    return mapBookingError(res, error);
  }

  await sendBookingNotifications({
    booking,
    adminSubject: "New Appointment Booking",
    customerSubject: "Your appointment has been booked",
  });

  return successResponse(res, "Booking created", { booking }, 201);
});

const createBookingByPublic = asyncHandler(async (req, res) => {
  const { eventId, availabilityId, customerName, customerEmail, phoneNumber, message } = req.body;
  let booking;
  try {
    booking = await createPublicBooking({
      eventId: Number(eventId),
      availabilityId: Number(availabilityId),
      customerName,
      customerEmail,
      phoneNumber,
      message,
    });
  } catch (error) {
    return mapBookingError(res, error);
  }

  await sendBookingNotifications({
    booking,
    adminSubject: "New Appointment Booking",
    customerSubject:
      booking.Status === "PENDING"
        ? "Booking request received"
        : "Your appointment has been confirmed",
  });

  return successResponse(
    res,
    "Your appointment has been booked successfully.",
    {
      booking,
    },
    201
  );
});

const updateBooking = asyncHandler(async (req, res) => {
  const bookingId = Number(req.params.id);
  const { status } = req.body;

  const allowedStatuses = ["PENDING", "CONFIRMED", "REJECTED", "CANCELLED", "RESCHEDULED"];
  if (!allowedStatuses.includes(status)) {
    return errorResponse(res, "Invalid booking status", "INVALID_STATUS", 400);
  }

  const booking = await updateBookingStatus({ bookingId, status });
  if (!booking) {
    return errorResponse(res, "Booking not found", "BOOKING_NOT_FOUND", 404);
  }

  await sendBookingNotifications({
    booking,
    adminSubject: `Booking status changed to ${status}`,
    customerSubject: `Your booking status is now ${status}`,
  });

  return successResponse(res, "Booking updated", { booking });
});

const deleteBooking = asyncHandler(async (req, res) => {
  const bookingId = Number(req.params.id);
  const pool = await getPool();

  const result = await pool.query('DELETE FROM "Bookings" WHERE "BookingId" = $1', [bookingId]);

  if (result.rowCount === 0) {
    return errorResponse(res, "Booking not found", "BOOKING_NOT_FOUND", 404);
  }

  return successResponse(res, "Booking deleted successfully");
});

const approveBooking = asyncHandler(async (req, res) => {
  const bookingId = Number(req.params.id);
  const booking = await updateBookingStatus({ bookingId, status: "CONFIRMED" });

  if (!booking) {
    return errorResponse(res, "Booking not found", "BOOKING_NOT_FOUND", 404);
  }

  await sendBookingNotifications({
    booking,
    adminSubject: "Booking approved",
    customerSubject: "Your appointment has been approved",
  });

  return successResponse(res, "Booking approved", { booking });
});

const rejectBooking = asyncHandler(async (req, res) => {
  const bookingId = Number(req.params.id);
  const booking = await updateBookingStatus({ bookingId, status: "REJECTED" });

  if (!booking) {
    return errorResponse(res, "Booking not found", "BOOKING_NOT_FOUND", 404);
  }

  await sendBookingNotifications({
    booking,
    adminSubject: "Booking rejected",
    customerSubject: "Your appointment request was rejected",
  });

  return successResponse(res, "Booking rejected", { booking });
});

const cancelBooking = asyncHandler(async (req, res) => {
  const bookingId = Number(req.params.id);
  const booking = await updateBookingStatus({ bookingId, status: "CANCELLED" });

  if (!booking) {
    return errorResponse(res, "Booking not found", "BOOKING_NOT_FOUND", 404);
  }

  await sendBookingNotifications({
    booking,
    adminSubject: "Booking cancelled",
    customerSubject: "Your appointment has been cancelled",
  });

  return successResponse(res, "Booking cancelled", { booking });
});

const reschedule = asyncHandler(async (req, res) => {
  const bookingId = Number(req.params.id);
  const { newAvailabilityId } = req.body;

  let booking;
  try {
    booking = await rescheduleBooking({ bookingId, newAvailabilityId: Number(newAvailabilityId) });
  } catch (error) {
    return mapBookingError(res, error);
  }

  await sendBookingNotifications({
    booking,
    adminSubject: "Booking rescheduled",
    customerSubject: "Your appointment has been rescheduled",
  });

  return successResponse(res, "Booking rescheduled", { booking });
});

module.exports = {
  listBookings,
  getBooking,
  createBookingByAdmin,
  createBookingByPublic,
  updateBooking,
  deleteBooking,
  approveBooking,
  rejectBooking,
  cancelBooking,
  reschedule,
};
