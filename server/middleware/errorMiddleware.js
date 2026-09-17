const logger = require("../config/logger");

function notFoundHandler(req, res) {
  return res.status(404).json({
    success: false,
    message: "Route not found",
    errorCode: "NOT_FOUND",
  });
}

function errorHandler(err, req, res, next) {
  logger.error("Unhandled error", {
    message: err.message,
    stack: process.env.NODE_ENV === "production" ? undefined : err.stack,
    path: req.originalUrl,
    method: req.method,
  });

  if (res.headersSent) {
    return next(err);
  }

  const statusCode = err.statusCode || 500;
  return res.status(statusCode).json({
    success: false,
    message: statusCode === 500 ? "Internal server error" : err.message,
    errorCode: err.errorCode || "INTERNAL_ERROR",
  });
}

module.exports = {
  notFoundHandler,
  errorHandler,
};
