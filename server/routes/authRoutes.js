const express = require("express");
const { body } = require("express-validator");
const authController = require("../controllers/authController");
const { validateRequest } = require("../middleware/validationMiddleware");
const { requireAuth } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/login", (req, res) => {
  return res.status(405).json({
    success: false,
    message: "Use POST /api/auth/login with JSON body { email, password }",
    errorCode: "METHOD_NOT_ALLOWED",
  });
});

router.post(
  "/login",
  [body("email").isEmail(), body("password").isLength({ min: 8 })],
  validateRequest,
  authController.login
);

router.post("/logout", requireAuth, authController.logout);

router.post(
  "/forgot-password",
  [body("email").isEmail()],
  validateRequest,
  authController.forgotPassword
);

router.post(
  "/reset-password",
  [body("token").isLength({ min: 32 }), body("newPassword").isLength({ min: 8, max: 72 })],
  validateRequest,
  authController.resetPassword
);

router.get("/me", requireAuth, authController.me);

module.exports = router;
