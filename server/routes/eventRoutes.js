const express = require("express");
const { body, param } = require("express-validator");
const eventController = require("../controllers/eventController");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireAdmin } = require("../middleware/adminMiddleware");
const { validateRequest } = require("../middleware/validationMiddleware");

const router = express.Router();

const eventValidators = [
  body("title").trim().isLength({ min: 3, max: 200 }),
  body("description").optional({ nullable: true }).isLength({ max: 2000 }),
  body("durationMinutes").isIn([15, 30, 45, 60, 90, 120]),
  body("bufferBeforeMinutes").optional().isInt({ min: 0, max: 10080 }),
  body("bufferAfterMinutes").optional().isInt({ min: 0, max: 10080 }),
  body("meetingPlatform").isIn(["Google Meet", "Zoom", "Microsoft Teams", "Custom"]),
  body("meetingLink").optional({ nullable: true }).isURL(),
  body("isPaid").isBoolean(),
  body("price").isFloat({ min: 0 }),
  body("currency").optional().isLength({ min: 3, max: 3 }),
  body("requiresApproval").isBoolean(),
  body("notificationEmail").optional({ nullable: true }).isEmail(),
  body("isActive").optional().isBoolean(),
];

router.get("/", requireAuth, requireAdmin, eventController.listEvents);
router.get("/:id", requireAuth, requireAdmin, [param("id").isInt({ min: 1 })], validateRequest, eventController.getEventById);
router.post("/", requireAuth, requireAdmin, eventValidators, validateRequest, eventController.createEvent);
router.put("/:id", requireAuth, requireAdmin, [param("id").isInt({ min: 1 }), ...eventValidators], validateRequest, eventController.updateEvent);
router.delete("/:id", requireAuth, requireAdmin, [param("id").isInt({ min: 1 })], validateRequest, eventController.deleteEvent);

module.exports = router;
