# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A consultation and appointment booking system: an Express/Node.js REST API backed by PostgreSQL, serving a vanilla HTML/CSS/JS client (no build step, no frontend framework).

## Commands

```bash
npm install          # install dependencies
npm start             # start the server (node server/server.js), serves API + static client on PORT (default 3000)
npm run dev            # same as start — no watch/reload configured
npm run create-admin    # bootstrap an admin user from ADMIN_BOOTSTRAP_* env vars (server/utils/createAdmin.js)
npm run db:schema      # apply server/sql/database.sql (creates the DB if missing, then (re)creates tables/triggers/indexes)
npm run db:seed        # apply server/sql/seed_test_data.sql
```

`npm run test:e2e` runs `server/tests/e2e.test.js` (25 HTTP tests against a throwaway `AppointmentBookingDB_test` MySQL database; the schema is re-applied each run). `npm test` is still a placeholder and there is no lint script.

Health check: `curl http://localhost:3000/api/health` — returns healthy even if the DB is unreachable (degraded mode), so a 200 here doesn't guarantee DB connectivity.

On Windows, `run_app.ps1` will copy `.env` from `server/.env.example` if missing, try to start a local PostgreSQL service, `npm install` if `node_modules` is absent, then `npm start`.

### Database setup

Schema, triggers, and indexes all live in [server/sql/database.sql](server/sql/database.sql) — run `npm run db:schema` (`server/scripts/run_schema.js`) to apply it, which creates the target database first if it doesn't exist and then (re)creates everything idempotently (it drops and recreates tables/triggers each run). This runs through the `pg` driver rather than the `psql` CLI, so it works even in environments where shelling out to `psql` isn't available. `npm run db:seed` (`server/scripts/run_seed.js` + `server/sql/seed_test_data.sql`) seeds sample data. There is no migration tool — schema changes are made by editing `database.sql` directly.

### Environment config

Configure via `.env` at the repo root or `server/.env` (dotenv loads from cwd). DB connection is handled in [server/config/db.js](server/config/db.js) via a single `pg.Pool` built from `DB_HOST`, `DB_PORT` (default `5432`), `DB_DATABASE`, `DB_USER`, `DB_PASSWORD`, and `DB_SSL` (set to `true` for hosted providers that require TLS).

See `.env.example` for the full variable list (session secret, SMTP, WhatsApp Cloud API, admin bootstrap credentials, reset-password URL).

## Architecture

### Layering

Standard layered Express structure under `server/`:
- `routes/*.js` — wire up `express-validator` chains + `validateRequest` + auth middleware + controller handler, per resource (`authRoutes`, `eventRoutes`, `availabilityRoutes`, `bookingRoutes`, `publicRoutes`).
- `controllers/*.js` — HTTP-facing logic, wrapped in `asyncHandler` (forwards rejected promises to Express error middleware). Controllers call services for anything transactional/reusable, but simple single-query reads (e.g. `listBookings`) query the pool directly.
- `services/*.js` — DB transactions and business rules shared across controllers (e.g. `bookingService.js` holds the double-booking-safe reschedule transaction), plus outbound integrations (`emailService.js`, `whatsappService.js`, `twilioWhatsappService.js`).
- `middleware/` — `authMiddleware` (`requireAuth`, checks `req.session.admin`), `adminMiddleware` (`requireAdmin`, checks `role === "ADMIN"`), `validationMiddleware` (`validateRequest`, runs after express-validator chains), `errorMiddleware` (`notFoundHandler`, `errorHandler`).
- `config/` — `db.js` (`pg.Pool` singleton, plus type-parser overrides so DATE/BIGINT/NUMERIC columns come back in the shapes the rest of the app expects), `email.js` (nodemailer transporter, returns `null` if SMTP env vars are incomplete), `logger.js` (winston, JSON to `server/logs/{error,combined}.log`, plus console in non-production).
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

Raw parameterized SQL via `pg` (node-postgres), no ORM. Always go through `getPool()` from `server/config/db.js` (lazily-initialized singleton `poolPromise`, reused across requests). Table and column names are double-quoted, case-preserving PascalCase (`"BookingId"`, `"CustomerEmail"`, ...) to match how the JS layer accesses result rows. Pattern in every controller/service:

```js
const pool = await getPool();
await pool.query('SELECT ... WHERE "Column" = $1', [value]);
```

Multi-step operations that must be atomic (public booking creation, reschedule, password reset) check out a dedicated client (`const client = await pool.connect()`) and run explicit `BEGIN`/`COMMIT`/`ROLLBACK` (with `client.release()` in a `finally`), taking row locks with `SELECT ... FOR UPDATE` to prevent race conditions (e.g. double-booking the same slot) — see `createPublicBooking` and `rescheduleBooking` in `server/services/bookingService.js`. There is no stored procedure for public booking creation (the old SQL Server `sp_CreatePublicBooking` logic now lives inline in `createPublicBooking`) — when adding new multi-step DB writes, follow this same lock-then-check-then-write transaction shape rather than relying on application-level checks alone.

Errors thrown from `createPublicBooking`/`rescheduleBooking` (or other service-layer validation) are matched by message substring in controller-level `mapBookingError()` functions (e.g. `bookingController.js`) to map to the right HTTP status/errorCode — when changing an error message thrown by the service layer, check for `mapBookingError`-style substring matches that depend on the old wording. FK-violation errors are detected via `error.code === "23503"` (Postgres's `foreign_key_violation` SQLSTATE), not by matching driver error text.

### Response envelope

All API responses go through `successResponse(res, message, data, statusCode)` / `errorResponse(res, message, errorCode, statusCode)` in `server/utils/apiResponse.js`, producing `{ success, message, data }` or `{ success, message, errorCode }`. Keep new endpoints consistent with this shape.

### Timezone handling

The app targets IST (UTC+5:30) but the DB stores UTC. SQL queries convert explicitly via `(now() AT TIME ZONE 'Asia/Kolkata')` rather than relying on server timezone config — see `app.js`'s dashboard query, `listPublicAvailability` in `availabilityController.js`, and the minimum-notice check in `bookingService.js::createPublicBooking`. On the Node side, date/time strings (`"YYYY-MM-DD"`, `"HH:MM:SS"`) are formatted manually rather than parsed through `Date` where day-boundary correctness matters (see the comments in `emailService.js` around `formatDateLong`/`toGoogleCalendarStamp`) — follow the same approach (string-split formatting, not `new Date(dateStr)`) when touching date/time display logic, since naive `Date` parsing has caused off-by-one-day bugs here before. This is also why `server/config/db.js` overrides the `pg` type parser for `DATE` columns to return raw strings instead of `Date` objects — letting `pg` parse them would reintroduce that bug.

### Booking domain rules (enforced primarily in the DB layer)

- A slot (`"Availability"`) can have at most one active booking at a time — enforced by a filtered unique index (`UX_Bookings_Active_Availability`) and re-checked with row locks (`SELECT ... FOR UPDATE`) in `createPublicBooking` / `rescheduleBooking`.
- Availability slots for the same event/date must not overlap — enforced by the `trg_Availability_NoOverlap` trigger (a `BEFORE INSERT OR UPDATE` row-level trigger calling `check_availability_no_overlap()`).
- Booking status lifecycle: `PENDING → CONFIRMED/REJECTED`, plus `CANCELLED` and `RESCHEDULED`, defined as a CHECK constraint (`CK_Bookings_Status`) and mirrored in `express-validator` `isIn([...])` checks in routes — when adding a status, update both places.
- Whether a new booking lands as `PENDING` or `CONFIRMED` depends on the event's `RequiresApproval` flag (decided inside `bookingService.js::createPublicBooking`).
- A global `MinimumNoticeHours` setting (`"BookingSettings"`, single row) gates how soon a slot can be booked.

### Notifications

Email (`services/emailService.js`, via nodemailer + SMTP) is the primary notification channel and fires on every booking create/status change (`sendBookingNotifications`), sending to both the customer and an admin target (`ConsultationEvents.NotificationEmail` or `ADMIN_NOTIFICATION_EMAIL` fallback). Delivery is deliberately best-effort: failures are logged, not thrown, so a notification failure never turns an already-persisted booking into an API error. WhatsApp (`whatsappService.js` for Cloud API, `twilioWhatsappService.js` for Twilio) is scaffolded but not wired into the booking flow — see the comment in `whatsappService.js` about needing pre-approved message templates.

### Client

Plain multi-page HTML/CSS/JS under `client/`, served as static files by Express — no bundler, no framework. Each admin page (`admin-*.html`) has a matching script in `client/js/` (`admin.js`, `availability.js`, `bookings.js`, `events.js`) that calls the `/api/*` endpoints directly via `fetch`. `client/js/format-utils.js` holds shared formatting/UI helpers (e.g. `formatTime12h`, `showAlert`) used across pages. The public booking flow is `index.html` → `booking.html`, driven by `client/js/booking.js` against `/api/public/*`.

### Slot generation and booking limits

- `createWeeklyAvailability` accepts a date range of at most 7 days (each weekday then maps to one date); the admin UI shows only the weekdays inside the range, in date order, and on today's date defaults/clamps the start time to the next IST minute.
- Customers can only see/book slots up to 14 days ahead (`listPublicAvailability` and `createPublicBooking`, `BOOKING_WINDOW_DAYS`).
- One person (same email case-insensitively, OR same phone digits) may hold only one upcoming PENDING/CONFIRMED/RESCHEDULED booking; enforced in `createPublicBooking` under MySQL `GET_LOCK` locks to survive concurrent requests. Error code `DUPLICATE_BOOKING` (409).

### Booking form fields (Title / Gender / Profession)

`Bookings` has nullable `Title`, `Gender`, `Profession` columns (added by `server/sql/migrations/001_add_title_gender_profession.sql` for deployed DBs; already in `database.sql`). Allowed Title/Gender values live in `server/config/bookingOptions.js` and must match the `<select>` options in `client/booking.html`. The profession list is static (`client/js/professions.js`); "Other" sends the typed text. In query results the booking's title is aliased `CustomerTitle` because the events join also has a `Title` column. Free-text fields must be HTML-escaped when rendered (`escapeHtml` in `format-utils.js` / `emailService.js`). `npm run test:ui` runs browser automation (Playwright + installed Edge/Chrome) against the test DB.
