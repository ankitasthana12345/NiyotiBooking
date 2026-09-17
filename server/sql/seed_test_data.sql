USE AppointmentBookingDB;
GO

SET XACT_ABORT ON;
GO

/*
  Seed test data for end-to-end testing.
  - 3 events (one requires approval)
  - multiple availability slots
  - 5 bookings across slots
  Idempotent: checks for existing records before inserting.
*/

-- Events
IF NOT EXISTS (SELECT 1 FROM dbo.ConsultationEvents WHERE Title = 'General Consultation')
INSERT INTO dbo.ConsultationEvents (Title, [Description], DurationMinutes, MeetingPlatform, MeetingLink, IsPaid, Price, Currency, RequiresApproval, NotificationEmail)
VALUES ('General Consultation', '30-minute general consultation for quick questions.', 30, 'Google Meet', NULL, 0, 0.00, 'USD', 0, NULL);

IF NOT EXISTS (SELECT 1 FROM dbo.ConsultationEvents WHERE Title = 'Premium Strategy Session')
INSERT INTO dbo.ConsultationEvents (Title, [Description], DurationMinutes, MeetingPlatform, MeetingLink, IsPaid, Price, Currency, RequiresApproval, NotificationEmail)
VALUES ('Premium Strategy Session', 'In-depth 60-minute strategy call (requires approval).', 60, 'Zoom', NULL, 1, 99.00, 'USD', 1, 'admin@example.com');

IF NOT EXISTS (SELECT 1 FROM dbo.ConsultationEvents WHERE Title = 'Quick Help')
INSERT INTO dbo.ConsultationEvents (Title, [Description], DurationMinutes, MeetingPlatform, MeetingLink, IsPaid, Price, Currency, RequiresApproval, NotificationEmail)
VALUES ('Quick Help', '15-minute slot for fast troubleshooting.', 15, 'Google Meet', NULL, 0, 0.00, 'USD', 0, NULL);

-- Fetch EventIds
DECLARE @e1 INT = (SELECT EventId FROM dbo.ConsultationEvents WHERE Title = 'General Consultation');
DECLARE @e2 INT = (SELECT EventId FROM dbo.ConsultationEvents WHERE Title = 'Premium Strategy Session');
DECLARE @e3 INT = (SELECT EventId FROM dbo.ConsultationEvents WHERE Title = 'Quick Help');

-- Availability (future dates)
-- Event 1: two slots on 2026-09-15
IF NOT EXISTS (SELECT 1 FROM dbo.Availability WHERE EventId = @e1 AND AvailableDate = '2026-09-15' AND StartTime = '09:00:00')
INSERT INTO dbo.Availability (EventId, AvailableDate, StartTime, EndTime, DurationMinutes, Status)
VALUES (@e1, '2026-09-15', '09:00:00', '09:30:00', 30, 'ENABLED');

IF NOT EXISTS (SELECT 1 FROM dbo.Availability WHERE EventId = @e1 AND AvailableDate = '2026-09-15' AND StartTime = '10:00:00')
INSERT INTO dbo.Availability (EventId, AvailableDate, StartTime, EndTime, DurationMinutes, Status)
VALUES (@e1, '2026-09-15', '10:00:00', '10:30:00', 30, 'ENABLED');

-- Event 2: one slot on 2026-09-16
IF NOT EXISTS (SELECT 1 FROM dbo.Availability WHERE EventId = @e2 AND AvailableDate = '2026-09-16' AND StartTime = '14:00:00')
INSERT INTO dbo.Availability (EventId, AvailableDate, StartTime, EndTime, DurationMinutes, Status)
VALUES (@e2, '2026-09-16', '14:00:00', '15:00:00', 60, 'ENABLED');

-- Event 3: two slots on 2026-09-17
IF NOT EXISTS (SELECT 1 FROM dbo.Availability WHERE EventId = @e3 AND AvailableDate = '2026-09-17' AND StartTime = '11:00:00')
INSERT INTO dbo.Availability (EventId, AvailableDate, StartTime, EndTime, DurationMinutes, Status)
VALUES (@e3, '2026-09-17', '11:00:00', '11:15:00', 15, 'ENABLED');

IF NOT EXISTS (SELECT 1 FROM dbo.Availability WHERE EventId = @e3 AND AvailableDate = '2026-09-17' AND StartTime = '15:00:00')
INSERT INTO dbo.Availability (EventId, AvailableDate, StartTime, EndTime, DurationMinutes, Status)
VALUES (@e3, '2026-09-17', '15:00:00', '15:15:00', 15, 'ENABLED');

-- Fetch AvailabilityIds
DECLARE @a1 INT = (SELECT AvailabilityId FROM dbo.Availability WHERE EventId = @e1 AND AvailableDate = '2026-09-15' AND StartTime = '09:00:00');
DECLARE @a2 INT = (SELECT AvailabilityId FROM dbo.Availability WHERE EventId = @e1 AND AvailableDate = '2026-09-15' AND StartTime = '10:00:00');
DECLARE @a3 INT = (SELECT AvailabilityId FROM dbo.Availability WHERE EventId = @e2 AND AvailableDate = '2026-09-16' AND StartTime = '14:00:00');
DECLARE @a4 INT = (SELECT AvailabilityId FROM dbo.Availability WHERE EventId = @e3 AND AvailableDate = '2026-09-17' AND StartTime = '11:00:00');
DECLARE @a5 INT = (SELECT AvailabilityId FROM dbo.Availability WHERE EventId = @e3 AND AvailableDate = '2026-09-17' AND StartTime = '15:00:00');

-- Bookings (5 test bookings)
-- Booking for event 1, slot 1
IF NOT EXISTS (SELECT 1 FROM dbo.Bookings WHERE AvailabilityId = @a1 AND CustomerEmail = 'alice@example.com')
INSERT INTO dbo.Bookings (EventId, AvailabilityId, CustomerName, CustomerEmail, PhoneNumber, [Message], BookingDate, StartTime, EndTime, [Status])
VALUES (@e1, @a1, 'Alice Tester', 'alice@example.com', '+1111111111', 'E2E test booking 1', '2026-09-15', '09:00:00', '09:30:00', 'CONFIRMED');

-- Booking for event 1, slot 2
IF NOT EXISTS (SELECT 1 FROM dbo.Bookings WHERE AvailabilityId = @a2 AND CustomerEmail = 'bob@example.com')
INSERT INTO dbo.Bookings (EventId, AvailabilityId, CustomerName, CustomerEmail, PhoneNumber, [Message], BookingDate, StartTime, EndTime, [Status])
VALUES (@e1, @a2, 'Bob Tester', 'bob@example.com', '+1222222222', 'E2E test booking 2', '2026-09-15', '10:00:00', '10:30:00', 'CONFIRMED');

-- Booking for event 2 (requires approval) -> should be PENDING
IF NOT EXISTS (SELECT 1 FROM dbo.Bookings WHERE AvailabilityId = @a3 AND CustomerEmail = 'carol@example.com')
INSERT INTO dbo.Bookings (EventId, AvailabilityId, CustomerName, CustomerEmail, PhoneNumber, [Message], BookingDate, StartTime, EndTime, [Status])
VALUES (@e2, @a3, 'Carol Approver', 'carol@example.com', '+1333333333', 'E2E test booking 3', '2026-09-16', '14:00:00', '15:00:00', 'PENDING');

-- Booking for event 3, slot 1
IF NOT EXISTS (SELECT 1 FROM dbo.Bookings WHERE AvailabilityId = @a4 AND CustomerEmail = 'dave@example.com')
INSERT INTO dbo.Bookings (EventId, AvailabilityId, CustomerName, CustomerEmail, PhoneNumber, [Message], BookingDate, StartTime, EndTime, [Status])
VALUES (@e3, @a4, 'Dave Quick', 'dave@example.com', '+1444444444', 'E2E test booking 4', '2026-09-17', '11:00:00', '11:15:00', 'CONFIRMED');

-- Booking for event 3, slot 2
IF NOT EXISTS (SELECT 1 FROM dbo.Bookings WHERE AvailabilityId = @a5 AND CustomerEmail = 'eve@example.com')
INSERT INTO dbo.Bookings (EventId, AvailabilityId, CustomerName, CustomerEmail, PhoneNumber, [Message], BookingDate, StartTime, EndTime, [Status])
VALUES (@e3, @a5, 'Eve Quick', 'eve@example.com', '+1555555555', 'E2E test booking 5', '2026-09-17', '15:00:00', '15:15:00', 'CONFIRMED');

GO

PRINT 'Seed data inserted (idempotent).';
