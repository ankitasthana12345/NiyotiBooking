const mysql = require("mysql2/promise");
const logger = require("./logger");

// FK-violation error codes from MySQL, normalized to Postgres' single
// "foreign_key_violation" SQLSTATE (23503) so existing `error.code === "23503"`
// checks (see availabilityController.js::deleteAvailability) keep working
// unchanged. MySQL splits this into two codes depending on direction:
// ER_NO_REFERENCED_ROW_2 (child insert/update references a missing parent) and
// ER_ROW_IS_REFERENCED_2 (parent delete/update blocked by an existing child).
const FK_VIOLATION_CODES = new Set([
  "ER_NO_REFERENCED_ROW_2",
  "ER_NO_REFERENCED_ROW",
  "ER_ROW_IS_REFERENCED_2",
  "ER_ROW_IS_REFERENCED",
]);

// Translates a Postgres-style query (`$1, $2, ...` placeholders, an optional
// trailing `RETURNING "Column"`, and literal BEGIN/COMMIT/ROLLBACK strings)
// into the MySQL equivalent, so callers written against the old `pg` pool
// don't need to be rewritten. Positional parameters are re-expanded in
// occurrence order, so a `$1` referenced more than once (e.g. the same LIKE
// value reused across several columns) is duplicated correctly for `?`.
function translateQuery(text, params) {
  const trimmedUpper = text.trim().toUpperCase();
  if (trimmedUpper === "BEGIN" || trimmedUpper === "COMMIT" || trimmedUpper === "ROLLBACK") {
    return { txControl: trimmedUpper };
  }

  let returningColumn = null;
  const withoutReturning = text.replace(
    /\s+RETURNING\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*;?\s*$/i,
    (match, col) => {
      returningColumn = col;
      return "";
    }
  );

  const values = [];
  const sql = withoutReturning.replace(/\$(\d+)/g, (match, num) => {
    values.push(params ? params[Number(num) - 1] : undefined);
    return "?";
  });

  return { sql, values, returningColumn };
}

async function execute(connection, text, params) {
  const translated = translateQuery(text, params);

  if (translated.txControl === "BEGIN") {
    await connection.beginTransaction();
    return { rows: [], rowCount: 0 };
  }
  if (translated.txControl === "COMMIT") {
    await connection.commit();
    return { rows: [], rowCount: 0 };
  }
  if (translated.txControl === "ROLLBACK") {
    await connection.rollback();
    return { rows: [], rowCount: 0 };
  }

  try {
    const [result] = await connection.query(translated.sql, translated.values);
    if (Array.isArray(result)) {
      return { rows: result, rowCount: result.length };
    }
    return {
      rows: translated.returningColumn ? [{ [translated.returningColumn]: result.insertId }] : [],
      rowCount: result.affectedRows,
    };
  } catch (err) {
    if (FK_VIOLATION_CODES.has(err.code)) {
      err.code = "23503";
    }
    throw err;
  }
}

class PgCompatClient {
  constructor(connection) {
    this._connection = connection;
  }

  query(text, params) {
    return execute(this._connection, text, params);
  }

  release() {
    this._connection.release();
  }
}

class PgCompatPool {
  constructor(pool) {
    this._pool = pool;
  }

  query(text, params) {
    return execute(this._pool, text, params);
  }

  async connect() {
    const connection = await this._pool.getConnection();
    return new PgCompatClient(connection);
  }

  async end() {
    await this._pool.end();
  }
}

let poolPromise;

function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === "true";
}

function getDbConfig() {
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_DATABASE,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectTimeout: Number(process.env.DB_TIMEOUT_MS || 8000),
    ssl: parseBool(process.env.DB_SSL, false) ? { rejectUnauthorized: false } : undefined,
    connectionLimit: 20,
    idleTimeout: 30000,
    // Keep DATE columns as raw "YYYY-MM-DD" strings (mysql2 otherwise parses them
    // into JS Date objects), matching the previous pg type-parser override — see
    // the comments in emailService.js around formatDateLong/toGoogleCalendarStamp
    // for why naive Date parsing breaks day-boundary formatting.
    dateStrings: ["DATE"],
    // DECIMAL (Price) defaults to a string for precision safety; callers expect a number.
    decimalNumbers: true,
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

    const rawPool = mysql.createPool(config);
    rawPool.on("error", (err) => {
      logger.error("Unexpected database pool error", { message: err.message });
    });

    // Every query in the app is written with Postgres-style double-quoted
    // identifiers ("ColumnName") and assumes storage in UTC regardless of the
    // MySQL server's configured timezone. ANSI_QUOTES makes double quotes work
    // as identifier quoting (MySQL's default sql_mode treats them as string
    // literals), and pinning the session to UTC keeps DEFAULT CURRENT_TIMESTAMP
    // columns consistent with the app's explicit UTC_TIMESTAMP() usage.
    rawPool.on("connection", (connection) => {
      connection.query("SET time_zone = '+00:00'", (err) => {
        if (err) logger.error("Failed to set session time_zone to UTC", { message: err.message });
      });
      connection.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES')", (err) => {
        if (err) logger.error("Failed to enable ANSI_QUOTES sql_mode", { message: err.message });
      });
    });

    let timeoutHandle;
    const connectionAttempt = new Promise((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Database connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      rawPool
        .query("SELECT 1")
        .then(() => resolve(rawPool))
        .catch(reject);
    });

    poolPromise = connectionAttempt
      .then((connectedPool) => {
        clearTimeout(timeoutHandle);
        logger.info("Database connection established");
        return new PgCompatPool(connectedPool);
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
