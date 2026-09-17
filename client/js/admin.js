async function requireAdminSession() {
  const response = await fetch("/api/auth/me", { credentials: "include" });
  if (!response.ok) {
    window.location.href = "/admin-login.html";
    return null;
  }

  return response.json();
}

async function logoutAdmin() {
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
  });
  window.location.href = "/admin-login.html";
}

document.getElementById("logoutBtn")?.addEventListener("click", logoutAdmin);

async function loadDashboard() {
  const metricsBox = document.getElementById("metrics");
  const recentBody = document.getElementById("recentBookingsBody");
  if (!metricsBox || !recentBody) return;

  const response = await fetch("/api/admin/dashboard", { credentials: "include" });
  if (!response.ok) {
    metricsBox.innerHTML = "<div class='alert alert-danger'>Failed to load dashboard</div>";
    return;
  }

  const result = await response.json();
  const metrics = result.data.metrics;
  metricsBox.innerHTML = `
    <div class="col-md-4 col-lg-2"><div class="card p-3"><div>Total Bookings</div><div class="metric-value">${metrics.TotalBookings}</div></div></div>
    <div class="col-md-4 col-lg-2"><div class="card p-3"><div>Today's Bookings</div><div class="metric-value">${metrics.TodaysBookings}</div></div></div>
    <div class="col-md-4 col-lg-2"><div class="card p-3"><div>Upcoming</div><div class="metric-value">${metrics.UpcomingBookings}</div></div></div>
    <div class="col-md-4 col-lg-2"><div class="card p-3"><div>Cancelled</div><div class="metric-value">${metrics.CancelledBookings}</div></div></div>
    <div class="col-md-4 col-lg-2"><div class="card p-3"><div>Rejected</div><div class="metric-value">${metrics.RejectedBookings}</div></div></div>
    <div class="col-md-4 col-lg-2"><div class="card p-3"><div>Rescheduled</div><div class="metric-value">${metrics.RescheduledBookings}</div></div></div>
  `;

  recentBody.innerHTML = result.data.recentBookings
    .map(
      (row) => `
      <tr>
        <td>${row.CustomerName}</td>
        <td>${row.CustomerEmail}</td>
        <td>${row.BookingDate} ${formatTime12h(row.StartTime)}</td>
        <td><span class="badge text-bg-secondary">${row.Status}</span></td>
      </tr>
    `
    )
    .join("");
}

(async () => {
  await requireAdminSession();
  await loadDashboard();
})();
