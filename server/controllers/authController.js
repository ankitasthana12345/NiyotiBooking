const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { getPool, sql } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { successResponse, errorResponse } = require("../utils/apiResponse");
const { sendResetPasswordEmail } = require("../services/emailService");

function hashResetToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const pool = await getPool();

  const result = await pool
    .request()
    .input("email", sql.NVarChar(255), email)
    .query(`
      SELECT TOP 1 AdminId, Username, Email, PasswordHash, IsActive
      FROM dbo.AdminUsers
      WHERE Email = @email
    `);

  const admin = result.recordset[0];
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

  const adminResult = await pool
    .request()
    .input("email", sql.NVarChar(255), email)
    .query(`
      SELECT TOP 1 AdminId, Email
      FROM dbo.AdminUsers
      WHERE Email = @email AND IsActive = 1
    `);

  const admin = adminResult.recordset[0];
  if (!admin) {
    return successResponse(res, "If the email is registered, a reset link has been sent.");
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const hashedToken = hashResetToken(rawToken);

  const expiryDate = new Date(Date.now() + 1000 * 60 * 30);

  await pool
    .request()
    .input("adminId", sql.Int, admin.AdminId)
    .input("token", sql.NVarChar(255), hashedToken)
    .input("expiryDate", sql.DateTime2, expiryDate)
    .query(`
      INSERT INTO dbo.PasswordResetTokens (AdminId, ResetToken, ExpiryDate)
      VALUES (@adminId, @token, @expiryDate)
    `);

  const resetBase = process.env.RESET_PASSWORD_BASE_URL || "http://localhost:3000/reset-password.html";
  const resetLink = `${resetBase}?token=${encodeURIComponent(rawToken)}`;
  await sendResetPasswordEmail({ to: admin.Email, resetLink });

  return successResponse(res, "If the email is registered, a reset link has been sent.");
});

const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  const pool = await getPool();
  const hashedToken = hashResetToken(token);

  const tokenResult = await pool
    .request()
    .input("token", sql.NVarChar(255), hashedToken)
    .query(`
      SELECT TOP 1 TokenId, AdminId
      FROM dbo.PasswordResetTokens
      WHERE ResetToken = @token
        AND Used = 0
        AND ExpiryDate > SYSUTCDATETIME()
      ORDER BY CreatedDate DESC
    `);

  const resetRow = tokenResult.recordset[0];
  if (!resetRow) {
    return errorResponse(res, "Invalid or expired token", "INVALID_TOKEN", 400);
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);

  const tx = new sql.Transaction(await getPool());
  await tx.begin();
  try {
    await new sql.Request(tx)
      .input("adminId", sql.Int, resetRow.AdminId)
      .input("passwordHash", sql.NVarChar(255), passwordHash)
      .query(`
        UPDATE dbo.AdminUsers
        SET PasswordHash = @passwordHash,
            UpdatedDate = SYSUTCDATETIME()
        WHERE AdminId = @adminId
      `);

    await new sql.Request(tx)
      .input("tokenId", sql.BigInt, resetRow.TokenId)
      .query(`
        UPDATE dbo.PasswordResetTokens
        SET Used = 1
        WHERE TokenId = @tokenId
      `);

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
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
