/* Модальные вход/регистрация и состояние сессии текущего пользователя. */
import { getCsrfToken } from "./csrf.js";

(function initAuth() {
  "use strict";

  async function api(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": await getCsrfToken(),
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.message || "Ошибка запроса");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  const modal = document.querySelector("#authModal");
  const openButton = document.querySelector("#authOpen");
  const closeButton = document.querySelector("#authClose");

  function openModal(tab) {
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("lock");
    setTab(tab === "register" ? "register" : "login");
  }

  function closeModal() {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("lock");
  }

  function setTab(tab) {
    const register = tab === "register";
    document.querySelector("#authProfile").classList.add("hide");
    document
      .querySelector("#authLoginForm")
      .classList.toggle("hide", register || tab === "profile");
    document
      .querySelector("#authRegisterForm")
      .classList.toggle("hide", !register || tab === "profile");
    document.querySelector("#loginTab").classList.toggle("on", !register);
    document.querySelector("#registerTab").classList.toggle("on", register);
    document
      .querySelector(".auth-tabs")
      .classList.toggle("hide", tab === "profile");
    document.querySelector("#authTitle").textContent =
      tab === "profile" ? "Профиль" : register ? "Регистрация" : "Вход";
    document
      .querySelector("#authProfile")
      .classList.toggle("hide", tab !== "profile");
  }

  openButton.addEventListener("click", () => openModal("login"));
  closeButton.addEventListener("click", closeModal);
  modal.addEventListener("mousedown", (event) => {
    if (event.target === modal) closeModal();
  });
  document
    .querySelector("#loginTab")
    .addEventListener("click", () => setTab("login"));
  document
    .querySelector("#registerTab")
    .addEventListener("click", () => setTab("register"));

  async function loadUser() {
    const response = await fetch("/api/auth/me");
    const data = await response.json();
    const menu = document.querySelector("#userMenu");
    if (!data.authenticated) {
      openButton.classList.remove("hide");
      menu.classList.add("hide");
      return;
    }
    openButton.classList.add("hide");
    menu.classList.remove("hide");
    document.querySelector("#userName").textContent =
      data.user.name || data.user.login;
    document.querySelector("#userAvatar").textContent = (
      data.user.name || data.user.login
    )
      .trim()
      .charAt(0)
      .toUpperCase();
    document.querySelector("#profileName").textContent =
      data.user.name || data.user.login;
    document.querySelector("#profileLogin").textContent =
      "Логин: " + data.user.login;
    document.querySelector("#profileEmail").textContent =
      "Email: " + data.user.email;
  }

  document
    .querySelector("#userMenuToggle")
    .addEventListener("click", (event) => {
      event.stopPropagation();
      const dropdown = document.querySelector("#userDropdown");
      const hidden = dropdown.classList.toggle("hide");
      event.currentTarget.setAttribute("aria-expanded", String(!hidden));
    });
  document.addEventListener("click", () => {
    document.querySelector("#userDropdown").classList.add("hide");
  });
  document.querySelector("#profileBtn").addEventListener("click", () => {
    document.querySelector("#userDropdown").classList.add("hide");
    openModal("profile");
  });
  document.querySelector("#logoutBtn").addEventListener("click", async () => {
    await api("/api/auth/logout", {});
    location.reload();
  });

  document
    .querySelector("#authLoginForm")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = document.querySelector("#authLoginMessage");
      message.textContent = "";
      const login = document.querySelector("#authLogin").value.trim();
      const password = document.querySelector("#authPassword").value;
      if (!login || !password) {
        message.textContent = "Введите логин или email и пароль.";
        return;
      }
      try {
        await api("/api/auth/login", {
          login,
          password,
        });
        location.reload();
      } catch (error) {
        message.textContent = error.message;
      }
    });

  document
    .querySelector("#authRegisterForm")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = document.querySelector("#authRegisterMessage");
      message.textContent = "";
      const password = document.querySelector("#regPassword").value;
      const password2 = document.querySelector("#regPassword2").value;
      const name = document.querySelector("#regName").value.trim();
      const login = document.querySelector("#regLogin").value.trim();
      const email = document.querySelector("#regEmail").value.trim();
      const loginPattern = /^[A-Za-z0-9_.@-]{3,64}$/;
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
      if (name.length < 2 || name.length > 120) {
        message.textContent = "Введите имя (от 2 до 120 символов).";
        return;
      }
      if (!loginPattern.test(login)) {
        message.textContent =
          "Логин: 3–64 символа, латинские буквы, цифры, точка, дефис или подчёркивание.";
        return;
      }
      if (!emailPattern.test(email) || email.length > 200) {
        message.textContent = "Проверьте email.";
        return;
      }
      const passwordBytes = new TextEncoder().encode(password).length;
      if (
        passwordBytes < 8 ||
        passwordBytes > 72 ||
        new Set(password).size < 3
      ) {
        message.textContent =
          "Пароль должен содержать не менее 8 символов и занимать не более 72 байт.";
        return;
      }
      if (password !== password2) {
        message.textContent = "Пароли не совпадают";
        return;
      }
      try {
        const data = await api("/api/auth/register", {
          name,
          login,
          email,
          password,
          password2,
        });
        message.textContent = data.message;
        setTab("login");
        document.querySelector("#authLogin").value =
          document.querySelector("#regEmail").value;
      } catch (error) {
        message.textContent = error.message;
      }
    });

  document.querySelector("#authResend").addEventListener("click", async () => {
    const email = document.querySelector("#authLogin").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      document.querySelector("#authLoginMessage").textContent =
        "Введите email для повторной отправки.";
      return;
    }
    try {
      const data = await api("/api/auth/resend", { email });
      document.querySelector("#authLoginMessage").textContent = data.message;
    } catch (error) {
      document.querySelector("#authLoginMessage").textContent = error.message;
    }
  });

  async function verifyEmailFromUrl() {
    const token = new URLSearchParams(location.search).get("verify");
    if (!token) return;
    try {
      const data = await api("/api/auth/verify-email", { token });
      if (window.toast) window.toast(data.message);
      openModal("login");
    } catch (error) {
      openModal("login");
      document.querySelector("#authLoginMessage").textContent = error.message;
    }
  }

  loadUser();
  verifyEmailFromUrl();
})();
