# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A consultation and appointment booking system: an Express/Node.js REST API backed by SQL Server, serving a vanilla HTML/CSS/JS client (no build step, no frontend framework). There is no git repository initialized in this working directory.

## Commands

```bash
npm install          # install dependencies
npm start             # start the server (node server/server.js), serves API + static client on PORT (default 3000)
npm run dev            # same as start — no watch/reload configured
npm run create-admin    # bootstrap an admin user from ADMIN_BOOTSTRAP_* env vars (server/utils/createAdmin.js)
```

There is no test suite (`npm test` just prints a placeholder message) and no lint script configured.

Health check: `curl http://localhost:3000/api/health` — returns healthy even if the DB is unreachable (degraded mode), so a 200 here doesn't guarantee DB connectivity.

On Windows, `run_app.ps1` will copy `.env` from `server/.env.example` if missing, try to start a local SQL Server service (SQLEXPRESS or default instance), `npm install` if `node_modules` is absent, then `npm start`.

### Database setup

Schema, triggers, indexes, and the `sp_CreatePublicBooking` stored procedure all live in [server/sql/database.sql](server/sql/database.sql) — run it in SSMS/sqlcmd against the target server to (re)create everything idempotently (it drops and recreates tables/procs each run). `server/sql/seed_test_data.sql` seeds sample data. There is no migration tool — schema changes are made by editing this file directly.

### Environment config

Configure via `.env` at the repo root or `server/.env` (dotenv loads from cwd). Two DB driver modes, both handled in [server/config/db.js](server/config/db.js):
- `DB_DRIVER=tedious` (default) — standard SQL auth via `DB_SERVER`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD`, `DB_PORT`.
- `DB_DRIVER=msnodesqlv8` — Windows Integrated Auth via a full `DB_CONNECTION_STRING`.

See `.env.example` for the full variable list (session secret, SMTP, WhatsApp Cloud API, admin bootstrap credentials, reset-password URL).

## Architecture

### Layering

Standard layered Express structure under `server/`:
- `routes/*.js` — wire up `express-validator` chains + `validateRequest` + auth middleware + controller handler, per resource (`authRoutes`, `eventRoutes`, `availabilityRoutes`, `bookingRoutes`, `publicRoutes`).
- `controllers/*.js` — HTTP-facing logic, wrapped in `asyncHandler` (forwards rejected promises to Express error middleware). Controllers call services for anything transactional/reusable, but simple single-query reads (e.g. `listBookings`) query the pool directly.
- `services/*.js` — DB transactions and business rules shared across controllers (e.g. `bookingService.js` holds the double-booking-safe reschedule transaction), plus outbound integrations (`emailService.js`, `whatsappService.js`, `twilioWhatsappService.js`).
- `middleware/` — `authMiddleware` (`requireAuth`, checks `req.session.admin`), `adminMiddleware` (`requireAdmin`, checks `role === "ADMIN"`), `validationMiddleware` (`validateRequest`, runs after express-validator chains), `errorMiddleware` (`notFoundHandler`, `errorHandler`).
- `config/` — `db.js` (connection pool singleton, driver selection), `email.js` (nodemailer transporter, returns `null` if SMTP env vars are incomplete), `logger.js` (winston, JSON to `server/logs/{error,combined}.log`, plus console in non-production).
- `utils/` — `apiResponse.js` (`successResponse`/`errorResponse` — see response envelope below), `asyncHandler.js`, `createAdmin.js` (standalone script, not mounted in the app).

`server/app.js` wires everything (helmet, CORS, JSON body parsing, session, rate limiters on `/api/auth/login` and `/api/auth/forgot-password|reset-password`, route mounting, static client serving, 404 + error handlers last). `server/server.js` is the entrypoint: it attempts a DB connection with a timeout before listening but **starts the HTTP server regardless of DB outcome** (`process.env.DB_AVAILABLE` reflects the result), and wires graceful shutdown on SIGINT/SIGTERM.

### Route mounting

- `/api/auth` → login/logout/forgot-password/reset-password/me (session-based, not JWT)
- `/api/events`, `/api/availability`, `/api/bookings` → admin-only CRUD (`requireAuth` + `requireAdmin`)
- `/api/public` → unauthenticated endpoints for the public booking page: list events, list availability for an event, create a booking
- `/api/admin/dashboard` → inline in `app.js`, aggregate booking metrics
- `/api/health` → unauthenticated, always 200 even when DB is down

### Auth model

Session-based (`express-session`, cookie name `sessionId`), not token-based. `req.session.admin` holds `{ adminId, username, email, role }`. There is a single role (`ADMIN`); `requireAdmin` checks `role === "ADMIN"` but there's currently no non-admin authenticated role. Passwords hashed with bcrypt (cost 12). Password reset uses a random 32-byte token, SHA-256-hashed before storage (`hashResetToken` in `authController.js`), 30-minute expiry.

### Database access pattern

Raw parameterized SQL via `mssql`, no ORM. Always go through `getPool()` from `server/config/db.js` (lazily-initialized singleton `poolPromise`, reused across requests). Pattern in every controller/service:

```js
const pool = await getPool();
await pool.request().input("name", sql.Type, value).query("...");
```

Multi-step operations that must be atomic (reschedule, password reset) use `new sql.Transaction(pool)` with explicit `begin()`/`commit()`/`rollback()`, and take row locks with `WITH (UPDLOCK, HOLDLOCK)` to prevent race conditions (e.g. double-booking the same slot). Public booking creation goes through the `dbo.sp_CreatePublicBooking` stored procedure rather than inline app-layer SQL, since it needs the same locking guarantees on the hot path — see `createPublicBooking` in `server/services/bookingService.js` and the procedure definition in `database.sql`. When adding new multi-step DB writes, follow this same lock-then-check-then-write transaction shape rather than relying on application-level checks alone.

Errors thrown from `THROW` in the stored proc (or from service-layer validation) are matched by message substring in controller-level `mapBookingError()` functions (e.g. `bookingController.js`) to map to the right HTTP status/errorCode — when changing an error message thrown by the DB or service layer, check for `mapBookingError`-style substring matches that depend on the old wording.

### Response envelope

All API responses go through `successResponse(res, message, data, statusCode)` / `errorResponse(res, message, errorCode, statusCode)` in `server/utils/apiResponse.js`, producing `{ success, message, data }` or `{ success, message, errorCode }`. Keep new endpoints consistent with this shape.

### Timezone handling

The app targets IST (UTC+5:30) but the DB stores UTC. SQL queries add IST offset manually rather than relying on server timezone config, e.g. `DATEADD(MINUTE, 330, SYSUTCDATETIME())` — see `app.js` dashboard query and `sp_CreatePublicBooking`'s minimum-notice check. On the Node side, date/time strings (`"YYYY-MM-DD"`, `"HH:MM:SS"`) are formatted manually rather than parsed through `Date` where day-boundary correctness matters (see the comments in `emailService.js` around `formatDateLong`/`toGoogleCalendarStamp`) — follow the same approach (string-split formatting, not `new Date(dateStr)`) when touching date/time display logic, since naive `Date` parsing has caused off-by-one-day bugs here before.

### Booking domain rules (enforced primarily in the DB layer)

- A slot (`dbo.Availability`) can have at most one active booking at a time — enforced by a filtered unique index (`UX_Bookings_Active_Availability`) and re-checked with row locks in `sp_CreatePublicBooking` / `rescheduleBooking`.
- Availability slots for the same event/date must not overlap — enforced by the `trg_Availability_NoOverlap` trigger.
- Booking status lifecycle: `PENDING → CONFIRMED/REJECTED`, plus `CANCELLED` and `RESCHEDULED`, defined as a CHECK constraint (`CK_Bookings_Status`) and mirrored in `express-validator` `isIn([...])` checks in routes — when adding a status, update both places.
- Whether a new booking lands as `PENDING` or `CONFIRMED` depends on the event's `RequiresApproval` flag (decided inside `sp_CreatePublicBooking`).
- A global `MinimumNoticeHours` setting (`dbo.BookingSettings`, single row) gates how soon a slot can be booked.

### Notifications

Email (`services/emailService.js`, via nodemailer + SMTP) is the primary notification channel and fires on every booking create/status change (`sendBookingNotifications`), sending to both the customer and an admin target (`ConsultationEvents.NotificationEmail` or `ADMIN_NOTIFICATION_EMAIL` fallback). Delivery is deliberately best-effort: failures are logged, not thrown, so a notification failure never turns an already-persisted booking into an API error. WhatsApp (`whatsappService.js` for Cloud API, `twilioWhatsappService.js` for Twilio) is scaffolded but not wired into the booking flow — see the comment in `whatsappService.js` about needing pre-approved message templates.

### Client

Plain multi-page HTML/CSS/JS under `client/`, served as static files by Express — no bundler, no framework. Each admin page (`admin-*.html`) has a matching script in `client/js/` (`admin.js`, `availability.js`, `bookings.js`, `events.js`) that calls the `/api/*` endpoints directly via `fetch`. `client/js/format-utils.js` holds shared formatting/UI helpers (e.g. `formatTime12h`, `showAlert`) used across pages. The public booking flow is `index.html` → `booking.html`, driven by `client/js/booking.js` against `/api/public/*`.
