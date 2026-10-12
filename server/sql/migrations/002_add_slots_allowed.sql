-- Adds the per-customer session allowance ("Slots", 1-10, default 2) to Bookings.
--
-- Run ONCE on an already-deployed database. Do NOT re-run database.sql on production
-- (it drops every table). Existing bookings get the default of 2. Running it twice fails
-- with "Duplicate column name" - harmless.

ALTER TABLE `Bookings`
	ADD COLUMN `SlotsAllowed` TINYINT NOT NULL DEFAULT 2 AFTER `Profession`;
