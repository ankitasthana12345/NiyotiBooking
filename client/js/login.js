const loginForm = document.getElementById("loginForm");
const feedback = document.getElementById("feedback");

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  feedback.textContent = "";

  const payload = {
    email: document.getElementById("email").value.trim(),
    password: document.getElementById("password").value,
  };

  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  if (!response.ok) {
    showAlert(feedback, result.message, "danger");
    return;
  }

  window.location.href = "/admin-dashboard.html";
});
