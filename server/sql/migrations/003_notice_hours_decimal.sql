-- Lets the minimum booking notice be fractional (30 minutes = 0.5 hours).
--
-- Run ONCE on an already-deployed database, BEFORE deploying the new code (existing values
-- such as 24 are kept). Do NOT re-run database.sql on production (it drops every table).
-- Without this, saving "30 min" in Booking Settings would be rounded to a whole hour.

ALTER TABLE `BookingSettings`
	MODIFY COLUMN `MinimumNoticeHours` DECIMAL(5,1) NOT NULL DEFAULT 24;
