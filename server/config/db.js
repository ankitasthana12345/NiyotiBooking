const sql = (process.env.DB_DRIVER || "tedious") === "msnodesqlv8" ? require("mssql/msnodesqlv8") : require("mssql");
const logger = require("./logger");

let poolPromise;

function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === "true";
}

function getDbConfig() {
  const driver = process.env.DB_DRIVER || "tedious";
  const connectionTimeout = Number(process.env.DB_TIMEOUT_MS || 8000);

  if (driver === "msnodesqlv8") {
    return {
      driver: "msnodesqlv8",
      connectionString: process.env.DB_CONNECTION_STRING,
      connectionTimeout,
      options: {
        trustedConnection: true,
        encrypt: parseBool(process.env.DB_ENCRYPT, true),
        trustServerCertificate: parseBool(process.env.DB_TRUST_SERVER_CERTIFICATE, true),
      },
    };
  }

  return {
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT || 1433),
    connectionTimeout,
    requestTimeout: connectionTimeout,
    options: {
      encrypt: parseBool(process.env.DB_ENCRYPT, true),
      trustServerCertificate: parseBool(process.env.DB_TRUST_SERVER_CERTIFICATE, true),
      enableArithAbort: true,
    },
    pool: {
      max: 20,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };
}

async function getPool() {
  if (!poolPromise) {
    const config = getDbConfig();
    const timeoutMs = Number(process.env.DB_TIMEOUT_MS || 8000);

    if (config.driver === "msnodesqlv8" && !config.connectionString) {
      throw new Error("Database configuration is incomplete. Check environment variables.");
    }

    if (config.driver !== "msnodesqlv8") {
      const required = ["DB_SERVER", "DB_DATABASE", "DB_USER", "DB_PASSWORD"];
      const missing = required.filter((key) => !process.env[key]);
      if (missing.length > 0) {
        throw new Error(`Missing required DB environment variables: ${missing.join(", ")}`);
      }
    }

    let timeoutHandle;
    const connectionAttempt = new Promise((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Database connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const connectPromise = new sql.ConnectionPool(config).connect();
      connectPromise.then(resolve).catch(reject);
    });

    poolPromise = connectionAttempt
      .then((pool) => {
        clearTimeout(timeoutHandle);
        logger.info("Database connection established");
        return pool;
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
    await pool.close();
    poolPromise = undefined;
  }
}

module.exports = {
  sql,
  getPool,
  closePool,
};
