// Escapes user-supplied text before it is placed into innerHTML.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function formatTime12h(timeStr) {
  if (!timeStr) return "";

  const [hoursStr, minutesStr] = timeStr.split(":");
  let hours = Number(hoursStr);
  const minutes = minutesStr || "00";
  const period = hours >= 12 ? "PM" : "AM";

  hours = hours % 12;
  if (hours === 0) hours = 12;

  return `${hours}:${minutes} ${period}`;
}

// Renders a dismissible feedback message into `container` (a close "x" button, no
// dependency on Bootstrap's JS bundle since we wire the click ourselves) and,
// unless autoCloseMs is 0, removes it on its own after that delay.
function showAlert(container, message, type = "info", autoCloseMs = 6000) {
  if (!container) return;

  container.innerHTML = `
    <div class="alert alert-${type} alert-dismissible fade show" role="alert">
      <div>${message}</div>
      <button type="button" class="btn-close" data-action="dismiss-alert" aria-label="Close"></button>
    </div>
  `;

  const alertEl = container.querySelector(".alert");
  if (!alertEl) return;

  const dismiss = () => alertEl.remove();
  alertEl.querySelector('[data-action="dismiss-alert"]')?.addEventListener("click", dismiss);

  if (autoCloseMs > 0) {
    setTimeout(() => {
      if (document.body.contains(alertEl)) dismiss();
    }, autoCloseMs);
  }
}
