import { getCsrfToken } from "./csrf.js";

(async function initAdminLogin() {
  const form = document.querySelector("#adminLogin");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const response = await fetch("/api/auth/admin/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": await getCsrfToken(),
      },
      body: JSON.stringify({
        login: document.querySelector("#login").value,
        password: document.querySelector("#password").value,
      }),
    });
    const data = await response.json();
    if (response.ok) {
      location.href = "/admin";
      return;
    }
    document.querySelector("#message").textContent =
      data.message || "Неверный логин или пароль";
  });
})();
