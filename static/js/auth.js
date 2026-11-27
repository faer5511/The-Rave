/* Модальные вход/регистрация и состояние сессии текущего пользователя. */
import { getCsrfToken } from "./csrf.js";

const AUTH_MODAL_HTML = `
  <div class="ov" id="authModal" aria-hidden="true">
    <div class="modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="authTitle">
      <button class="x" id="authClose" type="button" aria-label="Закрыть">✕</button>
      <div class="auth-tabs">
        <button type="button" class="on" id="loginTab">Вход</button>
        <button type="button" id="registerTab">Регистрация</button>
      </div>
      <h3 id="authTitle">Вход</h3>
      <form id="authLoginForm" novalidate>
        <div class="field"><label for="authLogin">Логин или email</label><input id="authLogin" autocomplete="username" required></div>
        <div class="field"><label for="authPassword">Пароль</label><input id="authPassword" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-red btn-lg" type="submit">Войти</button>
        <p class="auth-message" id="authLoginMessage"></p>
        <button class="btn btn-ghost wide resend-link" id="authResend" type="button">Получить код подтверждения</button>
      </form>
      <form id="authRegisterForm" class="hide" novalidate>
        <div class="field"><label for="regName">Имя</label><input id="regName" autocomplete="name" required minlength="2" maxlength="120"></div>
        <div class="field"><label for="regLogin">Логин</label><input id="regLogin" autocomplete="username" required minlength="3" maxlength="64"></div>
        <div class="field"><label for="regEmail">Email</label><input id="regEmail" type="email" autocomplete="email" required maxlength="200"></div>
        <div class="field"><label for="regPassword">Пароль</label><input id="regPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></div>
        <div class="field"><label for="regPassword2">Повторите пароль</label><input id="regPassword2" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></div>
        <button class="btn btn-red btn-lg" type="submit">Зарегистрироваться</button>
        <p class="auth-message" id="authRegisterMessage"></p>
      </form>
      <form id="authVerifyForm" class="hide" novalidate>
        <p class="auth-message">Введите код из письма. Он действует 10 минут.</p>
        <div class="field"><label for="authVerifyEmail">Email</label><input id="authVerifyEmail" type="email" autocomplete="email" required maxlength="200"></div>
        <div class="field"><label for="authVerifyCode">Код из письма</label><input id="authVerifyCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></div>
        <button class="btn btn-red btn-lg" type="submit">Подтвердить email</button>
        <p class="auth-message" id="authVerifyMessage"></p>
        <button class="btn btn-ghost wide" id="authVerifyResend" type="button">Отправить код повторно</button>
        <button class="btn btn-ghost wide" id="authVerifyBack" type="button">Вернуться ко входу</button>
      </form>
      <div id="authProfile" class="hide">
        <p class="profile-name" id="profileName"></p>
        <p class="profile-detail" id="profileLogin"></p>
        <p class="profile-detail" id="profileEmail"></p>
      </div>
    </div>
  </div>`;

(function initAuth() {
  "use strict";
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  document.body.insertAdjacentHTML("beforeend", AUTH_MODAL_HTML);

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
  let isAdmin = false;
  const profileUpdates =
    "BroadcastChannel" in window
      ? new BroadcastChannel("rave-admin-profile")
      : null;

  function openModal(tab) {
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    window.lockPageScroll();
    setTab(tab === "register" ? "register" : "login");
  }

  function closeModal() {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    window.unlockPageScroll();
  }

  function setTab(tab) {
    const register = tab === "register";
    const verify = tab === "verify";
    document.querySelector("#authProfile").classList.add("hide");
    document
      .querySelector("#authLoginForm")
      .classList.toggle("hide", register || verify || tab === "profile");
    document
      .querySelector("#authRegisterForm")
      .classList.toggle("hide", !register || verify || tab === "profile");
    document.querySelector("#authVerifyForm").classList.toggle("hide", !verify);
    document.querySelector("#loginTab").classList.toggle("on", !register);
    document.querySelector("#registerTab").classList.toggle("on", register);
    document
      .querySelector(".auth-tabs")
      .classList.toggle("hide", tab === "profile" || verify);
    document.querySelector("#authTitle").textContent =
      tab === "profile"
        ? "Профиль"
        : verify
          ? "Подтвердите email"
          : register
            ? "Регистрация"
            : "Вход";
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
      isAdmin = false;
      openButton.classList.remove("hide");
      menu.classList.add("hide");
      return;
    }
    isAdmin = data.user.role === "admin";
    openButton.classList.add("hide");
    menu.classList.remove("hide");
    const displayName = isAdmin
      ? data.user.login
      : data.user.name || data.user.login;
    document.querySelector("#userName").textContent = displayName;
    const avatar = document.querySelector("#userAvatar");
    avatar.replaceChildren();
    if (isAdmin && data.user.avatar_url) {
      const image = document.createElement("img");
      image.src = data.user.avatar_url;
      image.alt = "";
      avatar.append(image);
    } else {
      avatar.textContent = displayName.trim().charAt(0).toUpperCase();
    }
    document.querySelector("#profileName").textContent = displayName;
    document.querySelector("#profileLogin").textContent =
      "Логин: " + data.user.login;
    document.querySelector("#profileEmail").textContent =
      "Email: " + data.user.email;
    document.querySelector("#profileBtn").textContent = isAdmin
      ? "Панель управления"
      : "Профиль";
  }

  if (profileUpdates) {
    profileUpdates.addEventListener("message", () => {
      loadUser().catch((error) =>
        console.error("Не удалось обновить профиль администратора", error),
      );
    });
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
    if (isAdmin) {
      location.assign("/admin");
      return;
    }
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
      if (name.length < 2 || name.length > 120) {
        message.textContent = "Введите имя (от 2 до 120 символов).";
        return;
      }
      if (!loginPattern.test(login)) {
        message.textContent =
          "Логин: 3–64 символа, латинские буквы, цифры, точка, дефис или подчёркивание.";
        return;
      }
      if (!EMAIL_PATTERN.test(email) || email.length > 200) {
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
        const verificationEmail = document
          .querySelector("#regEmail")
          .value.trim();
        document.querySelector("#regPassword").value = "";
        document.querySelector("#regPassword2").value = "";
        document.querySelector("#authVerifyEmail").value = verificationEmail;
        document.querySelector("#authVerifyCode").value = "";
        setTab("verify");
        document.querySelector("#authVerifyMessage").textContent = data.message;
      } catch (error) {
        message.textContent = error.message;
      }
    });

  document
    .querySelector("#authVerifyForm")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = document.querySelector("#authVerifyEmail").value.trim();
      const code = document.querySelector("#authVerifyCode").value.trim();
      const message = document.querySelector("#authVerifyMessage");
      message.textContent = "";
      if (!EMAIL_PATTERN.test(email)) {
        message.textContent = "Проверьте email.";
        return;
      }
      if (!/^\d{6}$/.test(code)) {
        message.textContent = "Введите шестизначный код из письма.";
        return;
      }
      try {
        const data = await api("/api/auth/verify-email/code", { email, code });
        setTab("login");
        document.querySelector("#authLogin").value = email;
        document.querySelector("#authLoginMessage").textContent = data.message;
      } catch (error) {
        message.textContent = error.message;
      }
    });

  document
    .querySelector("#authVerifyResend")
    .addEventListener("click", async () => {
      const email = document.querySelector("#authVerifyEmail").value.trim();
      const message = document.querySelector("#authVerifyMessage");
      if (!EMAIL_PATTERN.test(email)) {
        message.textContent = "Проверьте email.";
        return;
      }
      try {
        const data = await api("/api/auth/resend", { email });
        message.textContent = data.message;
      } catch (error) {
        message.textContent = error.message;
      }
    });

  document.querySelector("#authVerifyBack").addEventListener("click", () => {
    const email = document.querySelector("#authVerifyEmail").value.trim();
    setTab("login");
    document.querySelector("#authLogin").value = email;
  });

  document.querySelector("#authResend").addEventListener("click", async () => {
    const email = document.querySelector("#authLogin").value.trim();
    if (!EMAIL_PATTERN.test(email)) {
      document.querySelector("#authLoginMessage").textContent =
        "Введите email для повторной отправки.";
      return;
    }
    try {
      const data = await api("/api/auth/resend", { email });
      document.querySelector("#authVerifyEmail").value = email;
      document.querySelector("#authVerifyCode").value = "";
      setTab("verify");
      document.querySelector("#authVerifyMessage").textContent = data.message;
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
