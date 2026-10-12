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
  { dow: 1, label: "Monday" },
  { dow: 2, label: "Tuesday" },
  { dow: 3, label: "Wednesday" },
  { dow: 4, label: "Thursday" },
  { dow: 5, label: "Friday" },
  { dow: 6, label: "Saturday" },
  { dow: 0, label: "Sunday" },
];

// A range of 7 days or fewer maps each weekday to exactly one calendar date, so only those
// weekdays are shown. Longer ranges show all 7 weekdays (each repeats every week).
const SINGLE_WEEK_DAYS = 7;

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Dates in the chosen range, in order, e.g. Fri..Wed => Fri, Sat, Sun, Mon, Tue, Wed.
function rangeLengthDays(startStr, endStr) {
  return Math.round((new Date(`${endStr}T00:00:00Z`) - new Date(`${startStr}T00:00:00Z`)) / 86400000) + 1;
}

function datesInRange(startStr, endStr) {
  if (rangeLengthDays(startStr, endStr) > SINGLE_WEEK_DAYS) {
    // Longer than a week: every weekday is in play, Monday first, no single date to show.
    return WEEK_DAYS.map((day) => ({ dateStr: null, dow: day.dow }));
  }
  const dates = [];
  for (let i = 0; i < SINGLE_WEEK_DAYS; i++) {
    const dateStr = addDays(startStr, i);
    if (dateStr > endStr) break;
    dates.push({ dateStr, dow: new Date(`${dateStr}T00:00:00Z`).getUTCDay() });
  }
  return dates;
}

// Earliest bookable start today: the minute right after the current IST minute
// (3:00 PM now => 3:01 PM). Returns null unless the range starts today.
function getTodayMinTime(dow) {
  const now = getNowIST();
  if (rangeStartDateInput.value !== now.dateStr) return null;
  // Only a range of 7 days or fewer has a single "today" row; on longer ranges past times
  // for today are simply skipped by the server while later weeks keep them.
  if (rangeEndDateInput.value && rangeLengthDays(rangeStartDateInput.value, rangeEndDateInput.value) > SINGLE_WEEK_DAYS) return null;
  if (new Date(`${now.dateStr}T00:00:00Z`).getUTCDay() !== dow) return null;
  return Math.min(now.hour24 * 60 + now.minute + 1, 24 * 60 - 1);
}

function minutesToParts(totalMinutes) {
  const hour24 = Math.floor(totalMinutes / 60);
  return { hour: hour24 % 12 === 0 ? 12 : hour24 % 12, minute: totalMinutes % 60, period: hour24 < 12 ? "AM" : "PM" };
}

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
            <input class="form-check-input" type="checkbox" id="day-enabled-${day.dow}" />
            <label class="form-check-label fw-semibold" for="day-enabled-${day.dow}">${day.label} <span class="text-muted fw-normal small" id="day-date-${day.dow}"></span></label>
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
  if (rows.length === 0) {
    const minToday = getTodayMinTime(dow);
    return minToday === null ? { hour: 9, minute: 0, period: "AM" } : minutesToParts(minToday);
  }

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
  clampTodayRow(row, dow);
  refreshTodayLimits(row, dow);
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

// A slot must finish on the same day: EndTime is a plain time-of-day, so a slot that would end at
// or after 12:00 AM would get an end time *earlier* than its start and break overlap/booking checks.
function rowCrossesMidnight(row) {
  return getRowStartMinutes(row) + Number(durationSelect.value) >= 24 * 60;
}

function computeRowEndTime(row) {
  const endInput = row.querySelector(".time-end");
  if (rowCrossesMidnight(row)) {
    endInput.value = "Past midnight";
    endInput.classList.add("is-invalid");
    return;
  }
  endInput.classList.remove("is-invalid");
  const endMinutes = getRowStartMinutes(row) + Number(durationSelect.value);
  endInput.value = formatTime12h(`${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`);
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

function getRowStartMinutes(row) {
  const [h, m] = getRowStartTime24(row).split(":").map(Number);
  return h * 60 + m;
}

// On today's date, nothing earlier than the next minute can be scheduled.
function clampTodayRow(row, dow) {
  const minToday = getTodayMinTime(dow);
  if (minToday === null || getRowStartMinutes(row) >= minToday) return false;
  const { hour, minute, period } = minutesToParts(minToday);
  row.querySelector(".time-hour").value = String(hour);
  row.querySelector(".time-minute").value = String(minute);
  row.querySelector(".time-period").value = period;
  return true;
}

function to24h(hour12, period) {
  return (hour12 % 12) + (period === "PM" ? 12 : 0);
}

// On today's date the hour / minute / AM-PM dropdowns simply don't offer past times: choices before
// "now + 1 minute" are disabled, so the admin can't pick them in the first place.
function refreshTodayLimits(row, dow) {
  const hourSelect = row.querySelector(".time-hour");
  const minuteSelect = row.querySelector(".time-minute");
  const periodSelect = row.querySelector(".time-period");
  const minToday = getTodayMinTime(dow);

  row.querySelectorAll("option").forEach((option) => (option.disabled = false));
  if (minToday === null) return;

  const minHour = Math.floor(minToday / 60);
  const minMinute = minToday % 60;

  periodSelect.querySelectorAll("option").forEach((option) => {
    if (option.value === "AM" && minHour >= 12) option.disabled = true;
  });
  const period = periodSelect.value;
  hourSelect.querySelectorAll("option").forEach((option) => {
    if (to24h(Number(option.value), period) < minHour) option.disabled = true;
  });
  const selectedHour24 = to24h(Number(hourSelect.value), period);
  minuteSelect.querySelectorAll("option").forEach((option) => {
    if (selectedHour24 === minHour && Number(option.value) < minMinute) option.disabled = true;
  });
}

function clampAllTodayRows() {
  WEEK_DAYS.forEach((day) => {
    document.querySelectorAll(`#day-times-${day.dow} .time-row`).forEach((row) => {
      clampTodayRow(row, day.dow);
      refreshTodayLimits(row, day.dow);
      computeRowEndTime(row);
    });
  });
}

// Time moves on while the page stays open, so keep the "no past times" limits current.
setInterval(clampAllTodayRows, 30000);

weeklyScheduleBox?.addEventListener("change", (event) => {
  const row = event.target.closest(".time-row");
  if (!row) return;
  const dow = Number(row.closest("[data-day]").dataset.day);
  if (clampTodayRow(row, dow)) {
    showAlert(feedback, "Times today must start at least one minute from now — adjusted to the earliest available time.", "warning");
  }
  refreshTodayLimits(row, dow);
  computeRowEndTime(row);
});

populateWeeklyScheduleUI();

const visibleDays = new Set();

// Shows only the weekdays that fall inside the chosen range, ordered by date
// (Mon..Fri => 5 days; Fri..Wed => Fri, Sat, Sun, Mon, Tue, Wed).
function applyRangeToSchedule() {
  const ordered = rangeStartDateInput.value && rangeEndDateInput.value
    ? datesInRange(rangeStartDateInput.value, rangeEndDateInput.value)
    : [];
  const inRangeDows = new Set(ordered.map((d) => d.dow));
  const dateByDow = new Map(ordered.map((d) => [d.dow, d.dateStr]));

  WEEK_DAYS.forEach((day) => {
    const block = weeklyScheduleBox.querySelector(`[data-day="${day.dow}"]`);
    const checkbox = document.getElementById(`day-enabled-${day.dow}`);
    const dateStr = dateByDow.get(day.dow);
    const inRange = inRangeDows.has(day.dow);

    block.hidden = !inRange;
    document.getElementById(`day-date-${day.dow}`).textContent = dateStr ? `(${dateStr})` : "";

    if (!inRange) {
      checkbox.checked = false;
      visibleDays.delete(day.dow);
    } else if (!visibleDays.has(day.dow)) {
      visibleDays.add(day.dow);
      checkbox.checked = true;
      if (document.querySelectorAll(`#day-times-${day.dow} .time-row`).length === 0) addTimeRow(day.dow);
    }
  });

  ordered.forEach((d) => weeklyScheduleBox.appendChild(weeklyScheduleBox.querySelector(`[data-day="${d.dow}"]`)));

  clampAllTodayRows();

  // On a range longer than a week the weekday rows also apply to later weeks, so today's
  // past times can't be blocked in the dropdowns; the server just skips today's past times.
  const startsTodayLong = rangeStartDateInput.value === getNowIST().dateStr && ordered.length > 0 && ordered[0].dateStr === null;
  document.getElementById("todayNote")?.classList.toggle("d-none", !startsTodayLong);
}

// Step 2 only becomes available once Step 1 (date range + duration) is fully filled in.
function updateStep2Visibility() {
  const ready = Boolean(rangeStartDateInput.value) && Boolean(rangeEndDateInput.value) && Boolean(durationSelect.value);
  step2Section.hidden = !ready;
  step2Placeholder.hidden = ready;
  if (ready) applyRangeToSchedule();
}

durationSelect?.addEventListener("change", updateStep2Visibility);

rangeStartDateInput.min = getNowIST().dateStr;
if (!rangeStartDateInput.value) rangeStartDateInput.value = getNowIST().dateStr;

// The end date can be any day on or after the start date (no upper cap; the server allows up to a year).
function syncRangeLimits() {
  const start = rangeStartDateInput.value;
  rangeEndDateInput.min = start;
  rangeEndDateInput.removeAttribute("max");

  if (start && rangeEndDateInput.value && rangeEndDateInput.value < start) {
    rangeEndDateInput.value = start;
  }
}

rangeStartDateInput?.addEventListener("change", () => {
  syncRangeLimits();
  updateStep2Visibility();
});
rangeEndDateInput?.addEventListener("change", () => {
  syncRangeLimits();
  updateStep2Visibility();
});
syncRangeLimits();

updateStep2Visibility();

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

// Bulk-selection state: which slot ids are checked, and the last-loaded rows keyed by
// id (so the bulk toolbar can tell whether any selected slot is currently disabled).
const selectedIds = new Set();
const slotsById = new Map();

const selectAllCheckbox = document.getElementById("selectAllSlots");
const bulkToolbar = document.getElementById("bulkToolbar");
const bulkSelectedCount = document.getElementById("bulkSelectedCount");
const bulkEnableBtn = document.getElementById("bulkEnableBtn");
const emptySlotsMessage = document.getElementById("emptySlotsMessage");
const toastContainer = document.getElementById("toastContainer");

function slotRowHtml(row) {
  const isDisabled = row.Status === "DISABLED";
  return `
    <tr class="${isDisabled ? "table-row-disabled" : ""}">
      <td>
        <input type="checkbox" class="form-check-input slot-checkbox" data-id="${row.AvailabilityId}"
          aria-label="Select slot on ${row.AvailableDate} at ${formatTime12h(row.StartTime)}" />
      </td>
      <td>${row.AvailableDate}</td>
      <td>${formatTime12h(row.StartTime)}</td>
      <td>${formatTime12h(row.EndTime)}</td>
      <td>
        ${row.IsBooked ? `<span class="badge text-bg-success">Booked</span>` : `<span class="badge text-bg-secondary">Available</span>`}
        ${isDisabled ? `<span class="badge text-bg-dark ms-1">Disabled</span>` : ""}
      </td>
      <td>
        <button type="button" class="btn btn-sm btn-outline-danger" data-action="delete" data-id="${row.AvailabilityId}" aria-label="Delete slot" title="Delete">&#128465;&#65039;</button>
        ${
          isDisabled
            ? `<button type="button" class="btn btn-sm btn-outline-success" data-action="enable" data-id="${row.AvailabilityId}" aria-label="Enable slot" title="Enable">&#8635;</button>`
            : `<button type="button" class="btn btn-sm btn-outline-secondary" data-action="disable" data-id="${row.AvailabilityId}" aria-label="Disable slot" title="Disable">&#10134;</button>`
        }
      </td>
    </tr>
  `;
}

function updateSelectAllState() {
  if (!selectAllCheckbox) return;
  const total = slotsById.size;
  const checkedCount = selectedIds.size;
  selectAllCheckbox.checked = total > 0 && checkedCount === total;
  selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < total;
}

function updateBulkToolbar() {
  const count = selectedIds.size;
  if (count === 0) {
    bulkToolbar.classList.add("d-none");
    return;
  }

  bulkToolbar.classList.remove("d-none");
  bulkSelectedCount.textContent = `${count} selected`;

  const anyDisabled = [...selectedIds].some((id) => slotsById.get(id)?.Status === "DISABLED");
  bulkEnableBtn.classList.toggle("d-none", !anyDisabled);
}

async function loadAvailability() {
  const response = await fetch("/api/availability", { credentials: "include" });
  const result = await response.json();
  if (!response.ok) return;

  const slots = result.data.availability;

  slotsById.clear();
  slots.forEach((row) => slotsById.set(row.AvailabilityId, row));
  // Drop selections for slots that no longer exist (deleted / disappeared on reload).
  for (const id of selectedIds) {
    if (!slotsById.has(id)) selectedIds.delete(id);
  }

  emptySlotsMessage?.classList.toggle("d-none", slots.length > 0);

  // Build each row's HTML once via array + join (avoids O(n^2) string concatenation),
  // then a single innerHTML assignment — O(n) overall for n slots.
  listBody.innerHTML = slots.map(slotRowHtml).join("");

  listBody.querySelectorAll(".slot-checkbox").forEach((checkbox) => {
    checkbox.checked = selectedIds.has(Number(checkbox.dataset.id));
  });

  updateSelectAllState();
  updateBulkToolbar();
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
  selectedIds.delete(id);
  loadAvailability();
}

async function toggleSlotStatus(id, disable) {
  const response = await fetch(`/api/availability/${id}/${disable ? "disable" : "enable"}`, {
    method: "POST",
    credentials: "include",
  });
  const result = await response.json();

  showAlert(feedback, result.message, response.ok ? "success" : "danger");
  if (response.ok) loadAvailability();
}

// Single delegated listener handles Delete/Disable/Enable for every row — O(1) listeners
// regardless of how many slots are rendered, instead of one listener per button.
listBody?.addEventListener("click", (event) => {
  const deleteBtn = event.target.closest('button[data-action="delete"]');
  if (deleteBtn) {
    deleteSlot(Number(deleteBtn.dataset.id));
    return;
  }

  const disableBtn = event.target.closest('button[data-action="disable"]');
  if (disableBtn) {
    toggleSlotStatus(Number(disableBtn.dataset.id), true);
    return;
  }

  const enableBtn = event.target.closest('button[data-action="enable"]');
  if (enableBtn) {
    toggleSlotStatus(Number(enableBtn.dataset.id), false);
  }
});

listBody?.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".slot-checkbox");
  if (!checkbox) return;

  const id = Number(checkbox.dataset.id);
  if (checkbox.checked) selectedIds.add(id);
  else selectedIds.delete(id);

  updateSelectAllState();
  updateBulkToolbar();
});

selectAllCheckbox?.addEventListener("change", (event) => {
  const checked = event.target.checked;
  listBody.querySelectorAll(".slot-checkbox").forEach((checkbox) => {
    checkbox.checked = checked;
    const id = Number(checkbox.dataset.id);
    if (checked) selectedIds.add(id);
    else selectedIds.delete(id);
  });

  updateSelectAllState();
  updateBulkToolbar();
});

document.getElementById("bulkClearBtn")?.addEventListener("click", () => {
  selectedIds.clear();
  listBody.querySelectorAll(".slot-checkbox").forEach((checkbox) => (checkbox.checked = false));
  updateSelectAllState();
  updateBulkToolbar();
});

// Shows a small "N slots disabled/enabled" toast with an Undo link, auto-dismissed after
// 5 seconds — mirrors Gmail's archive/delete undo pattern for the no-confirmation actions.
let undoTimeoutHandle;
function showUndoToast(message, undo) {
  clearTimeout(undoTimeoutHandle);
  toastContainer.innerHTML = `
    <div class="admin-toast" role="status">
      <span>${message}</span>
      <button type="button" class="btn btn-sm btn-link p-0" id="toastUndoBtn">Undo</button>
    </div>
  `;

  document.getElementById("toastUndoBtn")?.addEventListener("click", async () => {
    clearTimeout(undoTimeoutHandle);
    toastContainer.innerHTML = "";
    await undo();
  });

  undoTimeoutHandle = setTimeout(() => {
    toastContainer.innerHTML = "";
  }, 5000);
}

async function bulkDelete() {
  const ids = [...selectedIds];
  if (ids.length === 0) return;
  if (!confirm(`Delete ${ids.length} slot(s)? This cannot be undone.`)) return;

  const response = await fetch("/api/availability", {
    method: "DELETE",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  const result = await response.json();

  if (!response.ok) {
    showAlert(feedback, result.message, "danger");
    return;
  }

  const { deleted = [], disabled = [], notFound = [] } = result.data || {};
  showAlert(feedback, result.message, disabled.length || notFound.length ? "warning" : "success");

  selectedIds.clear();
  await loadAvailability();
}

async function bulkSetStatus(isDisabled) {
  const ids = [...selectedIds];
  if (ids.length === 0) return;

  const response = await fetch("/api/availability/status", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, isDisabled }),
  });
  const result = await response.json();

  if (!response.ok) {
    showAlert(feedback, result.message, "danger");
    return;
  }

  const count = result.data?.updated ?? ids.length;
  selectedIds.clear();
  await loadAvailability();

  showUndoToast(`${count} slot${count === 1 ? "" : "s"} ${isDisabled ? "disabled" : "enabled"}`, async () => {
    await fetch("/api/availability/status", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, isDisabled: !isDisabled }),
    });
    await loadAvailability();
  });
}

document.getElementById("bulkDeleteBtn")?.addEventListener("click", bulkDelete);
document.getElementById("bulkDisableBtn")?.addEventListener("click", () => bulkSetStatus(true));
bulkEnableBtn?.addEventListener("click", () => bulkSetStatus(false));

// The feedback box sits at the top of the page but the submit button is far below it,
// so bring the message into view or the button looks like it did nothing.
function showFormAlert(message, type, autoCloseMs) {
  showAlert(feedback, message, type, autoCloseMs);
  feedback.scrollIntoView({ behavior: "smooth", block: "start" });
}

availabilityForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  // "Now" may have moved on since the form was filled in.
  clampAllTodayRows();

  const overMidnight = Array.from(document.querySelectorAll("#weeklySchedule > [data-day]:not([hidden]) .time-row")).filter(
    (row) => document.getElementById(`day-enabled-${row.closest("[data-day]").dataset.day}`).checked && rowCrossesMidnight(row)
  );
  if (overMidnight.length > 0) {
    showFormAlert("A slot can't run past midnight. Choose an earlier start time or a shorter duration for the rows marked \"Past midnight\".", "danger");
    return;
  }

  const weeklySchedule = WEEK_DAYS.map((day) => {
    const inRangeDay = !weeklyScheduleBox.querySelector(`[data-day="${day.dow}"]`).hidden;
    const enabled = inRangeDay && document.getElementById(`day-enabled-${day.dow}`).checked;
    const times = enabled
      ? Array.from(document.querySelectorAll(`#day-times-${day.dow} .time-row`)).map((row) => getRowStartTime24(row))
      : [];
    return { dayOfWeek: day.dow, enabled: enabled && times.length > 0, times };
  });

  if (!weeklySchedule.some((day) => day.enabled)) {
    showFormAlert("Enable at least one day and add at least one time for it.", "danger");
    return;
  }

  const payload = {
    startDate: rangeStartDateInput.value,
    endDate: rangeEndDateInput.value,
    durationMinutes: Number(durationSelect.value),
    meetingPlatform: document.getElementById("meetingPlatform").value,
    meetingLink: document.getElementById("meetingLink").value.trim() || null,
    status: document.getElementById("status").value,
    weeklySchedule,
  };

  const submitBtn = availabilityForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  let response;
  let result;
  try {
    response = await fetch("/api/availability/weekly", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    result = await response.json();
  } catch (error) {
    showFormAlert("Could not generate slots — the server returned an unexpected response. Please try again.", "danger");
    return;
  } finally {
    submitBtn.disabled = false;
  }

  if (response.status === 401) {
    window.location.href = "/admin-login.html";
    return;
  }

  showFormAlert(result.message, response.ok ? "success" : "danger");

  if (response.ok) {
    if (result.data?.skipped?.length) {
      showFormAlert(
        `${result.message}. Skipped: ${result.data.skipped
          .slice(0, 5)
          .map((s) => `${s.date} ${s.startTime} (${s.reason})`)
          .join("; ")}${result.data.skipped.length > 5 ? `; …and ${result.data.skipped.length - 5} more` : ""}`,
        "warning",
        0
      );
    }
    rangeStartDateInput.value = getNowIST().dateStr;
    rangeEndDateInput.value = "";
    syncRangeLimits();
    document.getElementById("meetingLink").value = "";
    updateStep2Visibility();
    loadAvailability();
  }
});

(async () => {
  await ensureAdmin();
  await loadBookingSettings();
  await loadAvailability();
})();
