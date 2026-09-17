/*
	Appointment Booking System - PostgreSQL Schema
	Execute this script via `npm run db:schema` (server/scripts/run_schema.js),
	since it programmatically creates the target database first if missing.
*/

/* Drop programmable objects first for idempotent reruns */
DROP TRIGGER IF EXISTS trg_ConsultationEvents_UpdatedDate ON "ConsultationEvents";
DROP TRIGGER IF EXISTS trg_AdminUsers_UpdatedDate ON "AdminUsers";
DROP TRIGGER IF EXISTS trg_Availability_UpdatedDate ON "Availability";
DROP TRIGGER IF EXISTS trg_Bookings_UpdatedDate ON "Bookings";
DROP TRIGGER IF EXISTS trg_Availability_NoOverlap ON "Availability";
DROP FUNCTION IF EXISTS set_updated_date();
DROP FUNCTION IF EXISTS check_availability_no_overlap();

/* Drop tables in FK dependency order */
DROP TABLE IF EXISTS "PasswordResetTokens";
DROP TABLE IF EXISTS "Bookings";
DROP TABLE IF EXISTS "Availability";
DROP TABLE IF EXISTS "BookingSettings";
DROP TABLE IF EXISTS "BlockedDates";
DROP TABLE IF EXISTS "ConsultationEvents";
DROP TABLE IF EXISTS "AdminUsers";

CREATE TABLE "AdminUsers"
(
	"AdminId" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"Username" VARCHAR(100) NOT NULL UNIQUE,
	"Email" VARCHAR(255) NOT NULL UNIQUE,
	"PasswordHash" VARCHAR(255) NOT NULL,
	"IsActive" BOOLEAN NOT NULL DEFAULT TRUE,
	"CreatedDate" TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
	"UpdatedDate" TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);

CREATE TABLE "ConsultationEvents"
(
	"EventId" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"Title" VARCHAR(200) NOT NULL,
	"Description" VARCHAR(2000) NULL,
	"DurationMinutes" INT NOT NULL DEFAULT 30
		CONSTRAINT "CK_ConsultationEvents_DurationMinutes" CHECK ("DurationMinutes" IN (15, 30, 45, 60, 90, 120)),
	"BufferBeforeMinutes" INT NOT NULL DEFAULT 0
		CONSTRAINT "CK_ConsultationEvents_BufferBeforeMinutes" CHECK ("BufferBeforeMinutes" BETWEEN 0 AND 10080),
	"BufferAfterMinutes" INT NOT NULL DEFAULT 0
		CONSTRAINT "CK_ConsultationEvents_BufferAfterMinutes" CHECK ("BufferAfterMinutes" BETWEEN 0 AND 10080),
	"MeetingPlatform" VARCHAR(30) NOT NULL DEFAULT 'Google Meet'
		CONSTRAINT "CK_ConsultationEvents_MeetingPlatform" CHECK ("MeetingPlatform" IN ('Google Meet', 'Zoom', 'Microsoft Teams', 'Custom')),
	"MeetingLink" VARCHAR(1000) NULL,
	"IsPaid" BOOLEAN NOT NULL DEFAULT FALSE,
	"Price" NUMERIC(10,2) NOT NULL DEFAULT 0.00
		CONSTRAINT "CK_ConsultationEvents_Price" CHECK ("Price" >= 0),
	"Currency" CHAR(3) NOT NULL DEFAULT 'INR'
		CONSTRAINT "CK_ConsultationEvents_Currency" CHECK ("Currency" ~ '^[A-Z]{3}$'),
	"RequiresApproval" BOOLEAN NOT NULL DEFAULT FALSE,
	"NotificationEmail" VARCHAR(255) NULL,
	"IsActive" BOOLEAN NOT NULL DEFAULT TRUE,
	"CreatedDate" TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
	"UpdatedDate" TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
	CONSTRAINT "CK_ConsultationEvents_CustomLink"
		CHECK (("MeetingPlatform" <> 'Custom') OR ("MeetingLink" IS NOT NULL AND LENGTH(TRIM("MeetingLink")) > 0)),
	CONSTRAINT "CK_ConsultationEvents_PaidConfig"
		CHECK (("IsPaid" = FALSE AND "Price" = 0.00) OR ("IsPaid" = TRUE AND "Price" >= 0.00))
);

CREATE TABLE "BlockedDates"
(
	"BlockedDateId" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"EventId" INT NOT NULL REFERENCES "ConsultationEvents"("EventId"),
	"BlockedDate" DATE NOT NULL,
	"Reason" VARCHAR(500) NULL,
	"IsActive" BOOLEAN NOT NULL DEFAULT TRUE,
	"CreatedDate" TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
	"UpdatedDate" TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
	CONSTRAINT "UQ_BlockedDates_Event_Date" UNIQUE ("EventId", "BlockedDate")
);

/* Global booking settings (single row). Controls how far in advance a slot must sit
   before the public booking page will offer it. */
CREATE TABLE "BookingSettings"
(
	"SettingId" INT NOT NULL DEFAULT 1 PRIMARY KEY
		CONSTRAINT "CK_BookingSettings_SettingId" CHECK ("SettingId" = 1),
	"MinimumNoticeHours" INT NOT NULL DEFAULT 24
		CONSTRAINT "CK_BookingSettings_MinimumNoticeHours" CHECK ("MinimumNoticeHours" IN (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24, 36, 48)),
	"UpdatedDate" TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);

INSERT INTO "BookingSettings" ("SettingId", "MinimumNoticeHours") VALUES (1, 24);

CREATE TABLE "Availability"
(
	"AvailabilityId" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"EventId" INT NOT NULL REFERENCES "ConsultationEvents"("EventId"),
	"AvailableDate" DATE NOT NULL,
	"StartTime" TIME(0) NOT NULL,
	"EndTime" TIME(0) NOT NULL,
	"DurationMinutes" INT NOT NULL
		CONSTRAINT "CK_Availability_Duration" CHECK ("DurationMinutes" IN (15, 30, 45, 60, 90, 120)),
	"BufferBeforeMinutes" INT NOT NULL DEFAULT 0
		CONSTRAINT "CK_Availability_BufferBefore" CHECK ("BufferBeforeMinutes" BETWEEN 0 AND 10080),
	"BufferAfterMinutes" INT NOT NULL DEFAULT 0
		CONSTRAINT "CK_Availability_BufferAfter" CHECK ("BufferAfterMinutes" BETWEEN 0 AND 10080),
	"MeetingPlatform" VARCHAR(30) NOT NULL DEFAULT 'Google Meet'
		CONSTRAINT "CK_Availability_MeetingPlatform" CHECK ("MeetingPlatform" IN ('Google Meet', 'Zoom', 'Microsoft Teams', 'Custom')),
	"MeetingLink" VARCHAR(1000) NULL,
	"Status" VARCHAR(20) NOT NULL DEFAULT 'ENABLED'
		CONSTRAINT "CK_Availability_Status" CHECK ("Status" IN ('ENABLED', 'DISABLED', 'BLOCKED')),
	"CreatedDate" TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
	"UpdatedDate" TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
	CONSTRAINT "CK_Availability_TimeRange" CHECK ("StartTime" < "EndTime"),
	CONSTRAINT "UQ_Availability_Event_Date_Time" UNIQUE ("EventId", "AvailableDate", "StartTime")
);

CREATE TABLE "Bookings"
(
	"BookingId" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"EventId" INT NOT NULL REFERENCES "ConsultationEvents"("EventId"),
	"AvailabilityId" INT NOT NULL REFERENCES "Availability"("AvailabilityId"),
	"CustomerName" VARCHAR(150) NOT NULL,
	"CustomerEmail" VARCHAR(255) NOT NULL,
	"PhoneNumber" VARCHAR(25) NULL,
	"Message" VARCHAR(2000) NULL,
	"BookingDate" DATE NOT NULL,
	"StartTime" TIME(0) NOT NULL,
	"EndTime" TIME(0) NOT NULL,
	"MeetingPlatform" VARCHAR(30) NOT NULL DEFAULT 'Google Meet',
	"MeetingLink" VARCHAR(1000) NULL,
	"Status" VARCHAR(20) NOT NULL
		CONSTRAINT "CK_Bookings_Status" CHECK ("Status" IN ('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'RESCHEDULED')),
	"BookingReference" UUID NOT NULL DEFAULT gen_random_uuid(),
	"CreatedDate" TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
	"UpdatedDate" TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
	CONSTRAINT "CK_Bookings_TimeRange" CHECK ("StartTime" < "EndTime")
);

CREATE TABLE "PasswordResetTokens"
(
	"TokenId" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"AdminId" INT NOT NULL REFERENCES "AdminUsers"("AdminId"),
	"ResetToken" VARCHAR(255) NOT NULL UNIQUE,
	"ExpiryDate" TIMESTAMP(0) NOT NULL,
	"Used" BOOLEAN NOT NULL DEFAULT FALSE,
	"CreatedDate" TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);

/* Auto-maintain UpdatedDate on any row update (shared by all 4 tables) */
CREATE FUNCTION set_updated_date() RETURNS TRIGGER AS $$
BEGIN
	NEW."UpdatedDate" := (now() AT TIME ZONE 'UTC');
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_AdminUsers_UpdatedDate
	BEFORE UPDATE ON "AdminUsers"
	FOR EACH ROW EXECUTE FUNCTION set_updated_date();

CREATE TRIGGER trg_ConsultationEvents_UpdatedDate
	BEFORE UPDATE ON "ConsultationEvents"
	FOR EACH ROW EXECUTE FUNCTION set_updated_date();

CREATE TRIGGER trg_Availability_UpdatedDate
	BEFORE UPDATE ON "Availability"
	FOR EACH ROW EXECUTE FUNCTION set_updated_date();

CREATE TRIGGER trg_Bookings_UpdatedDate
	BEFORE UPDATE ON "Bookings"
	FOR EACH ROW EXECUTE FUNCTION set_updated_date();

/* Availability overlap guard */
CREATE FUNCTION check_availability_no_overlap() RETURNS TRIGGER AS $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "Availability" a
		WHERE a."EventId" = NEW."EventId"
		  AND a."AvailableDate" = NEW."AvailableDate"
		  AND a."AvailabilityId" <> NEW."AvailabilityId"
		  AND a."Status" <> 'BLOCKED'
		  AND NEW."Status" <> 'BLOCKED'
		  AND NEW."StartTime" < a."EndTime"
		  AND NEW."EndTime" > a."StartTime"
	) THEN
		RAISE EXCEPTION 'Overlapping availability is not allowed for the same event and date.';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_Availability_NoOverlap
	BEFORE INSERT OR UPDATE ON "Availability"
	FOR EACH ROW EXECUTE FUNCTION check_availability_no_overlap();

/* Indexes */
CREATE INDEX "IX_Availability_Event_Date_Status_Start"
	ON "Availability" ("EventId", "AvailableDate", "Status", "StartTime");

CREATE INDEX "IX_BlockedDates_Event_Date"
	ON "BlockedDates" ("EventId", "BlockedDate", "IsActive");

CREATE INDEX "IX_Bookings_BookingDate_StartTime"
	ON "Bookings" ("BookingDate", "StartTime");

CREATE INDEX "IX_Bookings_Status"
	ON "Bookings" ("Status");

CREATE INDEX "IX_Bookings_CustomerEmail"
	ON "Bookings" ("CustomerEmail");

CREATE INDEX "IX_Bookings_EventId"
	ON "Bookings" ("EventId");

CREATE INDEX "IX_Bookings_AvailabilityId"
	ON "Bookings" ("AvailabilityId");

CREATE UNIQUE INDEX "UX_Bookings_Active_Availability"
	ON "Bookings" ("AvailabilityId")
	WHERE "Status" IN ('PENDING', 'CONFIRMED', 'RESCHEDULED');

CREATE UNIQUE INDEX "UX_Bookings_Active_Event_Date_Start"
	ON "Bookings" ("EventId", "BookingDate", "StartTime")
	WHERE "Status" IN ('PENDING', 'CONFIRMED', 'RESCHEDULED');

CREATE INDEX "IX_PasswordResetTokens_Admin_Expiry_Used"
	ON "PasswordResetTokens" ("AdminId", "ExpiryDate", "Used");

/* NOTE: the SQL Server version of this schema also defined a
   dbo.sp_CreatePublicBooking stored procedure here (lock-then-check-then-insert
   for public booking creation). That logic now lives in
   server/services/bookingService.js::createPublicBooking as a plain JS
   transaction using SELECT ... FOR UPDATE, mirroring rescheduleBooking. */

/* Seed default admin (idempotent). Password: Niyoti@12345 */
INSERT INTO "AdminUsers" ("Username", "Email", "PasswordHash", "IsActive")
VALUES ('niyotishrivastava28', 'niyoticoach@gmail.com', '$2b$12$.DeJrnSChXdJiTHqBUJ1D.pXyPGxSRDLOKxcpsGKfnQ6X.0SDbF1C', TRUE)
ON CONFLICT ("Email") DO UPDATE
SET "Username" = EXCLUDED."Username",
    "PasswordHash" = EXCLUDED."PasswordHash",
    "IsActive" = TRUE,
    "UpdatedDate" = (now() AT TIME ZONE 'UTC');
