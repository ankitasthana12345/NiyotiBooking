/*
	Appointment Booking System - MySQL Schema
	Converted from the original PostgreSQL schema for GoDaddy hosted MySQL.

	IMPORTANT: This SQL file does NOT recreate the overlap-prevention trigger
	that existed in the Postgres version (check_availability_no_overlap),
	because hosted "Import SQL" tools generally cannot parse MySQL's
	DELIMITER-based trigger syntax reliably. That overlap check must be
	enforced in application code (server/services/*), the same way the
	original stored-procedure logic for booking creation was already
	moved into bookingService.js::createPublicBooking.

	Row auto-update timestamps use MySQL's native
	`DATETIME ... ON UPDATE CURRENT_TIMESTAMP`, so no trigger is needed
	for that part.

	NOTE: CHECK constraints and the DEFAULT (UUID()) expression default
	have been removed from this version. Both are only supported on
	MySQL 8.0.16+ / 8.0.13+ respectively, and the hosted database appears
	to run a version or engine (e.g. MariaDB) that rejects them at
	execution time even though they parse as valid syntax. Enforce these
	rules in application code instead:
	  - Value ranges / allowed-value lists that were CHECK constraints
	  - Generate BookingReference as a UUID in Node (e.g. via the `uuid`
	    package) before inserting into Bookings, rather than relying on
	    a DB-side default
*/

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `PasswordResetTokens`;
DROP TABLE IF EXISTS `Bookings`;
DROP TABLE IF EXISTS `Availability`;
DROP TABLE IF EXISTS `BookingSettings`;
DROP TABLE IF EXISTS `BlockedDates`;
DROP TABLE IF EXISTS `ConsultationEvents`;
DROP TABLE IF EXISTS `AdminUsers`;

CREATE TABLE `AdminUsers`
(
	`AdminId` INT AUTO_INCREMENT PRIMARY KEY,
	`Username` VARCHAR(100) NOT NULL UNIQUE,
	`Email` VARCHAR(255) NOT NULL UNIQUE,
	`PasswordHash` VARCHAR(255) NOT NULL,
	`IsActive` BOOLEAN NOT NULL DEFAULT TRUE,
	`CreatedDate` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`UpdatedDate` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE `ConsultationEvents`
(
	`EventId` INT AUTO_INCREMENT PRIMARY KEY,
	`Title` VARCHAR(200) NOT NULL,
	`Description` VARCHAR(2000) NULL,
	`DurationMinutes` INT NOT NULL DEFAULT 30,
	`BufferBeforeMinutes` INT NOT NULL DEFAULT 0,
	`BufferAfterMinutes` INT NOT NULL DEFAULT 0,
	`MeetingPlatform` VARCHAR(30) NOT NULL DEFAULT 'Google Meet',
	`MeetingLink` VARCHAR(1000) NULL,
	`IsPaid` BOOLEAN NOT NULL DEFAULT FALSE,
	`Price` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
	`Currency` CHAR(3) NOT NULL DEFAULT 'INR',
	`RequiresApproval` BOOLEAN NOT NULL DEFAULT FALSE,
	`NotificationEmail` VARCHAR(255) NULL,
	`IsActive` BOOLEAN NOT NULL DEFAULT TRUE,
	`CreatedDate` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`UpdatedDate` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE `BlockedDates`
(
	`BlockedDateId` INT AUTO_INCREMENT PRIMARY KEY,
	`EventId` INT NOT NULL,
	`BlockedDate` DATE NOT NULL,
	`Reason` VARCHAR(500) NULL,
	`IsActive` BOOLEAN NOT NULL DEFAULT TRUE,
	`CreatedDate` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`UpdatedDate` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `UQ_BlockedDates_Event_Date` UNIQUE (`EventId`, `BlockedDate`),
	CONSTRAINT `FK_BlockedDates_Event` FOREIGN KEY (`EventId`) REFERENCES `ConsultationEvents`(`EventId`)
);

/* Global booking settings (single row). Controls how far in advance a slot must sit
   before the public booking page will offer it. */
CREATE TABLE `BookingSettings`
(
	`SettingId` INT NOT NULL DEFAULT 1 PRIMARY KEY,
	`MinimumNoticeHours` INT NOT NULL DEFAULT 24,
	`UpdatedDate` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO `BookingSettings` (`SettingId`, `MinimumNoticeHours`) VALUES (1, 24);

CREATE TABLE `Availability`
(
	`AvailabilityId` INT AUTO_INCREMENT PRIMARY KEY,
	`EventId` INT NOT NULL,
	`AvailableDate` DATE NOT NULL,
	`StartTime` TIME NOT NULL,
	`EndTime` TIME NOT NULL,
	`DurationMinutes` INT NOT NULL,
	`BufferBeforeMinutes` INT NOT NULL DEFAULT 0,
	`BufferAfterMinutes` INT NOT NULL DEFAULT 0,
	`MeetingPlatform` VARCHAR(30) NOT NULL DEFAULT 'Google Meet',
	`MeetingLink` VARCHAR(1000) NULL,
	`Status` VARCHAR(20) NOT NULL DEFAULT 'ENABLED',
	`CreatedDate` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`UpdatedDate` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `UQ_Availability_Event_Date_Time` UNIQUE (`EventId`, `AvailableDate`, `StartTime`),
	CONSTRAINT `FK_Availability_Event` FOREIGN KEY (`EventId`) REFERENCES `ConsultationEvents`(`EventId`)
);

CREATE TABLE `Bookings`
(
	`BookingId` BIGINT AUTO_INCREMENT PRIMARY KEY,
	`EventId` INT NOT NULL,
	`AvailabilityId` INT NOT NULL,
	`CustomerName` VARCHAR(150) NOT NULL,
	`CustomerEmail` VARCHAR(255) NOT NULL,
	`PhoneNumber` VARCHAR(25) NULL,
	`Message` VARCHAR(2000) NULL,
	`BookingDate` DATE NOT NULL,
	`StartTime` TIME NOT NULL,
	`EndTime` TIME NOT NULL,
	`MeetingPlatform` VARCHAR(30) NOT NULL DEFAULT 'Google Meet',
	`MeetingLink` VARCHAR(1000) NULL,
	`Status` VARCHAR(20) NOT NULL,
	`BookingReference` CHAR(36) NOT NULL,
	`CreatedDate` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`UpdatedDate` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	/* Generated columns that stand in for Postgres' partial unique indexes:
	   they evaluate to NULL for non-active bookings, and MySQL unique
	   indexes allow unlimited NULLs, so only "active" rows are constrained. */
	`ActiveAvailabilitySlot` INT GENERATED ALWAYS AS (
		CASE WHEN `Status` IN ('PENDING', 'CONFIRMED', 'RESCHEDULED') THEN `AvailabilityId` ELSE NULL END
	) VIRTUAL,
	`ActiveEventDateStartSlot` VARCHAR(60) GENERATED ALWAYS AS (
		CASE WHEN `Status` IN ('PENDING', 'CONFIRMED', 'RESCHEDULED')
			THEN CONCAT(`EventId`, '|', `BookingDate`, '|', `StartTime`)
			ELSE NULL END
	) VIRTUAL,
	CONSTRAINT `UQ_BookingReference` UNIQUE (`BookingReference`),
	CONSTRAINT `FK_Bookings_Event` FOREIGN KEY (`EventId`) REFERENCES `ConsultationEvents`(`EventId`),
	CONSTRAINT `FK_Bookings_Availability` FOREIGN KEY (`AvailabilityId`) REFERENCES `Availability`(`AvailabilityId`)
);

CREATE UNIQUE INDEX `UX_Bookings_Active_Availability` ON `Bookings` (`ActiveAvailabilitySlot`);
CREATE UNIQUE INDEX `UX_Bookings_Active_Event_Date_Start` ON `Bookings` (`ActiveEventDateStartSlot`);

CREATE TABLE `PasswordResetTokens`
(
	`TokenId` BIGINT AUTO_INCREMENT PRIMARY KEY,
	`AdminId` INT NOT NULL,
	`ResetToken` VARCHAR(255) NOT NULL UNIQUE,
	`ExpiryDate` DATETIME NOT NULL,
	`Used` BOOLEAN NOT NULL DEFAULT FALSE,
	`CreatedDate` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `FK_PasswordResetTokens_Admin` FOREIGN KEY (`AdminId`) REFERENCES `AdminUsers`(`AdminId`)
);

/* Indexes */
CREATE INDEX `IX_Availability_Event_Date_Status_Start`
	ON `Availability` (`EventId`, `AvailableDate`, `Status`, `StartTime`);

CREATE INDEX `IX_BlockedDates_Event_Date`
	ON `BlockedDates` (`EventId`, `BlockedDate`, `IsActive`);

CREATE INDEX `IX_Bookings_BookingDate_StartTime`
	ON `Bookings` (`BookingDate`, `StartTime`);

CREATE INDEX `IX_Bookings_Status`
	ON `Bookings` (`Status`);

CREATE INDEX `IX_Bookings_CustomerEmail`
	ON `Bookings` (`CustomerEmail`);

CREATE INDEX `IX_Bookings_EventId`
	ON `Bookings` (`EventId`);

CREATE INDEX `IX_Bookings_AvailabilityId`
	ON `Bookings` (`AvailabilityId`);

CREATE INDEX `IX_PasswordResetTokens_Admin_Expiry_Used`
	ON `PasswordResetTokens` (`AdminId`, `ExpiryDate`, `Used`);

/* NOTE: overlap prevention for Availability (no two overlapping slots for the
   same EventId/date) was a BEFORE INSERT/UPDATE trigger in the Postgres
   version. Enforce this in server/services/ (application code) instead,
   the same way public-booking creation logic already lives in
   bookingService.js::createPublicBooking rather than a DB stored procedure. */

/* Seed default admin (idempotent). Password: Niyoti@12345 */
INSERT INTO `AdminUsers` (`Username`, `Email`, `PasswordHash`, `IsActive`)
VALUES ('niyotishrivastava28', 'niyoticoach@gmail.com', '$2b$12$.DeJrnSChXdJiTHqBUJ1D.pXyPGxSRDLOKxcpsGKfnQ6X.0SDbF1C', TRUE)
ON DUPLICATE KEY UPDATE
	`Username` = VALUES(`Username`),
	`PasswordHash` = VALUES(`PasswordHash`),
	`IsActive` = TRUE,
	`UpdatedDate` = CURRENT_TIMESTAMP;

SET FOREIGN_KEY_CHECKS = 1;
