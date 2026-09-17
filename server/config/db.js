const { Pool, types } = require("pg");
const logger = require("./logger");

// Keep DATE columns as raw "YYYY-MM-DD" strings (pg defaults to parsing them into
// JS Date objects, which breaks the manual string-split date formatting in
// emailService.js — see the comments there around formatDateLong).
types.setTypeParser(1082, (value) => value);
// BIGINT columns default to strings to avoid precision loss; this app's IDs are
// well within safe-integer range and callers expect numbers.
types.setTypeParser(20, (value) => parseInt(value, 10));
// NUMERIC (Price) defaults to a string for the same reason; callers expect a number.
types.setTypeParser(1700, (value) => parseFloat(value));

let poolPromise;

function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === "true";
}

function getDbConfig() {
  const connectionTimeout = Number(process.env.DB_TIMEOUT_MS || 8000);

  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_DATABASE,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: connectionTimeout,
    ssl: parseBool(process.env.DB_SSL, false) ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
  };
}

async function getPool() {
  if (!poolPromise) {
    const config = getDbConfig();
    const timeoutMs = Number(process.env.DB_TIMEOUT_MS || 8000);

    const required = ["DB_HOST", "DB_DATABASE", "DB_USER", "DB_PASSWORD"];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(`Missing required DB environment variables: ${missing.join(", ")}`);
    }

    const pool = new Pool(config);
    pool.on("error", (err) => {
      logger.error("Unexpected database pool error", { message: err.message });
    });

    let timeoutHandle;
    const connectionAttempt = new Promise((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Database connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pool
        .query("SELECT 1")
        .then(() => resolve(pool))
        .catch(reject);
    });

    poolPromise = connectionAttempt
      .then((connectedPool) => {
        clearTimeout(timeoutHandle);
        logger.info("Database connection established");
        return connectedPool;
      })
      .catch((err) => {
        clearTimeout(timeoutHandle);
        poolPromise = undefined;
        logger.error("Database connection failed", { message: err.message });
        throw err;
      });
  }

  return poolPromise;
}

async function closePool() {
  if (poolPromise) {
    const pool = await poolPromise;
    await pool.end();
    poolPromise = undefined;
  }
}

module.exports = {
  getPool,
  closePool,
};
