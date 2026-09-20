const { createTransporter } = require("../config/email");
const logger = require("../config/logger");

const BRAND_NAME = "Niyoti Shrivastava";
const BRAND_COLOR = "#8a4baf";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const STATUS_BADGE = {
  PENDING: { label: "Pending", color: "#b8860b" },
  CONFIRMED: { label: "Confirmed", color: "#1e8a4c" },
  REJECTED: { label: "Rejected", color: "#c0392b" },
  CANCELLED: { label: "Cancelled", color: "#c0392b" },
  RESCHEDULED: { label: "Rescheduled", color: "#1e6fa8" },
};

const CUSTOMER_HEADLINE = {
  PENDING: "Booking Request Received",
  CONFIRMED: "Appointment Confirmed",
  REJECTED: "Appointment Update",
  CANCELLED: "Appointment Cancelled",
  RESCHEDULED: "Appointment Rescheduled",
};

const CUSTOMER_INTRO = {
  PENDING: "We've received your booking request. You'll hear from us shortly once it's confirmed.",
  CONFIRMED: "Your appointment has been confirmed. Here are the details:",
  REJECTED: "Unfortunately, we're unable to confirm this appointment request. Here are the details:",
  CANCELLED: "Your appointment has been cancelled. Here are the details:",
  RESCHEDULED: "Your appointment has been rescheduled. Here are the updated details:",
};

const ADMIN_HEADLINE = {
  PENDING: "New Booking Request",
  CONFIRMED: "New Appointment Booked",
  REJECTED: "Booking Rejected",
  CANCELLED: "Booking Cancelled",
  RESCHEDULED: "Booking Rescheduled",
};

// dateStr: "YYYY-MM-DD" — formatted manually (not via Date parsing) to avoid the
// timezone off-by-one-day pitfalls this codebase has hit before.
function formatDateLong(dateStr) {
  if (!dateStr) return "N/A";
  const [year, month, day] = dateStr.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

// timeStr: "HH:MM:SS" (24h) -> "h:mm AM/PM"
function formatTime12h(timeStr) {
  if (!timeStr) return "N/A";
  const [hourStr, minuteStr] = timeStr.split(":");
  let hour = Number(hourStr);
  const suffix = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  return `${hour}:${minuteStr} ${suffix}`;
}

// Builds the Google Calendar UTC timestamp (YYYYMMDDTHHMMSSZ) for a booking's date/time.
// The server runs in IST, so parsing "YYYY-MM-DDTHH:MM:SS" (no offset) as local time and
// converting to ISO correctly lands on the true UTC instant.
function toGoogleCalendarStamp(dateStr, timeStr) {
  const localDate = new Date(`${dateStr}T${timeStr}`);
  return localDate.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function buildGoogleCalendarLink(booking) {
  const start = toGoogleCalendarStamp(booking.BookingDate, booking.StartTime);
  const end = toGoogleCalendarStamp(booking.BookingDate, booking.EndTime);
  const text = encodeURIComponent(`Appointment with ${BRAND_NAME}`);
  const detailsLines = [`Platform: ${booking.MeetingPlatform || "N/A"}`];
  if (booking.MeetingLink) detailsLines.push(`Meeting Link: ${booking.MeetingLink}`);
  const details = encodeURIComponent(detailsLines.join("\n"));
  const location = encodeURIComponent(booking.MeetingLink || booking.MeetingPlatform || "");
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${start}/${end}&details=${details}&location=${location}`;
}

function timeRangeLabel(booking) {
  return `${formatTime12h(booking.StartTime)} – ${formatTime12h(booking.EndTime)} (${booking.DurationMinutes} minutes)`;
}

// Free-text fields (profession "Other") are user-controlled, so escape before putting them in HTML.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function detailRow(icon, label, value) {
  if (!value) return "";
  return `
    <tr>
      <td style="padding: 8px 0; font-size: 14px; color: #666; white-space: nowrap; vertical-align: top;">${icon}&nbsp; ${label}</td>
      <td style="padding: 8px 0 8px 16px; font-size: 14px; color: #222; font-weight: 500;">${value}</td>
    </tr>
  `;
}

function meetingLinkHtml(booking) {
  if (!booking.MeetingLink) return "N/A";
  return `<a href="${escapeHtml(booking.MeetingLink)}" style="color: ${BRAND_COLOR}; text-decoration: none; font-weight: 600;">Join Meeting →</a>`;
}

function statusBadgeHtml(status) {
  const badge = STATUS_BADGE[status] || { label: status, color: "#666" };
  return `<span style="display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; color: #fff; background: ${badge.color};">${badge.label}</span>`;
}

function calendarButtonHtml(booking) {
  const showCalendarButton = booking.Status === "CONFIRMED" || booking.Status === "RESCHEDULED";
  if (!showCalendarButton) return "";
  const link = buildGoogleCalendarLink(booking);
  return `
    <tr>
      <td style="padding-top: 20px;" colspan="2" align="center">
        <a href="${link}" style="display: inline-block; padding: 10px 22px; border-radius: 6px; background: ${BRAND_COLOR}; color: #fff; font-size: 14px; font-weight: 600; text-decoration: none;">
          📅 Add to Google Calendar
        </a>
      </td>
    </tr>
  `;
}

function emailShell({ headline, introHtml, rowsHtml, footerHtml }) {
  return `
    <div style="max-width: 520px; margin: 0 auto; font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #222;">
      <div style="padding: 22px 28px; background: ${BRAND_COLOR}; border-radius: 10px 10px 0 0;">
        <h2 style="margin: 0; color: #fff; font-size: 20px; font-weight: 700;">${headline}</h2>
      </div>
      <div style="padding: 26px 28px; border: 1px solid #eee; border-top: none; border-radius: 0 0 10px 10px;">
        ${introHtml}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top: 14px; border-top: 1px solid #eee; border-bottom: 1px solid #eee;">
          ${rowsHtml}
        </table>
        ${footerHtml}
      </div>
    </div>
  `;
}

function fullName(booking) {
  return [booking.CustomerTitle, booking.CustomerName].filter(Boolean).join(" ");
}

// Every detail we hold about the booking, shown identically to the customer and the admin.
// All user-supplied text is escaped; the customer's own copy lets them spot a typo.
function bookingDetailRows(booking) {
  return [
    detailRow("👤", "Name", escapeHtml(fullName(booking))),
    detailRow("⚧", "Gender", escapeHtml(booking.Gender)),
    detailRow("💼", "Profession", escapeHtml(booking.Profession)),
    detailRow("✉️", "Email", escapeHtml(booking.CustomerEmail)),
    detailRow("📞", "Contact Number", escapeHtml(booking.PhoneNumber || "N/A")),
    detailRow("📝", "Question / Reason", escapeHtml(booking.Message)),
    detailRow("💬", "Session", escapeHtml(booking.Title)),
    detailRow("🗓️", "Date", formatDateLong(booking.BookingDate)),
    detailRow("⏰", "Time", timeRangeLabel(booking)),
    detailRow("⌛", "Duration", booking.DurationMinutes ? `${booking.DurationMinutes} minutes` : ""),
    detailRow("📍", "Platform", escapeHtml(booking.MeetingPlatform || "N/A")),
    detailRow("🔗", "Meeting Link", meetingLinkHtml(booking)),
    detailRow("✅", "Status", statusBadgeHtml(booking.Status)),
    detailRow("🔖", "Reference", escapeHtml(booking.BookingReference)),
    calendarButtonHtml(booking),
  ].join("");
}

function customerBookingEmailHtml(booking) {
  return emailShell({
    headline: CUSTOMER_HEADLINE[booking.Status] || "Appointment Update",
    introHtml: `
      <p style="margin: 0 0 4px; font-size: 15px;">Hi <strong>${escapeHtml(fullName(booking))}</strong>,</p>
      <p style="margin: 0; font-size: 15px; color: #444;">${CUSTOMER_INTRO[booking.Status] || "Here's an update on your appointment:"}</p>
    `,
    rowsHtml: bookingDetailRows(booking),
    footerHtml: `
      <p style="margin: 22px 0 4px; font-size: 14px; color: #444;">We look forward to speaking with you. If you need to reschedule or have any questions, just reply to this email.</p>
      <p style="margin: 18px 0 0; font-size: 14px; color: #444;">Warm regards,<br/><strong>${BRAND_NAME}</strong></p>
    `,
  });
}

function adminBookingEmailHtml(booking) {
  return emailShell({
    headline: ADMIN_HEADLINE[booking.Status] || "Booking Update",
    introHtml: `<p style="margin: 0; font-size: 15px; color: #444;">A booking on your calendar was just updated:</p>`,
    rowsHtml: bookingDetailRows(booking),
    footerHtml: `<p style="margin: 22px 0 0; font-size: 13px; color: #999;">Automated notification from your booking system.</p>`,
  });
}

function plainTextSummary(booking) {
  const lines = [
    `Name: ${fullName(booking)}`,
    booking.Gender ? `Gender: ${booking.Gender}` : null,
    booking.Profession ? `Profession: ${booking.Profession}` : null,
    `Email: ${booking.CustomerEmail}`,
    `Contact Number: ${booking.PhoneNumber || "N/A"}`,
    booking.Message ? `Question / Reason: ${booking.Message}` : null,
    booking.Title ? `Session: ${booking.Title}` : null,
    `Date: ${formatDateLong(booking.BookingDate)}`,
    `Time: ${timeRangeLabel(booking)}`,
    booking.DurationMinutes ? `Duration: ${booking.DurationMinutes} minutes` : null,
    `Platform: ${booking.MeetingPlatform || "N/A"}`,
    booking.MeetingLink ? `Meeting Link: ${booking.MeetingLink}` : null,
    `Status: ${booking.Status}`,
    booking.BookingReference ? `Reference: ${booking.BookingReference}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

async function sendEmail({ to, subject, text, html }) {
  const transporter = createTransporter();

  if (!transporter) {
    logger.warn("SMTP is not configured. Email skipped.", { to, subject });
    return { skipped: true };
  }

  const mailOptions = {
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  };

  const info = await transporter.sendMail(mailOptions);
  logger.info("Email sent", { to, subject, messageId: info.messageId });
  return info;
}

async function sendBookingNotifications({ booking, customerSubject, adminSubject }) {
  // Notification delivery is best-effort: the booking itself already succeeded and was
  // persisted before this runs, so an SMTP failure here must not turn into a 500 that
  // makes the API look like the booking failed. Log and move on instead.
  const adminTarget = booking.NotificationEmail || process.env.ADMIN_NOTIFICATION_EMAIL;

  if (adminTarget) {
    try {
      await sendEmail({
        to: adminTarget,
        subject: adminSubject,
        text: `${adminSubject}\n\n${plainTextSummary(booking)}`,
        html: adminBookingEmailHtml(booking),
      });
    } catch (error) {
      logger.error("Failed to send admin booking notification", { to: adminTarget, message: error.message });
    }
  }

  try {
    await sendEmail({
      to: booking.CustomerEmail,
      subject: customerSubject,
      text: `${customerSubject}\n\n${plainTextSummary(booking)}`,
      html: customerBookingEmailHtml(booking),
    });
  } catch (error) {
    logger.error("Failed to send customer booking notification", { to: booking.CustomerEmail, message: error.message });
  }
}

async function sendResetPasswordEmail({ to, resetLink }) {
  await sendEmail({
    to,
    subject: "Reset your admin password",
    text: `Reset your password by opening this link: ${resetLink}`,
    html: `<p>Reset your password by clicking <a href="${resetLink}">this link</a>.</p>`,
  });
}

module.exports = {
  sendEmail,
  sendBookingNotifications,
  sendResetPasswordEmail,
};
