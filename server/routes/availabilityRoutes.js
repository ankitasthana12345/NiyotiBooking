const express = require("express");
const { body, param, query } = require("express-validator");
const availabilityController = require("../controllers/availabilityController");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/adminMiddleware");
const { validateRequest } = require("../middleware/validationMiddleware");

const router = express.Router();

const availabilityValidators = [
  body("availableDate").isISO8601(),
  body("startTime").matches(/^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/),
  body("endTime").matches(/^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/),
  body("durationMinutes").isIn([15, 30, 45, 60, 90, 120]),
  body("bufferBeforeMinutes").optional().isInt({ min: 0, max: 10080 }),
  body("bufferAfterMinutes").optional().isInt({ min: 0, max: 10080 }),
  body("meetingPlatform").optional().isIn(["Google Meet", "Zoom", "Microsoft Teams", "Custom"]),
  body("meetingLink").optional({ nullable: true }).isURL({ require_protocol: true }).isLength({ max: 1000 }),
  body("status").optional().isIn(["ENABLED", "DISABLED", "BLOCKED"]),
];

router.get("/settings", requireAuth, requireAdmin, availabilityController.getBookingSettings);
router.put("/settings", requireAuth, requireAdmin, [body("minimumNoticeHours").isIn([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24, 36, 48])], validateRequest, availabilityController.updateBookingSettings);
router.get("/", requireAuth, requireAdmin, [query("eventId").optional().isInt({ min: 1 })], validateRequest, availabilityController.listAvailability);
router.get("/weekly", requireAuth, requireAdmin, (req, res) => {
  res.status(405).json({
    success: false,
    message: "Use POST /api/availability/weekly with the weekly availability payload",
    errorCode: "METHOD_NOT_ALLOWED",
  });
});
router.get("/:eventId", requireAuth, requireAdmin, [param("eventId").isInt({ min: 1 })], validateRequest, availabilityController.getAvailabilityByEventId);
router.post("/", requireAuth, requireAdmin, [body("eventId").optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }), ...availabilityValidators], validateRequest, availabilityController.createAvailability);
router.post(
  "/weekly",
  requireAuth,
  requireAdmin,
  [
    // eventId is optional: the server falls back to (or creates) the default event.
    body("eventId").optional({ nullable: true, checkFalsy: true }).toInt().isInt({ min: 1 }),
    body("startDate").isISO8601(),
    body("endDate").isISO8601(),
    body("durationMinutes").toInt().isIn([15, 30, 45, 60, 90, 120]),
    // Empty strings are treated as "not provided"; the controller re-validates
    // platform and link with clear messages.
    body("meetingPlatform").optional({ checkFalsy: true }).isIn(["Google Meet", "Zoom", "Microsoft Teams", "Custom"]),
    body("meetingLink").optional({ checkFalsy: true }).isLength({ max: 1000 }),
    body("status").optional({ checkFalsy: true }).isIn(["ENABLED", "DISABLED", "BLOCKED"]),
    body("weeklySchedule").isArray({ min: 7, max: 7 }),
  ],
  validateRequest,
  availabilityController.createWeeklyAvailability
);
router.post("/disable-all", requireAuth, requireAdmin, availabilityController.disableAllAvailability);
router.put("/:id", requireAuth, requireAdmin, [param("id").isInt({ min: 1 }), ...availabilityValidators], validateRequest, availabilityController.updateAvailability);
router.delete("/:id", requireAuth, requireAdmin, [param("id").isInt({ min: 1 })], validateRequest, availabilityController.deleteAvailability);
router.post("/:id/enable", requireAuth, requireAdmin, [param("id").isInt({ min: 1 })], validateRequest, availabilityController.enableAvailability);
router.post("/:id/disable", requireAuth, requireAdmin, [param("id").isInt({ min: 1 })], validateRequest, availabilityController.disableAvailability);

module.exports = router;
