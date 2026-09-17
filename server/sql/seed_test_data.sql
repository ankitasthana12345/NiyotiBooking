/*
  Seed test data for end-to-end testing.
  - 3 events (one requires approval)
  - multiple availability slots
  - 5 bookings across slots
  Idempotent: checks for existing records before inserting.
*/

-- Events
INSERT INTO `ConsultationEvents` (`Title`, `Description`, `DurationMinutes`, `MeetingPlatform`, `MeetingLink`, `IsPaid`, `Price`, `Currency`, `RequiresApproval`, `NotificationEmail`)
SELECT 'General Consultation', '30-minute general consultation for quick questions.', 30, 'Google Meet', NULL, FALSE, 0.00, 'USD', FALSE, NULL
WHERE NOT EXISTS (SELECT 1 FROM `ConsultationEvents` WHERE `Title` = 'General Consultation');

INSERT INTO `ConsultationEvents` (`Title`, `Description`, `DurationMinutes`, `MeetingPlatform`, `MeetingLink`, `IsPaid`, `Price`, `Currency`, `RequiresApproval`, `NotificationEmail`)
SELECT 'Premium Strategy Session', 'In-depth 60-minute strategy call (requires approval).', 60, 'Zoom', NULL, TRUE, 99.00, 'USD', TRUE, 'admin@example.com'
WHERE NOT EXISTS (SELECT 1 FROM `ConsultationEvents` WHERE `Title` = 'Premium Strategy Session');

INSERT INTO `ConsultationEvents` (`Title`, `Description`, `DurationMinutes`, `MeetingPlatform`, `MeetingLink`, `IsPaid`, `Price`, `Currency`, `RequiresApproval`, `NotificationEmail`)
SELECT 'Quick Help', '15-minute slot for fast troubleshooting.', 15, 'Google Meet', NULL, FALSE, 0.00, 'USD', FALSE, NULL
WHERE NOT EXISTS (SELECT 1 FROM `ConsultationEvents` WHERE `Title` = 'Quick Help');

-- Availability (future dates)
-- Event 1 (General Consultation): two slots on 2026-09-15
INSERT INTO `Availability` (`EventId`, `AvailableDate`, `StartTime`, `EndTime`, `DurationMinutes`, `Status`)
SELECT e.`EventId`, '2026-09-15', '09:00:00', '09:30:00', 30, 'ENABLED'
FROM `ConsultationEvents` e
WHERE e.`Title` = 'General Consultation'
  AND NOT EXISTS (
    SELECT 1 FROM `Availability` WHERE `EventId` = e.`EventId` AND `AvailableDate` = '2026-09-15' AND `StartTime` = '09:00:00'
  );

INSERT INTO `Availability` (`EventId`, `AvailableDate`, `StartTime`, `EndTime`, `DurationMinutes`, `Status`)
SELECT e.`EventId`, '2026-09-15', '10:00:00', '10:30:00', 30, 'ENABLED'
FROM `ConsultationEvents` e
WHERE e.`Title` = 'General Consultation'
  AND NOT EXISTS (
    SELECT 1 FROM `Availability` WHERE `EventId` = e.`EventId` AND `AvailableDate` = '2026-09-15' AND `StartTime` = '10:00:00'
  );

-- Event 2 (Premium Strategy Session): one slot on 2026-09-16
INSERT INTO `Availability` (`EventId`, `AvailableDate`, `StartTime`, `EndTime`, `DurationMinutes`, `Status`)
SELECT e.`EventId`, '2026-09-16', '14:00:00', '15:00:00', 60, 'ENABLED'
FROM `ConsultationEvents` e
WHERE e.`Title` = 'Premium Strategy Session'
  AND NOT EXISTS (
    SELECT 1 FROM `Availability` WHERE `EventId` = e.`EventId` AND `AvailableDate` = '2026-09-16' AND `StartTime` = '14:00:00'
  );

-- Event 3 (Quick Help): two slots on 2026-09-17
INSERT INTO `Availability` (`EventId`, `AvailableDate`, `StartTime`, `EndTime`, `DurationMinutes`, `Status`)
SELECT e.`EventId`, '2026-09-17', '11:00:00', '11:15:00', 15, 'ENABLED'
FROM `ConsultationEvents` e
WHERE e.`Title` = 'Quick Help'
  AND NOT EXISTS (
    SELECT 1 FROM `Availability` WHERE `EventId` = e.`EventId` AND `AvailableDate` = '2026-09-17' AND `StartTime` = '11:00:00'
  );

INSERT INTO `Availability` (`EventId`, `AvailableDate`, `StartTime`, `EndTime`, `DurationMinutes`, `Status`)
SELECT e.`EventId`, '2026-09-17', '15:00:00', '15:15:00', 15, 'ENABLED'
FROM `ConsultationEvents` e
WHERE e.`Title` = 'Quick Help'
  AND NOT EXISTS (
    SELECT 1 FROM `Availability` WHERE `EventId` = e.`EventId` AND `AvailableDate` = '2026-09-17' AND `StartTime` = '15:00:00'
  );

-- Bookings (5 test bookings)
-- Booking for event 1, slot 1
INSERT INTO `Bookings` (`EventId`, `AvailabilityId`, `CustomerName`, `CustomerEmail`, `PhoneNumber`, `Message`, `BookingDate`, `StartTime`, `EndTime`, `Status`)
SELECT a.`EventId`, a.`AvailabilityId`, 'Alice Tester', 'alice@example.com', '+1111111111', 'E2E test booking 1', '2026-09-15', '09:00:00', '09:30:00', 'CONFIRMED'
FROM `Availability` a
WHERE a.`AvailableDate` = '2026-09-15' AND a.`StartTime` = '09:00:00'
  AND NOT EXISTS (SELECT 1 FROM `Bookings` WHERE `AvailabilityId` = a.`AvailabilityId` AND `CustomerEmail` = 'alice@example.com');

-- Booking for event 1, slot 2
INSERT INTO `Bookings` (`EventId`, `AvailabilityId`, `CustomerName`, `CustomerEmail`, `PhoneNumber`, `Message`, `BookingDate`, `StartTime`, `EndTime`, `Status`)
SELECT a.`EventId`, a.`AvailabilityId`, 'Bob Tester', 'bob@example.com', '+1222222222', 'E2E test booking 2', '2026-09-15', '10:00:00', '10:30:00', 'CONFIRMED'
FROM `Availability` a
WHERE a.`AvailableDate` = '2026-09-15' AND a.`StartTime` = '10:00:00'
  AND NOT EXISTS (SELECT 1 FROM `Bookings` WHERE `AvailabilityId` = a.`AvailabilityId` AND `CustomerEmail` = 'bob@example.com');

-- Booking for event 2 (requires approval) -> should be PENDING
INSERT INTO `Bookings` (`EventId`, `AvailabilityId`, `CustomerName`, `CustomerEmail`, `PhoneNumber`, `Message`, `BookingDate`, `StartTime`, `EndTime`, `Status`)
SELECT a.`EventId`, a.`AvailabilityId`, 'Carol Approver', 'carol@example.com', '+1333333333', 'E2E test booking 3', '2026-09-16', '14:00:00', '15:00:00', 'PENDING'
FROM `Availability` a
WHERE a.`AvailableDate` = '2026-09-16' AND a.`StartTime` = '14:00:00'
  AND NOT EXISTS (SELECT 1 FROM `Bookings` WHERE `AvailabilityId` = a.`AvailabilityId` AND `CustomerEmail` = 'carol@example.com');

-- Booking for event 3, slot 1
INSERT INTO `Bookings` (`EventId`, `AvailabilityId`, `CustomerName`, `CustomerEmail`, `PhoneNumber`, `Message`, `BookingDate`, `StartTime`, `EndTime`, `Status`)
SELECT a.`EventId`, a.`AvailabilityId`, 'Dave Quick', 'dave@example.com', '+1444444444', 'E2E test booking 4', '2026-09-17', '11:00:00', '11:15:00', 'CONFIRMED'
FROM `Availability` a
WHERE a.`AvailableDate` = '2026-09-17' AND a.`StartTime` = '11:00:00'
  AND NOT EXISTS (SELECT 1 FROM `Bookings` WHERE `AvailabilityId` = a.`AvailabilityId` AND `CustomerEmail` = 'dave@example.com');

-- Booking for event 3, slot 2
INSERT INTO `Bookings` (`EventId`, `AvailabilityId`, `CustomerName`, `CustomerEmail`, `PhoneNumber`, `Message`, `BookingDate`, `StartTime`, `EndTime`, `Status`)
SELECT a.`EventId`, a.`AvailabilityId`, 'Eve Quick', 'eve@example.com', '+1555555555', 'E2E test booking 5', '2026-09-17', '15:00:00', '15:15:00', 'CONFIRMED'
FROM `Availability` a
WHERE a.`AvailableDate` = '2026-09-17' AND a.`StartTime` = '15:00:00'
  AND NOT EXISTS (SELECT 1 FROM `Bookings` WHERE `AvailabilityId` = a.`AvailabilityId` AND `CustomerEmail` = 'eve@example.com');
