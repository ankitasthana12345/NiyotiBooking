const dotenv = require("dotenv");
const bcrypt = require("bcrypt");
dotenv.config();

const { getPool, sql, closePool } = require("../config/db");

async function createAdmin() {
  const username = process.env.ADMIN_BOOTSTRAP_USERNAME;
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;

  if (!username || !email || !password) {
    throw new Error(
      "Missing ADMIN_BOOTSTRAP_USERNAME, ADMIN_BOOTSTRAP_EMAIL, or ADMIN_BOOTSTRAP_PASSWORD in environment"
    );
  }

  const pool = await getPool();

  const exists = await pool
    .request()
    .input("email", sql.NVarChar(255), email)
    .query("SELECT TOP 1 AdminId FROM dbo.AdminUsers WHERE Email = @email");

  if (exists.recordset.length > 0) {
    console.log("Admin already exists for this email.");
    return;
  }

  const hash = await bcrypt.hash(password, 12);

  await pool
    .request()
    .input("username", sql.NVarChar(100), username)
    .input("email", sql.NVarChar(255), email)
    .input("hash", sql.NVarChar(255), hash)
    .query(`
      INSERT INTO dbo.AdminUsers (Username, Email, PasswordHash, IsActive)
      VALUES (@username, @email, @hash, 1)
    `);

  console.log("Admin user created successfully.");
}

createAdmin()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
