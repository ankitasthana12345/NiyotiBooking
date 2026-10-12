// Allowed values for the booking form's Title / Gender dropdowns. Keep in sync with
// the <select> options in client/booking.html.
const TITLES = ["Mr.", "Mrs.", "Ms."];
const GENDERS = ["Male", "Female", "Non-binary", "Prefer not to say"];

// Customers can only book a slot that starts MORE than the admin-chosen notice from now
// (e.g. 24h: now 22 Sep 3:00 PM => first bookable slot is 23 Sep 3:01 PM). 0.5 = 30 minutes.
const ALLOWED_NOTICE_HOURS = [0.5, 1, 2, 4, 6, 8, 10, 12, 18, 24, 36, 48, 60, 72];
const DEFAULT_NOTICE_HOURS = 24;

function effectiveNoticeHours(configured) {
  const hours = Number(configured);
  return Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_NOTICE_HOURS;
}

// SQL intervals use whole minutes so that 30-minute notice (0.5h) is exact.
function noticeMinutes(hours) {
  return Math.round(effectiveNoticeHours(hours) * 60);
}

// How many sessions a customer (same email or phone) may book in total. Admin-editable per customer.
const DEFAULT_SLOTS = 2;
const MIN_SLOTS = 1;
const MAX_SLOTS = 10;

module.exports = { DEFAULT_SLOTS, MIN_SLOTS, MAX_SLOTS, TITLES, GENDERS, ALLOWED_NOTICE_HOURS, DEFAULT_NOTICE_HOURS, effectiveNoticeHours, noticeMinutes };
