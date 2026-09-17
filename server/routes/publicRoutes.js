const express = require("express");
const { body, param } = require("express-validator");
const eventController = require("../controllers/eventController");
const availabilityController = require("../controllers/availabilityController");
const bookingController = require("../controllers/bookingController");
const { validateRequest } = require("../middleware/validationMiddleware");

const router = express.Router();

router.get("/events", eventController.listPublicEvents);
router.get("/availability/:eventId", [param("eventId").isInt({ min: 1 })], validateRequest, availabilityController.listPublicAvailability);
router.post(
  "/bookings",
  [
    body("eventId").isInt({ min: 1 }),
    body("availabilityId").isInt({ min: 1 }),
    body("customerName").trim().isLength({ min: 2, max: 150 }),
    body("customerEmail").isEmail(),
    body("phoneNumber").trim().isLength({ min: 1, max: 25 }),
    body("message").trim().isLength({ min: 1, max: 2000 }),
  ],
  validateRequest,
  bookingController.createBookingByPublic
);

module.exports = router;
