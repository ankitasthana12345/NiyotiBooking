-- Adds the customer's title, gender and profession to Bookings.
--
-- Run this ONCE against an already-deployed database (phpMyAdmin / "Import SQL" / mysql CLI).
-- Do NOT re-run database.sql on production: it drops and recreates every table, which wipes
-- all existing bookings, slots and admin users.
--
-- The columns are NULLable so existing bookings keep working and the OLD app version keeps
-- running fine if the database is migrated before the new code is deployed.
-- Running it twice fails with "Duplicate column name" - that is harmless, nothing is changed.

ALTER TABLE `Bookings`
	ADD COLUMN `Title` VARCHAR(10) NULL AFTER `CustomerName`,
	ADD COLUMN `Gender` VARCHAR(20) NULL AFTER `Title`,
	ADD COLUMN `Profession` VARCHAR(100) NULL AFTER `Gender`;
