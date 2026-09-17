async function ensureAdmin() {
  const response = await fetch("/api/auth/me", { credentials: "include" });
  if (!response.ok) window.location.href = "/admin-login.html";
}

document.getElementById("logoutBtn")?.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  window.location.href = "/admin-login.html";
});

const availabilityForm = document.getElementById("availabilityForm");
const listBody = document.getElementById("availabilityBody");
const feedback = document.getElementById("feedback");
const rangeStartDateInput = document.getElementById("rangeStartDate");
const rangeEndDateInput = document.getElementById("rangeEndDate");
const durationSelect = document.getElementById("durationMinutes");
const weeklyScheduleBox = document.getElementById("weeklySchedule");
const step2Section = document.getElementById("step2Section");
const step2Placeholder = document.getElementById("step2Placeholder");
const minimumNoticeHoursSelect = document.getElementById("minimumNoticeHours");
let currentEventId = null;

// IST is UTC+5:30. Reading UTC fields off a timestamp shifted by that offset
// yields IST wall-clock numbers regardless of the browser's own timezone.
function getNowIST() {
  const shifted = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return {
    dateStr: shifted.toISOString().slice(0, 10),
    hour24: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

const WEEK_DAYS = [
  { dow: 1, label: "Monday", defaultEnabled: true },
  { dow: 2, label: "Tuesday", defaultEnabled: true },
  { dow: 3, label: "Wednesday", defaultEnabled: true },
  { dow: 4, label: "Thursday", defaultEnabled: true },
  { dow: 5, label: "Friday", defaultEnabled: true },
  { dow: 6, label: "Saturday", defaultEnabled: false },
  { dow: 0, label: "Sunday", defaultEnabled: false },
];

function buildHourOptions(selectedHour) {
  return Array.from({ length: 12 }, (_, i) => i + 1)
    .map((hour) => `<option value="${hour}" ${hour === selectedHour ? "selected" : ""}>${hour}</option>`)
    .join("");
}

function buildMinuteOptions(selectedMinute) {
  return Array.from({ length: 60 }, (_, i) => i)
    .map((minute) => `<option value="${minute}" ${minute === selectedMinute ? "selected" : ""}>${String(minute).padStart(2, "0")}</option>`)
    .join("");
}

function buildPeriodOptions(selectedPeriod) {
  return ["AM", "PM"].map((p) => `<option ${p === selectedPeriod ? "selected" : ""}>${p}</option>`).join("");
}

let timeRowCounter = 0;

function populateWeeklyScheduleUI() {
  weeklyScheduleBox.innerHTML = WEEK_DAYS.map(
    (day) => `
      <div class="border rounded p-2" data-day="${day.dow}">
        <div class="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" id="day-enabled-${day.dow}" ${day.defaultEnabled ? "checked" : ""} />
            <label class="form-check-label fw-semibold" for="day-enabled-${day.dow}">${day.label}</label>
          </div>
          <div class="d-flex align-items-center gap-2">
            <span class="badge text-bg-secondary" id="day-count-badge-${day.dow}">0 slots</span>
            <button type="button" class="btn btn-sm btn-outline-secondary" data-action="add-time" data-day="${day.dow}">+ Add Time</button>
          </div>
        </div>
        <div id="day-times-${day.dow}" class="d-flex flex-column gap-2"></div>
      </div>
    `
  ).join("");
}

// Suggests the next hour after the day's last-added time (9, 10, 11 AM, ...),
// wrapping AM/PM and defaulting to 9:00 AM for a day's first row.
function suggestNextTime(dow) {
  const container = document.getElementById(`day-times-${dow}`);
  const rows = container.querySelectorAll(".time-row");
  if (rows.length === 0) return { hour: 9, minute: 0, period: "AM" };

  const lastRow = rows[rows.length - 1];
  let hour24 = Number(lastRow.querySelector(".time-hour").value) % 12;
  if (lastRow.querySelector(".time-period").value === "PM") hour24 += 12;
  hour24 = (hour24 + 1) % 24;

  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour: hour12, minute: 0, period: hour24 < 12 ? "AM" : "PM" };
}

function addTimeRow(dow, defaults) {
  const { hour, minute, period } = defaults || suggestNextTime(dow);
  const rowId = ++timeRowCounter;

  const row = document.createElement("div");
  row.className = "d-flex align-items-center gap-2 time-row";
  row.dataset.rowId = String(rowId);
  row.innerHTML = `
    <select class="form-select form-select-sm time-hour" style="width: 70px">${buildHourOptions(hour)}</select>
    <select class="form-select form-select-sm time-minute" style="width: 75px">${buildMinuteOptions(minute)}</select>
    <select class="form-select form-select-sm time-period" style="width: 75px">${buildPeriodOptions(period)}</select>
    <span class="text-muted small">&rarr;</span>
    <input type="text" class="form-control form-control-sm time-end" style="max-width: 110px" readonly />
    <button type="button" class="btn btn-sm btn-outline-danger" data-action="remove-time" data-day="${dow}" data-row-id="${rowId}">&times;</button>
  `;

  document.getElementById(`day-times-${dow}`).appendChild(row);
  computeRowEndTime(row);
  updateDayCountBadge(dow);
}

function removeTimeRow(dow, rowId) {
  document.querySelector(`#day-times-${dow} .time-row[data-row-id="${rowId}"]`)?.remove();
  updateDayCountBadge(dow);
}

function updateDayCountBadge(dow) {
  const count = document.querySelectorAll(`#day-times-${dow} .time-row`).length;
  document.getElementById(`day-count-badge-${dow}`).textContent = `${count} slot${count === 1 ? "" : "s"}`;
}

function getRowStartTime24(row) {
  let hour = Number(row.querySelector(".time-hour").value);
  const minute = Number(row.querySelector(".time-minute").value);
  const period = row.querySelector(".time-period").value;

  if (period === "AM") {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function computeRowEndTime(row) {
  const [hours, minutes] = getRowStartTime24(row).split(":").map(Number);
  const start = new Date(2000, 0, 1, hours, minutes);
  const end = new Date(start.getTime() + Number(durationSelect.value) * 60000);
  const endTime24 = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
  row.querySelector(".time-end").value = formatTime12h(endTime24);
}

function computeAllDayEndTimes() {
  weeklyScheduleBox.querySelectorAll(".time-row").forEach(computeRowEndTime);
}

weeklyScheduleBox?.addEventListener("click", (event) => {
  const addBtn = event.target.closest('button[data-action="add-time"]');
  if (addBtn) {
    addTimeRow(Number(addBtn.dataset.day));
    return;
  }

  const removeBtn = event.target.closest('button[data-action="remove-time"]');
  if (removeBtn) {
    removeTimeRow(Number(removeBtn.dataset.day), removeBtn.dataset.rowId);
  }
});

weeklyScheduleBox?.addEventListener("change", (event) => {
  const row = event.target.closest(".time-row");
  if (row) computeRowEndTime(row);
});

populateWeeklyScheduleUI();
// Seed each default-enabled day with one starter row so the form isn't empty on first load.
WEEK_DAYS.forEach((day) => {
  if (day.defaultEnabled) addTimeRow(day.dow, { hour: 9, minute: 0, period: "AM" });
});

// Step 2 only becomes available once Step 1 (date range + duration) is fully filled in.
function updateStep2Visibility() {
  const ready = Boolean(rangeStartDateInput.value) && Boolean(rangeEndDateInput.value) && Boolean(durationSelect.value);
  step2Section.hidden = !ready;
  step2Placeholder.hidden = ready;
  if (ready) computeAllDayEndTimes();
}

durationSelect?.addEventListener("change", updateStep2Visibility);

rangeStartDateInput.min = getNowIST().dateStr;
if (!rangeStartDateInput.value) rangeStartDateInput.value = getNowIST().dateStr;

rangeStartDateInput?.addEventListener("change", () => {
  rangeEndDateInput.min = rangeStartDateInput.value;
  if (rangeEndDateInput.value && rangeEndDateInput.value < rangeStartDateInput.value) {
    rangeEndDateInput.value = rangeStartDateInput.value;
  }
  updateStep2Visibility();
});
rangeEndDateInput?.addEventListener("change", updateStep2Visibility);
rangeEndDateInput.min = rangeStartDateInput.value;

updateStep2Visibility();

async function loadCurrentEvent() {
  const response = await fetch("/api/events", { credentials: "include" });
  const result = await response.json();
  if (!response.ok) return;

  const events = result.data.events || [];
  const active = events.find((event) => event.IsActive) || events[0];
  currentEventId = active ? active.EventId : null;
}

async function loadBookingSettings() {
  const response = await fetch("/api/availability/settings", { credentials: "include" });
  const result = await response.json();
  if (!response.ok) return;

  minimumNoticeHoursSelect.value = String(result.data.minimumNoticeHours);
}

document.getElementById("saveNoticeHoursBtn")?.addEventListener("click", async () => {
  const response = await fetch("/api/availability/settings", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minimumNoticeHours: Number(minimumNoticeHoursSelect.value) }),
  });

  const result = await response.json();
  showAlert(feedback, result.message, response.ok ? "success" : "danger");
});

async function loadAvailability() {
  if (!currentEventId) return;

  const response = await fetch(`/api/availability/${currentEventId}`, { credentials: "include" });
  const result = await response.json();
  if (!response.ok) return;

  const slots = result.data.availability;

  // Build each row's HTML once via array + join (avoids O(n^2) string concatenation),
  // then a single innerHTML assignment — O(n) overall for n slots.
  listBody.innerHTML = slots
    .map(
      (row) => `
      <tr>
        <td>${row.AvailableDate}</td>
        <td>${formatTime12h(row.StartTime)}</td>
        <td>${formatTime12h(row.EndTime)}</td>
        <td>
          ${
            row.IsBooked
              ? `<span class="badge text-bg-success">Booked</span>`
              : `<span class="badge text-bg-secondary">Available</span>`
          }
        </td>
        <td>
          ${
            row.IsBooked
              ? `<span class="text-muted small">—</span>`
              : `<button type="button" class="btn btn-sm btn-outline-danger" data-action="delete" data-id="${row.AvailabilityId}">Delete</button>`
          }
        </td>
      </tr>
    `
    )
    .join("");
}

async function deleteSlot(id) {
  if (!confirm("Delete this slot?")) return;

  const response = await fetch(`/api/availability/${id}`, { method: "DELETE", credentials: "include" });
  const result = await response.json();

  if (!response.ok) {
    showAlert(feedback, result.message, "danger");
    return;
  }

  showAlert(feedback, result.message, result.data?.fellBackToDisable ? "warning" : "success");
  loadAvailability();
}

// Single delegated listener handles Delete for every row — O(1) listeners regardless
// of how many slots are rendered, instead of one listener per button.
listBody?.addEventListener("click", (event) => {
  const button = event.target.closest('button[data-action="delete"]');
  if (!button) return;
  deleteSlot(Number(button.dataset.id));
});

availabilityForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  computeAllDayEndTimes();

  const weeklySchedule = WEEK_DAYS.map((day) => {
    const enabled = document.getElementById(`day-enabled-${day.dow}`).checked;
    const times = enabled
      ? Array.from(document.querySelectorAll(`#day-times-${day.dow} .time-row`)).map((row) => getRowStartTime24(row))
      : [];
    return { dayOfWeek: day.dow, enabled: enabled && times.length > 0, times };
  });

  if (!weeklySchedule.some((day) => day.enabled)) {
    showAlert(feedback, "Enable at least one day and add at least one time for it.", "danger");
    return;
  }

  const payload = {
    eventId: currentEventId,
    startDate: rangeStartDateInput.value,
    endDate: rangeEndDateInput.value,
    durationMinutes: Number(durationSelect.value),
    meetingPlatform: document.getElementById("meetingPlatform").value,
    meetingLink: document.getElementById("meetingLink").value.trim() || null,
    status: document.getElementById("status").value,
    weeklySchedule,
  };

  const response = await fetch("/api/availability/weekly", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  showAlert(feedback, result.message, response.ok ? "success" : "danger");

  if (response.ok) {
    if (result.data?.skipped?.length) {
      showAlert(
        feedback,
        `${result.message}. ${result.data.skipped.length} date(s) were skipped (likely already had a slot): ${result.data.skipped
          .map((s) => s.date)
          .join(", ")}`,
        "warning",
        0
      );
    }
    rangeStartDateInput.value = getNowIST().dateStr;
    rangeEndDateInput.min = rangeStartDateInput.value;
    rangeEndDateInput.value = "";
    document.getElementById("meetingLink").value = "";
    updateStep2Visibility();
    loadAvailability();
  }
});

(async () => {
  await ensureAdmin();
  await loadCurrentEvent();
  await loadBookingSettings();
  await loadAvailability();
})();
