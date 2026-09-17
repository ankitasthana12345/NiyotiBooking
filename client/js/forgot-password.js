const forgotForm = document.getElementById("forgotForm");
const feedback = document.getElementById("feedback");

forgotForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  feedback.textContent = "";

  const response = await fetch("/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: document.getElementById("email").value.trim() }),
  });

  const result = await response.json();
  showAlert(feedback, result.message, response.ok ? "success" : "danger");
});
