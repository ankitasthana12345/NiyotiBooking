const path = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const app = require("./app");
const logger = require("./config/logger");
const { getPool, closePool } = require("./config/db");

const port = Number(process.env.PORT || 3000);

async function start() {
  try {
    await Promise.race([
      getPool(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Database connection timed out after ${Number(process.env.DB_TIMEOUT_MS || 8000)}ms`)), Number(process.env.DB_TIMEOUT_MS || 8000)))
    ]);
    logger.info("Database connection established on startup");
    process.env.DB_AVAILABLE = "true";
  } catch (err) {
    logger.warn("Database unavailable; continuing startup without DB", { message: err.message });
    console.warn("Database unavailable; continuing startup without DB:", err && err.message ? err.message : err);
    process.env.DB_AVAILABLE = "false";
  }

  const server = app.listen(port, () => {
    logger.info(`Server started on port ${port}`);
    console.log(`Server running on http://localhost:${port}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down server...");
    server.close(async () => {
      try {
        await closePool();
        logger.info("Database pool closed");
      } catch (closeErr) {
        logger.error("Error closing database pool", { message: closeErr.message });
      } finally {
        process.exit(0);
      }
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start();
