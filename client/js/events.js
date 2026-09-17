async function ensureAdmin() {
  const response = await fetch("/api/auth/me", { credentials: "include" });
  if (!response.ok) window.location.href = "/admin-login.html";
}

document.getElementById("logoutBtn")?.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  window.location.href = "/admin-login.html";
});

const form = document.getElementById("eventForm");
const feedback = document.getElementById("feedback");
const listBody = document.getElementById("eventsBody");

async function loadEvents() {
  const response = await fetch("/api/events", { credentials: "include" });
  const result = await response.json();
  if (!response.ok) return;

  listBody.innerHTML = result.data.events
    .map(
      (event) => `
      <tr>
        <td>${event.EventId}</td>
        <td>${event.Title}</td>
        <td>${event.DurationMinutes}m</td>
        <td>${event.MeetingPlatform}</td>
        <td>${event.IsPaid ? `${event.Currency} ${event.Price}` : "Free"}</td>
        <td>${event.RequiresApproval ? "Yes" : "No"}</td>
        <td>${event.IsActive ? "Active" : "Disabled"}</td>
        <td>
          <button type="button" class="btn btn-sm btn-outline-primary" data-action="edit" data-id="${event.EventId}">Edit</button>
          <button type="button" class="btn btn-sm btn-outline-danger" data-action="delete" data-id="${event.EventId}">Delete</button>
        </td>
      </tr>
    `
    )
    .join("");

  window.cachedEvents = result.data.events;
}

function editEvent(eventId) {
  const event = (window.cachedEvents || []).find((x) => Number(x.EventId) === eventId);
  if (!event) return;

  document.getElementById("eventId").value = event.EventId;
  document.getElementById("title").value = event.Title;
  document.getElementById("description").value = event.Description || "";
  document.getElementById("durationMinutes").value = event.DurationMinutes;
  document.getElementById("bufferBeforeMinutes").value = event.BufferBeforeMinutes;
  document.getElementById("bufferAfterMinutes").value = event.BufferAfterMinutes;
  document.getElementById("meetingPlatform").value = event.MeetingPlatform;
  document.getElementById("meetingLink").value = event.MeetingLink || "";
  document.getElementById("isPaid").checked = Boolean(event.IsPaid);
  document.getElementById("price").value = event.Price;
  document.getElementById("currency").value = event.Currency;
  document.getElementById("requiresApproval").checked = Boolean(event.RequiresApproval);
  document.getElementById("notificationEmail").value = event.NotificationEmail || "";
  document.getElementById("isActive").checked = Boolean(event.IsActive);
}

async function deleteEvent(eventId) {
  if (!confirm("Delete this event?")) return;
  const response = await fetch(`/api/events/${eventId}`, {
    method: "DELETE",
    credentials: "include",
  });

  const result = await response.json();
  showAlert(feedback, result.message, response.ok ? "success" : "danger");
  if (response.ok) loadEvents();
}

listBody?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const id = Number(button.dataset.id);
  if (button.dataset.action === "edit") editEvent(id);
  else if (button.dataset.action === "delete") deleteEvent(id);
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    title: document.getElementById("title").value.trim(),
    description: document.getElementById("description").value.trim(),
    durationMinutes: Number(document.getElementById("durationMinutes").value),
    bufferBeforeMinutes: Number(document.getElementById("bufferBeforeMinutes").value || 0),
    bufferAfterMinutes: Number(document.getElementById("bufferAfterMinutes").value || 0),
    meetingPlatform: document.getElementById("meetingPlatform").value,
    meetingLink: document.getElementById("meetingLink").value.trim() || null,
    isPaid: document.getElementById("isPaid").checked,
    price: Number(document.getElementById("price").value || 0),
    currency: document.getElementById("currency").value.trim().toUpperCase() || "INR",
    requiresApproval: document.getElementById("requiresApproval").checked,
    notificationEmail: document.getElementById("notificationEmail").value.trim() || null,
    isActive: document.getElementById("isActive").checked,
  };

  const eventId = document.getElementById("eventId").value;
  const endpoint = eventId ? `/api/events/${eventId}` : "/api/events";
  const method = eventId ? "PUT" : "POST";

  const response = await fetch(endpoint, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  showAlert(feedback, result.message, response.ok ? "success" : "danger");

  if (response.ok) {
    form.reset();
    document.getElementById("eventId").value = "";
    loadEvents();
  }
});

(async () => {
  await ensureAdmin();
  await loadEvents();
})();
