const express = require("express");
const { body, param, query } = require("express-validator");
const bookingController = require("../controllers/bookingController");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/adminMiddleware");
const { validateRequest } = require("../middleware/validationMiddleware");

const router = express.Router();

const bookingCreateValidators = [
  body("eventId").isInt({ min: 1 }),
  body("availabilityId").isInt({ min: 1 }),
  body("customerName").trim().isLength({ min: 2, max: 150 }),
  body("customerEmail").isEmail(),
  body("phoneNumber").optional({ nullable: true }).isLength({ max: 25 }),
  body("message").optional({ nullable: true }).isLength({ max: 2000 }),
];

router.get(
  "/",
  requireAuth,
  requireAdmin,
  [
    query("status").optional().isIn(["PENDING", "CONFIRMED", "REJECTED", "CANCELLED", "RESCHEDULED"]),
    query("email").optional().isEmail(),
    query("eventId").optional().isInt({ min: 1 }),
    query("fromDate").optional().isISO8601(),
    query("toDate").optional().isISO8601(),
    query("q").optional().isLength({ max: 255 }),
  ],
  validateRequest,
  bookingController.listBookings
);

router.get("/:id", requireAuth, requireAdmin, [param("id").isInt({ min: 1 })], validateRequest, bookingController.getBooking);
router.post("/", requireAuth, requireAdmin, bookingCreateValidators, validateRequest, bookingController.createBookingByAdmin);
router.put("/:id", requireAuth, requireAdmin, [param("id").isInt({ min: 1 }), body("status").isIn(["PENDING", "CONFIRMED", "REJECTED", "CANCELLED", "RESCHEDULED"])], validateRequest, bookingController.updateBooking);
router.delete("/:id", requireAuth, requireAdmin, [param("id").isInt({ min: 1 })], validateRequest, bookingController.deleteBooking);
router.post("/:id/approve", requireAuth, requireAdmin, [param("id").isInt({ min: 1 })], validateRequest, bookingController.approveBooking);
router.post("/:id/reject", requireAuth, requireAdmin, [param("id").isInt({ min: 1 })], validateRequest, bookingController.rejectBooking);
router.post("/:id/cancel", requireAuth, requireAdmin, [param("id").isInt({ min: 1 })], validateRequest, bookingController.cancelBooking);
router.post("/:id/reschedule", requireAuth, requireAdmin, [param("id").isInt({ min: 1 }), body("newAvailabilityId").isInt({ min: 1 })], validateRequest, bookingController.reschedule);

module.exports = router;
