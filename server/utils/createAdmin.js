const dotenv = require("dotenv");
const bcrypt = require("bcrypt");
dotenv.config();

const { getPool, closePool } = require("../config/db");

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

  const exists = await pool.query('SELECT "AdminId" FROM "AdminUsers" WHERE "Email" = $1 LIMIT 1', [email]);

  if (exists.rows.length > 0) {
    console.log("Admin already exists for this email.");
    return;
  }

  const hash = await bcrypt.hash(password, 12);

  await pool.query(
    `INSERT INTO "AdminUsers" ("Username", "Email", "PasswordHash", "IsActive")
     VALUES ($1, $2, $3, TRUE)`,
    [username, email, hash]
  );

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
