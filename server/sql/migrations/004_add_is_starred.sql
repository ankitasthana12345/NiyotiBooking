-- Adds "star" flagging for bookings (admin can mark important bookings, Gmail-style).
--
-- Run ONCE on an already-deployed database. Do NOT re-run database.sql on production
-- (it drops every table). Existing bookings default to not starred. Running it twice
-- fails with "Duplicate column name" - harmless.

ALTER TABLE `Bookings`
	ADD COLUMN `IsStarred` BOOLEAN NOT NULL DEFAULT FALSE AFTER `Status`;
