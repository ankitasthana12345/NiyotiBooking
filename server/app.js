const path = require("path");
const dotenv = require("dotenv");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

dotenv.config();

const authRoutes = require("./routes/authRoutes");
const eventRoutes = require("./routes/eventRoutes");
const availabilityRoutes = require("./routes/availabilityRoutes");
const bookingRoutes = require("./routes/bookingRoutes");
const publicRoutes = require("./routes/publicRoutes");
const { notFoundHandler, errorHandler } = require("./middleware/errorMiddleware");
const { requireAuth } = require("./middleware/authMiddleware");
const { requireAdmin } = require("./middleware/adminMiddleware");
const { getPool } = require("./config/db");
const { successResponse } = require("./utils/apiResponse");

const app = express();

function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === "true";
}

app.disable("x-powered-by");
app.use(helmet());

// CORS_ORIGIN may be a single origin or a comma-separated list (e.g. the
// apex domain and its www subdomain both need to be allowed).
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
  : true;

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts", errorCode: "RATE_LIMITED" },
});

const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many reset requests", errorCode: "RATE_LIMITED" },
});

app.use(
  session({
    name: "sessionId",
    secret: process.env.SESSION_SECRET || "change-me-now",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: parseBool(process.env.SESSION_COOKIE_SECURE, false),
      sameSite: "lax",
      maxAge: Number(process.env.SESSION_MAX_AGE_MS || 8 * 60 * 60 * 1000),
    },
  })
);

app.get("/api/health", async (req, res, next) => {
  try {
    try {
      await getPool();
      return successResponse(res, "Service is healthy", { database: "connected" });
    } catch (err) {
      // DB not available — return degraded but still healthy for app startup
      return successResponse(res, "Service is healthy (DB unavailable)", { database: "disconnected" });
    }
  } catch (err) {
    return next(err);
  }
});

app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/forgot-password", forgotLimiter);
app.use("/api/auth/reset-password", forgotLimiter);

app.use("/api/auth", authRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/availability", availabilityRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/public", publicRoutes);

app.get("/api/admin/dashboard", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM "Bookings") AS "TotalBookings",
        (SELECT COUNT(*) FROM "Bookings" WHERE "BookingDate" = ((now() AT TIME ZONE 'Asia/Kolkata')::date)) AS "TodaysBookings",
        (SELECT COUNT(*) FROM "Bookings" WHERE "BookingDate" >= ((now() AT TIME ZONE 'Asia/Kolkata')::date) AND "Status" IN ('PENDING','CONFIRMED','RESCHEDULED')) AS "UpcomingBookings",
        (SELECT COUNT(*) FROM "Bookings" WHERE "Status" = 'CANCELLED') AS "CancelledBookings",
        (SELECT COUNT(*) FROM "Bookings" WHERE "Status" = 'REJECTED') AS "RejectedBookings",
        (SELECT COUNT(*) FROM "Bookings" WHERE "Status" = 'RESCHEDULED') AS "RescheduledBookings"
    `);

    const recentBookings = await pool.query(`
      SELECT
        b."BookingId",
        b."CustomerName",
        b."CustomerEmail",
        b."BookingDate",
        b."StartTime",
        b."Status"
      FROM "Bookings" b
      ORDER BY b."CreatedDate" DESC
      LIMIT 10
    `);

    return successResponse(res, "Dashboard data fetched", {
      metrics: result.rows[0],
      recentBookings: recentBookings.rows,
    });
  } catch (error) {
    return next(error);
  }
});

// Hidden for now: page and API stay intact, but it's no longer reachable by URL.
app.get("/admin-events.html", (req, res) => {
  res.redirect("/admin-dashboard.html");
});

app.use(express.static(path.join(__dirname, "..", "client")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "client", "index.html"));
});

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
