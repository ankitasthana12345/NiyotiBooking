const resetForm = document.getElementById("resetForm");
const feedback = document.getElementById("feedback");
const params = new URLSearchParams(window.location.search);

document.getElementById("token").value = params.get("token") || "";

resetForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  feedback.textContent = "";

  const payload = {
    token: document.getElementById("token").value.trim(),
    newPassword: document.getElementById("newPassword").value,
  };

  const response = await fetch("/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  if (!response.ok) {
    showAlert(feedback, result.message, "danger");
    return;
  }

  showAlert(feedback, result.message, "success", 0);
  setTimeout(() => {
    window.location.href = "/admin-login.html";
  }, 1000);
});
