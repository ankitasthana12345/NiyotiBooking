const WHATSAPP_CHANNEL_URL = "https://chat.whatsapp.com/F1pAJkAHEBiG3CpTe0VpXh";

const bookingForm = document.getElementById("bookingForm");
const feedback = document.getElementById("bookingFeedback");
const countryCodeSelect = document.getElementById("countryCode");
const availableDateSelect = document.getElementById("availableDateSelect");
const availableTimeSelect = document.getElementById("availableTimeSelect");

let allEvents = [];
let allAvailability = [];
let selectedEventId = null;
let selectedDate = null;
let selectedSlot = null;

const COUNTRY_CODES = [
  { code: "+91", label: "India (+91)" },
  { code: "+1", label: "USA/Canada (+1)" },
  { code: "+44", label: "UK (+44)" },
  { code: "+61", label: "Australia (+61)" },
  { code: "+49", label: "Germany (+49)" },
  { code: "+33", label: "France (+33)" },
  { code: "+971", label: "UAE (+971)" },
  { code: "+65", label: "Singapore (+65)" },
  { code: "+81", label: "Japan (+81)" },
  { code: "+86", label: "China (+86)" },
  { code: "+27", label: "South Africa (+27)" },
  { code: "+55", label: "Brazil (+55)" },
  { code: "+7", label: "Russia (+7)" },
  { code: "+82", label: "South Korea (+82)" },
  { code: "+34", label: "Spain (+34)" },
  { code: "+39", label: "Italy (+39)" },
  { code: "+92", label: "Pakistan (+92)" },
  { code: "+880", label: "Bangladesh (+880)" },
  { code: "+94", label: "Sri Lanka (+94)" },
  { code: "+977", label: "Nepal (+977)" },
];

function populateCountryCodes() {
  if (!countryCodeSelect) return;
  countryCodeSelect.innerHTML = COUNTRY_CODES.map(
    (country) => `<option value="${country.code}" ${country.code === "+91" ? "selected" : ""}>${country.label}</option>`
  ).join("");
}

populateCountryCodes();

function groupAvailabilityByDate(records) {
  return records.reduce((acc, record) => {
    if (!acc[record.AvailableDate]) acc[record.AvailableDate] = [];
    acc[record.AvailableDate].push(record);
    return acc;
  }, {});
}

function populateTimeOptionsForDate(dateStr) {
  const map = groupAvailabilityByDate(allAvailability);
  const slots = map[dateStr] || [];

  selectedSlot = null;

  if (slots.length === 0) {
    availableTimeSelect.innerHTML = `<option value="">No time slots available</option>`;
    return;
  }

  availableTimeSelect.innerHTML =
    `<option value="">Select a time</option>` +
    slots.map((slot) => `<option value="${slot.AvailabilityId}">${formatTime12h(slot.StartTime)}</option>`).join("");
}

function populateDateOptions() {
  const map = groupAvailabilityByDate(allAvailability);
  const dates = Object.keys(map);

  selectedDate = null;
  selectedSlot = null;

  if (dates.length === 0) {
    availableDateSelect.innerHTML = `<option value="">No dates available</option>`;
    availableTimeSelect.innerHTML = `<option value="">No time slots available</option>`;
    return;
  }

  availableDateSelect.innerHTML =
    `<option value="">Select a date</option>` + dates.map((date) => `<option value="${date}">${date}</option>`).join("");

  availableTimeSelect.innerHTML = `<option value="">Select a date first</option>`;
}

availableDateSelect?.addEventListener("change", () => {
  selectedDate = availableDateSelect.value || null;
  if (!selectedDate) {
    availableTimeSelect.innerHTML = `<option value="">Select a date first</option>`;
    selectedSlot = null;
    return;
  }

  populateTimeOptionsForDate(selectedDate);
});

availableTimeSelect?.addEventListener("change", () => {
  selectedSlot = availableTimeSelect.value ? Number(availableTimeSelect.value) : null;
});

async function loadEvents() {
  const response = await fetch("/api/public/events");
  const result = await response.json();
  if (!response.ok) {
    showAlert(feedback, result.message, "danger");
    return;
  }

  allEvents = result.data.events;

  if (allEvents.length > 0) {
    selectedEventId = Number(allEvents[0].EventId);
    await loadAvailability(selectedEventId);
  }
}

async function loadAvailability(eventId) {
  const response = await fetch(`/api/public/availability/${eventId}`);
  const result = await response.json();
  if (!response.ok) {
    availableDateSelect.innerHTML = `<option value="">Unable to load availability</option>`;
    availableTimeSelect.innerHTML = `<option value="">Unable to load availability</option>`;
    return;
  }

  allAvailability = result.data.availability;
  populateDateOptions();
}

bookingForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!selectedEventId || !selectedSlot || !selectedDate) {
    showAlert(feedback, "Select a date and time before booking.", "danger");
    return;
  }

  const phoneDigits = document.getElementById("phoneNumber").value.trim();
  const payload = {
    eventId: selectedEventId,
    availabilityId: selectedSlot,
    customerName: document.getElementById("customerName").value.trim(),
    customerEmail: document.getElementById("customerEmail").value.trim(),
    phoneNumber: phoneDigits ? `${countryCodeSelect.value} ${phoneDigits}` : null,
    message: document.getElementById("message").value.trim() || null,
  };

  const response = await fetch("/api/public/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  if (!response.ok) {
    showAlert(feedback, result.message, "danger");
    await loadAvailability(selectedEventId);
    return;
  }

  const booking = result.data.booking;
  showAlert(
    feedback,
    `
      <p class="mb-1">Your appointment has been booked successfully.</p>
      <p class="mb-1"><strong>Date:</strong> ${booking.BookingDate}</p>
      <p class="mb-1"><strong>Time:</strong> ${formatTime12h(booking.StartTime)}</p>
      <p class="mb-1"><strong>Duration:</strong> ${booking.DurationMinutes} min</p>
      <p class="mb-1"><strong>Meeting Type:</strong> ${booking.MeetingPlatform}</p>
      ${booking.MeetingLink ? `<p class="mb-1"><strong>Meeting Link:</strong> <a href="${booking.MeetingLink}" target="_blank" rel="noopener">${booking.MeetingLink}</a></p>` : ""}
      <p class="mb-2"><strong>Reference:</strong> ${booking.BookingReference}</p>
      <a href="${WHATSAPP_CHANNEL_URL}" target="_blank" rel="noopener" class="btn btn-success">Join our WhatsApp Community</a>
    `,
    "success",
    0 // don't auto-close this one — it has the reference number and WhatsApp link the customer needs
  );

  // Best-effort: some browsers still allow this since it's inside the click's async chain;
  // others block it silently. The button above is the reliable fallback either way.
  window.open(WHATSAPP_CHANNEL_URL, "_blank", "noopener");

  bookingForm.reset();
  populateCountryCodes();
  await loadAvailability(selectedEventId);
});

loadEvents();
