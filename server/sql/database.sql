/*
	Appointment Booking System - SQL Server Schema
	Execute this script in SSMS.
*/

IF DB_ID(N'AppointmentBookingDB') IS NULL
BEGIN
	CREATE DATABASE AppointmentBookingDB;
END;
GO

USE AppointmentBookingDB;
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/* Drop programmable objects first for idempotent reruns */
IF OBJECT_ID(N'dbo.trg_ConsultationEvents_UpdatedDate', N'TR') IS NOT NULL DROP TRIGGER dbo.trg_ConsultationEvents_UpdatedDate;
IF OBJECT_ID(N'dbo.trg_AdminUsers_UpdatedDate', N'TR') IS NOT NULL DROP TRIGGER dbo.trg_AdminUsers_UpdatedDate;
IF OBJECT_ID(N'dbo.trg_Availability_UpdatedDate', N'TR') IS NOT NULL DROP TRIGGER dbo.trg_Availability_UpdatedDate;
IF OBJECT_ID(N'dbo.trg_Bookings_UpdatedDate', N'TR') IS NOT NULL DROP TRIGGER dbo.trg_Bookings_UpdatedDate;
IF OBJECT_ID(N'dbo.trg_Availability_NoOverlap', N'TR') IS NOT NULL DROP TRIGGER dbo.trg_Availability_NoOverlap;
IF OBJECT_ID(N'dbo.sp_CreatePublicBooking', N'P') IS NOT NULL DROP PROCEDURE dbo.sp_CreatePublicBooking;
GO

/* Drop tables in FK dependency order */
IF OBJECT_ID(N'dbo.PasswordResetTokens', N'U') IS NOT NULL DROP TABLE dbo.PasswordResetTokens;
IF OBJECT_ID(N'dbo.Bookings', N'U') IS NOT NULL DROP TABLE dbo.Bookings;
IF OBJECT_ID(N'dbo.Availability', N'U') IS NOT NULL DROP TABLE dbo.Availability;
IF OBJECT_ID(N'dbo.BookingSettings', N'U') IS NOT NULL DROP TABLE dbo.BookingSettings;
IF OBJECT_ID(N'dbo.BlockedDates', N'U') IS NOT NULL DROP TABLE dbo.BlockedDates;
IF OBJECT_ID(N'dbo.ConsultationEvents', N'U') IS NOT NULL DROP TABLE dbo.ConsultationEvents;
IF OBJECT_ID(N'dbo.AdminUsers', N'U') IS NOT NULL DROP TABLE dbo.AdminUsers;
GO

CREATE TABLE dbo.AdminUsers
(
	AdminId INT IDENTITY(1,1) NOT NULL,
	Username NVARCHAR(100) NOT NULL,
	Email NVARCHAR(255) NOT NULL,
	PasswordHash NVARCHAR(255) NOT NULL,
	IsActive BIT NOT NULL CONSTRAINT DF_AdminUsers_IsActive DEFAULT (1),
	CreatedDate DATETIME2(0) NOT NULL CONSTRAINT DF_AdminUsers_CreatedDate DEFAULT (SYSUTCDATETIME()),
	UpdatedDate DATETIME2(0) NOT NULL CONSTRAINT DF_AdminUsers_UpdatedDate DEFAULT (SYSUTCDATETIME()),
	CONSTRAINT PK_AdminUsers PRIMARY KEY CLUSTERED (AdminId),
	CONSTRAINT UQ_AdminUsers_Username UNIQUE (Username),
	CONSTRAINT UQ_AdminUsers_Email UNIQUE (Email)
);
GO

CREATE TABLE dbo.ConsultationEvents
(
	EventId INT IDENTITY(1,1) NOT NULL,
	Title NVARCHAR(200) NOT NULL,
	[Description] NVARCHAR(2000) NULL,
	DurationMinutes INT NOT NULL CONSTRAINT DF_ConsultationEvents_DurationMinutes DEFAULT (30),
	BufferBeforeMinutes INT NOT NULL CONSTRAINT DF_ConsultationEvents_BufferBeforeMinutes DEFAULT (0),
	BufferAfterMinutes INT NOT NULL CONSTRAINT DF_ConsultationEvents_BufferAfterMinutes DEFAULT (0),
	MeetingPlatform NVARCHAR(30) NOT NULL CONSTRAINT DF_ConsultationEvents_MeetingPlatform DEFAULT (N'Google Meet'),
	MeetingLink NVARCHAR(1000) NULL,
	IsPaid BIT NOT NULL CONSTRAINT DF_ConsultationEvents_IsPaid DEFAULT (0),
	Price DECIMAL(10,2) NOT NULL CONSTRAINT DF_ConsultationEvents_Price DEFAULT (0.00),
	Currency CHAR(3) NOT NULL CONSTRAINT DF_ConsultationEvents_Currency DEFAULT ('INR'),
	RequiresApproval BIT NOT NULL CONSTRAINT DF_ConsultationEvents_RequiresApproval DEFAULT (0),
	NotificationEmail NVARCHAR(255) NULL,
	IsActive BIT NOT NULL CONSTRAINT DF_ConsultationEvents_IsActive DEFAULT (1),
	CreatedDate DATETIME2(0) NOT NULL CONSTRAINT DF_ConsultationEvents_CreatedDate DEFAULT (SYSUTCDATETIME()),
	UpdatedDate DATETIME2(0) NOT NULL CONSTRAINT DF_ConsultationEvents_UpdatedDate DEFAULT (SYSUTCDATETIME()),
	CONSTRAINT PK_ConsultationEvents PRIMARY KEY CLUSTERED (EventId),
	CONSTRAINT CK_ConsultationEvents_DurationMinutes CHECK (DurationMinutes IN (15, 30, 45, 60, 90, 120)),
	CONSTRAINT CK_ConsultationEvents_BufferBeforeMinutes CHECK (BufferBeforeMinutes BETWEEN 0 AND 10080),
	CONSTRAINT CK_ConsultationEvents_BufferAfterMinutes CHECK (BufferAfterMinutes BETWEEN 0 AND 10080),
	CONSTRAINT CK_ConsultationEvents_MeetingPlatform CHECK (MeetingPlatform IN (N'Google Meet', N'Zoom', N'Microsoft Teams', N'Custom')),
	CONSTRAINT CK_ConsultationEvents_Price CHECK (Price >= 0),
	CONSTRAINT CK_ConsultationEvents_Currency CHECK (Currency LIKE '[A-Z][A-Z][A-Z]'),
	CONSTRAINT CK_ConsultationEvents_CustomLink
		CHECK ((MeetingPlatform <> N'Custom') OR (MeetingLink IS NOT NULL AND LEN(LTRIM(RTRIM(MeetingLink))) > 0)),
	CONSTRAINT CK_ConsultationEvents_PaidConfig
		CHECK ((IsPaid = 0 AND Price = 0.00) OR (IsPaid = 1 AND Price >= 0.00))
);
GO

CREATE TABLE dbo.BlockedDates
(
	BlockedDateId INT IDENTITY(1,1) NOT NULL,
	EventId INT NOT NULL,
	BlockedDate DATE NOT NULL,
	[Reason] NVARCHAR(500) NULL,
	IsActive BIT NOT NULL CONSTRAINT DF_BlockedDates_IsActive DEFAULT (1),
	CreatedDate DATETIME2(0) NOT NULL CONSTRAINT DF_BlockedDates_CreatedDate DEFAULT (SYSUTCDATETIME()),
	UpdatedDate DATETIME2(0) NOT NULL CONSTRAINT DF_BlockedDates_UpdatedDate DEFAULT (SYSUTCDATETIME()),
	CONSTRAINT PK_BlockedDates PRIMARY KEY CLUSTERED (BlockedDateId),
	CONSTRAINT FK_BlockedDates_Event FOREIGN KEY (EventId) REFERENCES dbo.ConsultationEvents(EventId),
	CONSTRAINT UQ_BlockedDates_Event_Date UNIQUE (EventId, BlockedDate)
);
GO

/* Global booking settings (single row). Controls how far in advance a slot must sit
   before the public booking page will offer it. */
CREATE TABLE dbo.BookingSettings
(
	SettingId INT NOT NULL CONSTRAINT DF_BookingSettings_SettingId DEFAULT (1),
	MinimumNoticeHours INT NOT NULL CONSTRAINT DF_BookingSettings_MinimumNoticeHours DEFAULT (24),
	UpdatedDate DATETIME2(0) NOT NULL CONSTRAINT DF_BookingSettings_UpdatedDate DEFAULT (SYSUTCDATETIME()),
	CONSTRAINT PK_BookingSettings PRIMARY KEY CLUSTERED (SettingId),
	CONSTRAINT CK_BookingSettings_SettingId CHECK (SettingId = 1),
	CONSTRAINT CK_BookingSettings_MinimumNoticeHours CHECK (MinimumNoticeHours IN (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24, 36, 48))
);
GO

INSERT INTO dbo.BookingSettings (SettingId, MinimumNoticeHours) VALUES (1, 24);
GO

CREATE TABLE dbo.Availability
(
	AvailabilityId INT IDENTITY(1,1) NOT NULL,
	EventId INT NOT NULL,
	AvailableDate DATE NOT NULL,
	StartTime TIME(0) NOT NULL,
	EndTime TIME(0) NOT NULL,
	DurationMinutes INT NOT NULL,
	BufferBeforeMinutes INT NOT NULL CONSTRAINT DF_Availability_BufferBeforeMinutes DEFAULT (0),
	BufferAfterMinutes INT NOT NULL CONSTRAINT DF_Availability_BufferAfterMinutes DEFAULT (0),
	MeetingPlatform NVARCHAR(30) NOT NULL CONSTRAINT DF_Availability_MeetingPlatform DEFAULT (N'Google Meet'),
	MeetingLink NVARCHAR(1000) NULL,
	[Status] NVARCHAR(20) NOT NULL CONSTRAINT DF_Availability_Status DEFAULT (N'ENABLED'),
	CreatedDate DATETIME2(0) NOT NULL CONSTRAINT DF_Availability_CreatedDate DEFAULT (SYSUTCDATETIME()),
	UpdatedDate DATETIME2(0) NOT NULL CONSTRAINT DF_Availability_UpdatedDate DEFAULT (SYSUTCDATETIME()),
	CONSTRAINT PK_Availability PRIMARY KEY CLUSTERED (AvailabilityId),
	CONSTRAINT FK_Availability_Event FOREIGN KEY (EventId) REFERENCES dbo.ConsultationEvents(EventId),
	CONSTRAINT CK_Availability_Status CHECK ([Status] IN (N'ENABLED', N'DISABLED', N'BLOCKED')),
	CONSTRAINT CK_Availability_MeetingPlatform CHECK (MeetingPlatform IN (N'Google Meet', N'Zoom', N'Microsoft Teams', N'Custom')),
	CONSTRAINT CK_Availability_TimeRange CHECK (StartTime < EndTime),
	CONSTRAINT CK_Availability_Duration CHECK (DurationMinutes IN (15, 30, 45, 60, 90, 120)),
	CONSTRAINT CK_Availability_BufferBefore CHECK (BufferBeforeMinutes BETWEEN 0 AND 10080),
	CONSTRAINT CK_Availability_BufferAfter CHECK (BufferAfterMinutes BETWEEN 0 AND 10080),
	CONSTRAINT UQ_Availability_Event_Date_Time UNIQUE (EventId, AvailableDate, StartTime)
);
GO

CREATE TABLE dbo.Bookings
(
	BookingId BIGINT IDENTITY(1,1) NOT NULL,
	EventId INT NOT NULL,
	AvailabilityId INT NOT NULL,
	CustomerName NVARCHAR(150) NOT NULL,
	CustomerEmail NVARCHAR(255) NOT NULL,
	PhoneNumber NVARCHAR(25) NULL,
	[Message] NVARCHAR(2000) NULL,
	BookingDate DATE NOT NULL,
	StartTime TIME(0) NOT NULL,
	EndTime TIME(0) NOT NULL,
	MeetingPlatform NVARCHAR(30) NOT NULL CONSTRAINT DF_Bookings_MeetingPlatform DEFAULT (N'Google Meet'),
	MeetingLink NVARCHAR(1000) NULL,
	[Status] NVARCHAR(20) NOT NULL,
	BookingReference UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Bookings_BookingReference DEFAULT (NEWID()),
	CreatedDate DATETIME2(0) NOT NULL CONSTRAINT DF_Bookings_CreatedDate DEFAULT (SYSUTCDATETIME()),
	UpdatedDate DATETIME2(0) NOT NULL CONSTRAINT DF_Bookings_UpdatedDate DEFAULT (SYSUTCDATETIME()),
	CONSTRAINT PK_Bookings PRIMARY KEY CLUSTERED (BookingId),
	CONSTRAINT FK_Bookings_Event FOREIGN KEY (EventId) REFERENCES dbo.ConsultationEvents(EventId),
	CONSTRAINT FK_Bookings_Availability FOREIGN KEY (AvailabilityId) REFERENCES dbo.Availability(AvailabilityId),
	CONSTRAINT CK_Bookings_Status CHECK ([Status] IN (N'PENDING', N'CONFIRMED', N'REJECTED', N'CANCELLED', N'RESCHEDULED')),
	CONSTRAINT CK_Bookings_TimeRange CHECK (StartTime < EndTime)
);
GO

CREATE TABLE dbo.PasswordResetTokens
(
	TokenId BIGINT IDENTITY(1,1) NOT NULL,
	AdminId INT NOT NULL,
	ResetToken NVARCHAR(255) NOT NULL,
	ExpiryDate DATETIME2(0) NOT NULL,
	Used BIT NOT NULL CONSTRAINT DF_PasswordResetTokens_Used DEFAULT (0),
	CreatedDate DATETIME2(0) NOT NULL CONSTRAINT DF_PasswordResetTokens_CreatedDate DEFAULT (SYSUTCDATETIME()),
	CONSTRAINT PK_PasswordResetTokens PRIMARY KEY CLUSTERED (TokenId),
	CONSTRAINT FK_PasswordResetTokens_Admin FOREIGN KEY (AdminId) REFERENCES dbo.AdminUsers(AdminId),
	CONSTRAINT UQ_PasswordResetTokens_ResetToken UNIQUE (ResetToken)
);
GO

/* Availability overlap guard */
CREATE TRIGGER dbo.trg_Availability_NoOverlap
ON dbo.Availability
AFTER INSERT, UPDATE
AS
BEGIN
	SET NOCOUNT ON;

	IF EXISTS
	(
		SELECT 1
		FROM inserted i
		INNER JOIN dbo.Availability a
			ON a.EventId = i.EventId
			AND a.AvailableDate = i.AvailableDate
			AND a.AvailabilityId <> i.AvailabilityId
			AND a.[Status] <> N'BLOCKED'
			AND i.[Status] <> N'BLOCKED'
			AND i.StartTime < a.EndTime
			AND i.EndTime > a.StartTime
	)
	BEGIN
		THROW 50010, 'Overlapping availability is not allowed for the same event and date.', 1;
	END;
END;
GO

/* Auto-maintain UpdatedDate */
CREATE TRIGGER dbo.trg_AdminUsers_UpdatedDate
ON dbo.AdminUsers
AFTER UPDATE
AS
BEGIN
	SET NOCOUNT ON;
	UPDATE au
	SET UpdatedDate = SYSUTCDATETIME()
	FROM dbo.AdminUsers au
	INNER JOIN inserted i ON i.AdminId = au.AdminId;
END;
GO

CREATE TRIGGER dbo.trg_ConsultationEvents_UpdatedDate
ON dbo.ConsultationEvents
AFTER UPDATE
AS
BEGIN
	SET NOCOUNT ON;
	UPDATE ce
	SET UpdatedDate = SYSUTCDATETIME()
	FROM dbo.ConsultationEvents ce
	INNER JOIN inserted i ON i.EventId = ce.EventId;
END;
GO

CREATE TRIGGER dbo.trg_Availability_UpdatedDate
ON dbo.Availability
AFTER UPDATE
AS
BEGIN
	SET NOCOUNT ON;
	UPDATE av
	SET UpdatedDate = SYSUTCDATETIME()
	FROM dbo.Availability av
   	INNER JOIN inserted i ON i.AvailabilityId = av.AvailabilityId;
END;
GO

CREATE TRIGGER dbo.trg_Bookings_UpdatedDate
ON dbo.Bookings
AFTER UPDATE
AS
BEGIN
	SET NOCOUNT ON;
	UPDATE b
	SET UpdatedDate = SYSUTCDATETIME()
	FROM dbo.Bookings b
	INNER JOIN inserted i ON i.BookingId = b.BookingId;
END;
GO

/* Indexes */
CREATE INDEX IX_Availability_Event_Date_Status_Start
	ON dbo.Availability (EventId, AvailableDate, [Status], StartTime);
GO

CREATE INDEX IX_BlockedDates_Event_Date
	ON dbo.BlockedDates (EventId, BlockedDate, IsActive);
GO

CREATE INDEX IX_Bookings_BookingDate_StartTime
	ON dbo.Bookings (BookingDate, StartTime);
GO

CREATE INDEX IX_Bookings_Status
	ON dbo.Bookings ([Status]);
GO

CREATE INDEX IX_Bookings_CustomerEmail
	ON dbo.Bookings (CustomerEmail);
GO

CREATE INDEX IX_Bookings_EventId
	ON dbo.Bookings (EventId);
GO

CREATE INDEX IX_Bookings_AvailabilityId
	ON dbo.Bookings (AvailabilityId);
GO

CREATE UNIQUE INDEX UX_Bookings_Active_Availability
	ON dbo.Bookings (AvailabilityId)
	WHERE [Status] IN (N'PENDING', N'CONFIRMED', N'RESCHEDULED');
GO

CREATE UNIQUE INDEX UX_Bookings_Active_Event_Date_Start
	ON dbo.Bookings (EventId, BookingDate, StartTime)
	WHERE [Status] IN (N'PENDING', N'CONFIRMED', N'RESCHEDULED');
GO

CREATE INDEX IX_PasswordResetTokens_Admin_Expiry_Used
	ON dbo.PasswordResetTokens (AdminId, ExpiryDate, Used);
GO

/*
	Booking procedure with transaction and row lock to prevent race-condition double booking.
	Application should call this for public booking creation.
*/
CREATE PROCEDURE dbo.sp_CreatePublicBooking
	@EventId INT,
	@AvailabilityId INT,
	@CustomerName NVARCHAR(150),
	@CustomerEmail NVARCHAR(255),
	@PhoneNumber NVARCHAR(25) = NULL,
	@Message NVARCHAR(2000) = NULL,
	@BookingId BIGINT OUTPUT,
	@BookingStatus NVARCHAR(20) OUTPUT
AS
BEGIN
	SET NOCOUNT ON;
	SET XACT_ABORT ON;

	DECLARE
		@AvailableDate DATE,
		@StartTime TIME(0),
		@EndTime TIME(0),
		@SlotStatus NVARCHAR(20),
		@MeetingPlatform NVARCHAR(30),
		@MeetingLink NVARCHAR(1000),
		@RequiresApproval BIT,
		@IsEventActive BIT,
		@MinimumNoticeHours INT;

	SELECT @MinimumNoticeHours = MinimumNoticeHours FROM dbo.BookingSettings WHERE SettingId = 1;
	IF @MinimumNoticeHours IS NULL SET @MinimumNoticeHours = 24;

	BEGIN TRANSACTION;

	SELECT
		@AvailableDate = av.AvailableDate,
		@StartTime = av.StartTime,
		@EndTime = av.EndTime,
		@SlotStatus = av.[Status],
		@MeetingPlatform = av.MeetingPlatform,
		@MeetingLink = av.MeetingLink,
		@RequiresApproval = ce.RequiresApproval,
		@IsEventActive = ce.IsActive
	FROM dbo.Availability av WITH (UPDLOCK, HOLDLOCK)
	INNER JOIN dbo.ConsultationEvents ce ON ce.EventId = av.EventId
	WHERE av.AvailabilityId = @AvailabilityId
	  AND av.EventId = @EventId;

	IF @AvailableDate IS NULL
	BEGIN
		ROLLBACK TRANSACTION;
		THROW 50020, 'Selected slot was not found.', 1;
	END;

	IF @IsEventActive = 0
	BEGIN
		ROLLBACK TRANSACTION;
		THROW 50021, 'Event is disabled.', 1;
	END;

	IF @SlotStatus <> N'ENABLED'
	BEGIN
		ROLLBACK TRANSACTION;
		THROW 50022, 'Selected slot is not available.', 1;
	END;

	IF DATETIMEFROMPARTS(YEAR(@AvailableDate), MONTH(@AvailableDate), DAY(@AvailableDate), DATEPART(HOUR, @StartTime), DATEPART(MINUTE, @StartTime), DATEPART(SECOND, @StartTime), 0) <= DATEADD(HOUR, @MinimumNoticeHours, DATEADD(MINUTE, 330, SYSUTCDATETIME()))
	BEGIN
		ROLLBACK TRANSACTION;
		THROW 50023, 'This slot no longer meets the minimum booking notice.', 1;
	END;

	IF EXISTS
	(
		SELECT 1
		FROM dbo.Bookings b WITH (UPDLOCK, HOLDLOCK)
		WHERE b.AvailabilityId = @AvailabilityId
		  AND b.[Status] IN (N'PENDING', N'CONFIRMED', N'RESCHEDULED')
	)
	BEGIN
		ROLLBACK TRANSACTION;
		THROW 50025, 'This slot has already been booked.', 1;
	END;

	SET @BookingStatus = CASE WHEN @RequiresApproval = 1 THEN N'PENDING' ELSE N'CONFIRMED' END;

	INSERT INTO dbo.Bookings
	(
		EventId,
		AvailabilityId,
		CustomerName,
		CustomerEmail,
		PhoneNumber,
		[Message],
		BookingDate,
		StartTime,
		EndTime,
		MeetingPlatform,
		MeetingLink,
		[Status]
	)
	VALUES
	(
		@EventId,
		@AvailabilityId,
		@CustomerName,
		@CustomerEmail,
		@PhoneNumber,
		@Message,
		@AvailableDate,
		@StartTime,
		@EndTime,
		@MeetingPlatform,
		@MeetingLink,
		@BookingStatus
	);

	SET @BookingId = SCOPE_IDENTITY();

	COMMIT TRANSACTION;
END;
GO

/* Seed default admin (idempotent). Password: Niyoti@12345 */
MERGE dbo.AdminUsers AS target
USING
(
	SELECT
		CAST(N'niyotishrivastava28' AS NVARCHAR(100)) AS Username,
		CAST(N'niyoticoach@gmail.com' AS NVARCHAR(255)) AS Email,
		CAST(N'$2b$12$.DeJrnSChXdJiTHqBUJ1D.pXyPGxSRDLOKxcpsGKfnQ6X.0SDbF1C' AS NVARCHAR(255)) AS PasswordHash
) AS source
ON target.Email = source.Email
WHEN MATCHED THEN
	UPDATE
	SET
		Username = source.Username,
		PasswordHash = source.PasswordHash,
		IsActive = 1,
		UpdatedDate = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
	INSERT (Username, Email, PasswordHash, IsActive)
	VALUES (source.Username, source.Email, source.PasswordHash, 1);
GO
