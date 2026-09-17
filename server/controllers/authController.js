const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { getPool } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { successResponse, errorResponse } = require("../utils/apiResponse");
const { sendResetPasswordEmail } = require("../services/emailService");

function hashResetToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const pool = await getPool();

  const result = await pool.query(
    `SELECT "AdminId", "Username", "Email", "PasswordHash", "IsActive"
     FROM "AdminUsers"
     WHERE "Email" = $1
     LIMIT 1`,
    [email]
  );

  const admin = result.rows[0];
  if (!admin || !admin.IsActive) {
    return errorResponse(res, "Invalid credentials", "INVALID_CREDENTIALS", 401);
  }

  const isValidPassword = await bcrypt.compare(password, admin.PasswordHash);
  if (!isValidPassword) {
    return errorResponse(res, "Invalid credentials", "INVALID_CREDENTIALS", 401);
  }

  await new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  req.session.admin = {
    adminId: admin.AdminId,
    username: admin.Username,
    email: admin.Email,
    role: "ADMIN",
  };

  return successResponse(res, "Login successful", {
    admin: req.session.admin,
  });
});

const logout = asyncHandler(async (req, res) => {
  await new Promise((resolve, reject) => {
    req.session.destroy((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  res.clearCookie("sessionId");
  return successResponse(res, "Logout successful");
});

const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const pool = await getPool();

  const adminResult = await pool.query(
    `SELECT "AdminId", "Email"
     FROM "AdminUsers"
     WHERE "Email" = $1 AND "IsActive" = TRUE
     LIMIT 1`,
    [email]
  );

  const admin = adminResult.rows[0];
  if (!admin) {
    return successResponse(res, "If the email is registered, a reset link has been sent.");
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const hashedToken = hashResetToken(rawToken);

  const expiryDate = new Date(Date.now() + 1000 * 60 * 30);

  await pool.query(
    `INSERT INTO "PasswordResetTokens" ("AdminId", "ResetToken", "ExpiryDate")
     VALUES ($1, $2, $3)`,
    [admin.AdminId, hashedToken, expiryDate]
  );

  const resetBase = process.env.RESET_PASSWORD_BASE_URL || "http://localhost:3000/reset-password.html";
  const resetLink = `${resetBase}?token=${encodeURIComponent(rawToken)}`;
  await sendResetPasswordEmail({ to: admin.Email, resetLink });

  return successResponse(res, "If the email is registered, a reset link has been sent.");
});

const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  const pool = await getPool();
  const hashedToken = hashResetToken(token);

  const tokenResult = await pool.query(
    `SELECT "TokenId", "AdminId"
     FROM "PasswordResetTokens"
     WHERE "ResetToken" = $1
       AND "Used" = FALSE
       AND "ExpiryDate" > (now() AT TIME ZONE 'UTC')
     ORDER BY "CreatedDate" DESC
     LIMIT 1`,
    [hashedToken]
  );

  const resetRow = tokenResult.rows[0];
  if (!resetRow) {
    return errorResponse(res, "Invalid or expired token", "INVALID_TOKEN", 400);
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE "AdminUsers"
       SET "PasswordHash" = $1,
           "UpdatedDate" = (now() AT TIME ZONE 'UTC')
       WHERE "AdminId" = $2`,
      [passwordHash, resetRow.AdminId]
    );

    await client.query(
      `UPDATE "PasswordResetTokens"
       SET "Used" = TRUE
       WHERE "TokenId" = $1`,
      [resetRow.TokenId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return successResponse(res, "Password reset successful");
});

const me = asyncHandler(async (req, res) => {
  if (!req.session || !req.session.admin) {
    return errorResponse(res, "Authentication required", "UNAUTHORIZED", 401);
  }

  return successResponse(res, "Session active", {
    admin: req.session.admin,
  });
});

module.exports = {
  login,
  logout,
  forgotPassword,
  resetPassword,
  me,
};
