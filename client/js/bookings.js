async function ensureAdmin() {
  const response = await fetch("/api/auth/me", { credentials: "include" });
  if (!response.ok) window.location.href = "/admin-login.html";
}

document.getElementById("logoutBtn")?.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  window.location.href = "/admin-login.html";
});

const listBody = document.getElementById("bookingsBody");
const feedback = document.getElementById("feedback");
let openRescheduleId = null;
let rescheduleSlotsByBooking = {};

async function loadBookings() {
  const status = document.getElementById("statusFilter").value;
  const q = document.getElementById("q").value.trim();
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (q) params.set("q", q);

  const response = await fetch(`/api/bookings?${params.toString()}`, { credentials: "include" });
  const result = await response.json();
  if (!response.ok) return;

  openRescheduleId = null;
  rescheduleSlotsByBooking = {};

  listBody.innerHTML = result.data.bookings
    .map(
      (row) => `
      <tr>
        <td>${row.CustomerName}</td>
        <td>${row.CustomerEmail}</td>
        <td>${row.PhoneNumber || ""}</td>
        <td>${row.BookingDate}</td>
        <td>${formatTime12h(row.StartTime)}</td>
        <td>
          <button type="button" class="btn btn-sm btn-outline-danger" data-action="reject" data-id="${row.BookingId}">Reject</button>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-action="toggle-reschedule" data-id="${row.BookingId}" data-event-id="${row.EventId}">Reschedule</button>
        </td>
      </tr>
      <tr id="reschedule-row-${row.BookingId}" class="d-none">
        <td colspan="6">
          <div class="d-flex flex-wrap gap-2 align-items-center">
            <label class="small text-muted mb-0">Date</label>
            <select id="reschedule-date-${row.BookingId}" class="form-select form-select-sm" style="max-width: 200px"></select>
            <label class="small text-muted mb-0">Time</label>
            <select id="reschedule-time-${row.BookingId}" class="form-select form-select-sm" style="max-width: 220px"></select>
            <button type="button" class="btn btn-sm btn-primary" data-action="confirm-reschedule" data-id="${row.BookingId}">Confirm Reschedule</button>
            <button type="button" class="btn btn-sm btn-outline-secondary" data-action="close-reschedule" data-id="${row.BookingId}">Close</button>
          </div>
        </td>
      </tr>
    `
    )
    .join("");
}

// Builds quick "click to notify" links for the customer — WhatsApp (wa.me, pre-filled
// message), email (mailto:), SMS compose (sms:, opens the device's native Messages app
// pre-filled — works on mobile, typically a no-op on desktop with no SMS handler), and
// click-to-call. Nothing is sent automatically; the admin has to actually click one.
// True auto-send SMS would need a paid gateway (e.g. Twilio/MSG91) plus, in India, DLT
// template registration — not wired up here.
function buildNotifyLinksHtml(booking, message) {
  const digits = (booking.PhoneNumber || "").replace(/\D/g, "");
  const text = encodeURIComponent(`Hi ${booking.CustomerName}, ${message}`);
  const whatsappLink = digits ? `https://wa.me/${digits}?text=${text}` : null;
  const mailtoLink = `mailto:${booking.CustomerEmail}?subject=${encodeURIComponent("Update on your booking")}&body=${text}`;
  const smsLink = digits ? `sms:+${digits}?body=${text}` : null;

  return `
    <div class="mt-2 pt-2 border-top d-flex flex-wrap align-items-center gap-2">
      <span class="small text-muted">Notify customer:</span>
      ${whatsappLink ? `<a href="${whatsappLink}" target="_blank" rel="noopener" class="btn btn-sm btn-success">WhatsApp</a>` : ""}
      <a href="${mailtoLink}" class="btn btn-sm btn-outline-primary">Email</a>
      ${smsLink ? `<a href="${smsLink}" class="btn btn-sm btn-outline-info">Text (SMS)</a>` : ""}
      ${digits ? `<a href="tel:+${digits}" class="btn btn-sm btn-outline-secondary">Call ${booking.PhoneNumber}</a>` : ""}
    </div>
  `;
}

async function reject(id) {
  const response = await fetch(`/api/bookings/${id}/reject`, { method: "POST", credentials: "include" });
  const result = await response.json();

  if (!response.ok) {
    showAlert(feedback, result.message, "danger");
    return;
  }

  const booking = result.data.booking;
  const notifyHtml = buildNotifyLinksHtml(
    booking,
    `unfortunately your booking on ${booking.BookingDate} at ${formatTime12h(booking.StartTime)} has been rejected. Please reach out if you'd like to find another time.`
  );
  showAlert(feedback, `${result.message}${notifyHtml}`, "success", 0);
  loadBookings();
}

function closeReschedule(id) {
  document.getElementById(`reschedule-row-${id}`)?.classList.add("d-none");
  if (openRescheduleId === id) openRescheduleId = null;
}

function populateRescheduleTimes(id, date) {
  const timeSelect = document.getElementById(`reschedule-time-${id}`);
  const slots = (rescheduleSlotsByBooking[id] && rescheduleSlotsByBooking[id][date]) || [];

  timeSelect.innerHTML = slots.length
    ? `<option value="">Select a time</option>` +
      slots
        .map((slot) => `<option value="${slot.AvailabilityId}">${formatTime12h(slot.StartTime)} (${slot.MeetingPlatform})</option>`)
        .join("")
    : `<option value="">No times available</option>`;
}

async function toggleReschedule(id, eventId) {
  const row = document.getElementById(`reschedule-row-${id}`);
  if (!row) return;

  if (openRescheduleId === id) {
    closeReschedule(id);
    return;
  }

  if (openRescheduleId !== null) closeReschedule(openRescheduleId);

  const dateSelect = document.getElementById(`reschedule-date-${id}`);
  const timeSelect = document.getElementById(`reschedule-time-${id}`);
  dateSelect.innerHTML = `<option value="">Loading...</option>`;
  timeSelect.innerHTML = `<option value="">Select a date first</option>`;
  row.classList.remove("d-none");
  openRescheduleId = id;

  const response = await fetch(`/api/availability/${eventId}`, { credentials: "include" });
  const result = await response.json();
  const openSlots = (response.ok ? result.data.availability : []).filter((slot) => slot.Status === "ENABLED");

  const byDate = {};
  openSlots.forEach((slot) => {
    if (!byDate[slot.AvailableDate]) byDate[slot.AvailableDate] = [];
    byDate[slot.AvailableDate].push(slot);
  });
  rescheduleSlotsByBooking[id] = byDate;

  const dates = Object.keys(byDate).sort();
  dateSelect.innerHTML = dates.length
    ? `<option value="">Select a date</option>` + dates.map((date) => `<option value="${date}">${date}</option>`).join("")
    : `<option value="">No open dates available</option>`;
}

async function confirmReschedule(id) {
  const timeSelect = document.getElementById(`reschedule-time-${id}`);
  const newAvailabilityId = Number(timeSelect.value);
  if (!newAvailabilityId) {
    showAlert(feedback, "Select a date and time to reschedule to", "danger");
    return;
  }

  const response = await fetch(`/api/bookings/${id}/reschedule`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newAvailabilityId }),
  });

  const result = await response.json();
  if (!response.ok) {
    showAlert(feedback, result.message, "danger");
    return;
  }

  const booking = result.data.booking;
  const notifyHtml = buildNotifyLinksHtml(
    booking,
    `your booking has been rescheduled to ${booking.BookingDate} at ${formatTime12h(booking.StartTime)}. Let us know if this works for you.`
  );
  showAlert(feedback, `${result.message}${notifyHtml}`, "success", 0);
  closeReschedule(id);
  loadBookings();
}

listBody?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const id = Number(button.dataset.id);
  switch (button.dataset.action) {
    case "reject":
      reject(id);
      break;
    case "toggle-reschedule":
      toggleReschedule(id, Number(button.dataset.eventId));
      break;
    case "confirm-reschedule":
      confirmReschedule(id);
      break;
    case "close-reschedule":
      closeReschedule(id);
      break;
  }
});

listBody?.addEventListener("change", (event) => {
  const dateSelect = event.target.closest('select[id^="reschedule-date-"]');
  if (!dateSelect) return;

  const id = Number(dateSelect.id.replace("reschedule-date-", ""));
  populateRescheduleTimes(id, dateSelect.value);
});

document.getElementById("searchBtn")?.addEventListener("click", loadBookings);

// Status filter re-loads the instant it's changed — no button needed.
document.getElementById("statusFilter")?.addEventListener("change", loadBookings);

// Search box filters live as you type, debounced so it doesn't fire on every keystroke.
let searchDebounceTimer;
document.getElementById("q")?.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(loadBookings, 350);
});

(async () => {
  await ensureAdmin();
  await loadBookings();
})();
