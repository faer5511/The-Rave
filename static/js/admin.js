import { getCsrfToken } from "./csrf.js";

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const rub = (n) => Number(n).toLocaleString("ru-RU") + " ₽";
const STR = {
  paid: "Оплачен",
  pending: "Ждёт оплаты",
  expired: "Истёк",
  refunded: "Возврат",
  cancelled: "Отменён",
};
const when = (iso) =>
  iso
    ? new Date(iso).toLocaleString("ru-RU", {
        timeZone: "Europe/Saratov",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
const toLocal = (iso) =>
  iso
    ? new Date(new Date(iso).getTime() + 4 * 36e5).toISOString().slice(0, 16)
    : ""; // Саратов UTC+4
const fromLocal = (v) => (v ? v + ":00+04:00" : null);
let tT;
function toast(m) {
  const t = $("#toast");
  t.textContent = m;
  t.classList.remove("hide");
  clearTimeout(tT);
  tT = setTimeout(() => t.classList.add("hide"), 3000);
}
async function api(path, method = "GET", body) {
  const headers = { "Content-Type": "application/json" };
  if (method !== "GET" && method !== "HEAD")
    headers["X-CSRF-Token"] = await getCsrfToken();
  const r = await fetch("/api/admin" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = {};
  try {
    j = await r.json();
  } catch (_) {}
  if (r.status === 401 && path !== "/login") {
    showLogin();
    throw new Error("Нужен вход");
  }
  if (!r.ok) throw new Error(j.message || "Ошибка " + r.status);
  return j;
}
async function uploadPoster() {
  const file = $("#posterFile").files[0];
  if (!file) throw new Error("Выберите изображение");

  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/admin/event/poster", {
    method: "POST",
    headers: { "X-CSRF-Token": await getCsrfToken() },
    body: form,
  });
  let result = {};
  try {
    result = await response.json();
  } catch (_) {}
  if (response.status === 401) {
    showLogin();
    throw new Error("Нужен вход");
  }
  if (!response.ok)
    throw new Error(result.message || "Ошибка " + response.status);

  $('[data-k="poster_url"]').value = result.poster_url;
  $("#posterFile").value = "";
}
const run = async (f, ok) => {
  try {
    await f();
    if (ok) toast(ok);
  } catch (e) {
    toast(e.message);
  }
};
function enhanceNumberInputs(root) {
  root.querySelectorAll('input[type="number"]').forEach((input) => {
    if (input.parentElement.classList.contains("number-stepper")) return;
    const wrapper = document.createElement("span");
    wrapper.className = "number-stepper";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.append(input);
    wrapper.insertAdjacentHTML(
      "beforeend",
      `<span class="number-stepper-controls">
        <button class="number-stepper-button" type="button" data-number-step="1" aria-label="Увеличить значение">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4"></path></svg>
        </button>
        <button class="number-stepper-button" type="button" data-number-step="-1" aria-label="Уменьшить значение">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"></path></svg>
        </button>
      </span>`,
    );
  });
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-number-step]");
  if (!button) return;
  const input = button.closest(".number-stepper").querySelector('input[type="number"]');
  if (input.disabled || input.readOnly) return;
  const rawStep = input.getAttribute("step");
  const parsedStep = rawStep === "any" ? 1 : Number(rawStep || 1);
  const step = Number.isFinite(parsedStep) && parsedStep > 0 ? parsedStep : 1;
  let value =
    (input.value === "" ? 0 : Number(input.value)) +
    step * Number(button.dataset.numberStep);
  if (input.min !== "") {
    const min = Number(input.min);
    if (Number.isFinite(min)) value = Math.max(value, min);
  }
  if (input.max !== "") {
    const max = Number(input.max);
    if (Number.isFinite(max)) value = Math.min(value, max);
  }
  const precision = Math.min(10, (String(step).split(".")[1] || "").length);
  input.value = String(Number(value.toFixed(precision)));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.focus();
});

/* ---- вход ---- */
function showLogin() {
  $("#app").classList.add("hide");
  $("#login").classList.remove("hide");
  $("#pw").focus();
}
$("#loginBtn").onclick = () =>
  run(async () => {
    await api("/login", "POST", { password: $("#pw").value });
    $("#pw").value = "";
    start();
  });
$("#pw").onkeydown = (e) => {
  if (e.key === "Enter") $("#loginBtn").click();
};
$("#logout").onclick = async () => {
  await api("/logout", "POST");
  showLogin();
};

/* ---- вкладки ---- */
const TABS = [
  ["orders", "Заказы"],
  ["cats", "Тарифы и цены"],
  ["promos", "Промокоды"],
  ["event", "Событие"],
  ["analytics", "Аналитика"],
];
const LOAD = {
  orders: loadOrders,
  cats: loadCats,
  promos: loadPromos,
  event: loadEvent,
  analytics: loadAnalytics,
};
function tab(id) {
  TABS.forEach(([k]) => $("#t-" + k).classList.toggle("hide", k !== id));
  $("#tabs").innerHTML = TABS.map(
    ([k, n]) =>
      `<button class="btn ${k === id ? "on" : ""}" data-t="${k}">${n}</button>`,
  ).join("");
  $("#tabs")
    .querySelectorAll("button")
    .forEach((b) => (b.onclick = () => tab(b.dataset.t)));
  run(LOAD[id]);
}
async function start() {
  try {
    await api("/me");
  } catch (_) {
    return showLogin();
  }
  $("#login").classList.add("hide");
  $("#app").classList.remove("hide");
  tab("orders");
  loadStats();
}
async function loadStats() {
  const s = await api("/stats");
  $("#kpis").innerHTML =
    `<div class="card kpi"><b>${rub(s.revenue)}</b><span>Выручка · ${s.paid_orders} оплач. заказов</span></div>` +
    s.categories
      .map(
        (c) =>
          `<div class="card kpi"><b>${c.sold} / ${c.capacity}</b><span>${esc(c.name)} · в резерве ${c.held} · свободно ${c.available}</span></div>`,
      )
      .join("");
}

let analyticsFrom = "";
let analyticsTo = "";
let analyticsPromo = "";
let analyticsInitialized = false;
let activeCalendar = null;
const padDatePart = (value) => String(value).padStart(2, "0");
const todayInSaratov = () =>
  new Date(Date.now() + 4 * 36e5).toISOString().slice(0, 10);
function formatAnalyticsDate(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}
function formatEventDateTime(value) {
  if (!value) return "";
  const [date, time = ""] = value.split("T");
  return `${formatAnalyticsDate(date)} ${time.slice(0, 5)}`.trim();
}
function parseAnalyticsDate(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  let year;
  let month;
  let day;
  let match = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (match) {
    [, day, month, year] = match;
  } else {
    match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!match) throw new Error("Введите дату в формате ДД.ММ.ГГГГ");
    [, year, month, day] = match;
  }
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const date = new Date(Date.UTC(numericYear, numericMonth - 1, numericDay));
  if (
    date.getUTCFullYear() !== numericYear ||
    date.getUTCMonth() !== numericMonth - 1 ||
    date.getUTCDate() !== numericDay
  )
    throw new Error("Проверьте введённую дату");
  return `${year}-${padDatePart(numericMonth)}-${padDatePart(numericDay)}`;
}
function datePickerElements(field, type) {
  if (type === "event") {
    return {
      input: $(`#event-${field}-display`),
      valueInput: $(`[data-k="${field}"]`),
      picker: $(`#event-${field}-picker`),
      trigger: $(`[data-event-calendar="${field}"]`),
    };
  }
  return {
    input: $(`#analytics-${field}`),
    picker: $(`#analytics-${field}-picker`),
    trigger: $(`[data-calendar="${field}"]`),
  };
}
function setEventDateTime(field, date, time) {
  const value = $(`[data-k="${field}"]`);
  value.value = date && time ? `${date}T${time}` : "";
  $(`#event-${field}-display`).value = formatEventDateTime(value.value);
}
function closeDatePicker(returnFocus = false) {
  if (!activeCalendar) return;
  const { field, type } = activeCalendar;
  const elements = datePickerElements(field, type);
  elements.picker.classList.add("hide");
  elements.picker.classList.remove("date-time-picker");
  elements.picker.classList.remove("open-above");
  elements.picker.innerHTML = "";
  elements.trigger.setAttribute("aria-expanded", "false");
  activeCalendar = null;
  if (returnFocus) elements.input.focus();
}
function renderDatePicker() {
  if (!activeCalendar) return;
  const { field, type, year, month } = activeCalendar;
  const elements = datePickerElements(field, type);
  const { input, picker, valueInput } = elements;
  let selectedDate = "";
  let selectedTime = "12:00";
  if (type === "event") {
    const [date, time] = valueInput.value.split("T");
    selectedDate = date || "";
    if (time) selectedTime = time.slice(0, 5);
  } else {
    try {
      selectedDate = parseAnalyticsDate(input.value);
    } catch (_) {}
  }
  const firstDay = new Date(Date.UTC(year, month, 1));
  const offset = (firstDay.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const monthLabel = firstDay.toLocaleDateString("ru-RU", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  let days = Array.from({ length: offset }, () => '<span class="date-picker-empty"></span>').join("");
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${year}-${padDatePart(month + 1)}-${padDatePart(day)}`;
    const classes = [
      "date-picker-day",
      iso === selectedDate ? "selected" : "",
      iso === todayInSaratov() ? "today" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const label = new Date(Date.UTC(year, month, day)).toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    days += `<button class="${classes}" type="button" data-date="${iso}" aria-label="${label}" aria-pressed="${iso === selectedDate}">${day}</button>`;
  }
  const calendar = `<div class="date-picker-calendar">
    <div class="date-picker-header">
      <button class="date-picker-nav" type="button" data-month="-1" aria-label="Предыдущий месяц"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9.5 3.5-4.5 4.5 4.5 4.5"></path></svg></button>
      <strong>${monthLabel}</strong>
      <button class="date-picker-nav" type="button" data-month="1" aria-label="Следующий месяц"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6.5 3.5 4.5 4.5-4.5 4.5"></path></svg></button>
    </div>
    <div class="date-picker-weekdays"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Вс</span></div>
    <div class="date-picker-days">${days}</div>
    <div class="date-picker-footer">
      <button type="button" data-clear>Очистить</button>
      <button type="button" data-today>Сегодня</button>
    </div>
  </div>`;
  const timeControls =
    type === "event"
      ? `<div class="date-picker-time">
          <strong>Время</strong>
          <div class="date-picker-time-controls">
            <label class="date-picker-time-control">Часы
              <input type="number" min="0" max="23" step="1" data-event-hour value="${selectedTime.slice(0, 2)}" aria-label="Часы">
            </label>
            <label class="date-picker-time-control">Минуты
              <input type="number" min="0" max="59" step="1" data-event-minute value="${selectedTime.slice(3, 5)}" aria-label="Минуты">
            </label>
          </div>
        </div>`
      : "";
  picker.innerHTML = `${calendar}${timeControls}`;
  picker.classList.toggle("date-time-picker", type === "event");
  picker.classList.remove("hide");
  enhanceNumberInputs(picker);
  const triggerRect = elements.trigger.getBoundingClientRect();
  const pickerRect = picker.getBoundingClientRect();
  const spaceAbove = triggerRect.top;
  const spaceBelow = window.innerHeight - triggerRect.bottom;
  picker.classList.toggle(
    "open-above",
    spaceBelow < pickerRect.height && spaceAbove > spaceBelow,
  );
  const readEventTime = (useFallback = true) => {
    const hourInput = picker.querySelector("[data-event-hour]");
    const minuteInput = picker.querySelector("[data-event-minute]");
    const hour = Number(hourInput.value);
    const minute = Number(minuteInput.value);
    if (
      !hourInput.value ||
      !minuteInput.value ||
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23 ||
      !Number.isInteger(minute) ||
      minute < 0 ||
      minute > 59
    )
      return (
        valueInput.value.split("T")[1]?.slice(0, 5) ||
        (useFallback ? selectedTime : "")
      );
    return `${padDatePart(hour)}:${padDatePart(minute)}`;
  };
  picker.querySelectorAll("[data-month]").forEach((button) => {
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const direction = Number(button.getAttribute("data-month"));
      const next = new Date(
        Date.UTC(activeCalendar.year, activeCalendar.month + direction, 1),
      );
      activeCalendar.year = next.getUTCFullYear();
      activeCalendar.month = next.getUTCMonth();
      renderDatePicker();
    };
  });
  picker.querySelectorAll("[data-date]").forEach((button) => {
    button.onclick = (event) => {
      if (type === "event") {
        event.stopPropagation();
        setEventDateTime(field, button.dataset.date, readEventTime());
        renderDatePicker();
        picker.querySelector(`[data-date="${button.dataset.date}"]`).focus();
      } else {
        input.value = formatAnalyticsDate(button.dataset.date);
        closeDatePicker(true);
      }
    };
  });
  picker.querySelector("[data-clear]").onclick = (event) => {
    if (type === "event") {
      event.stopPropagation();
      setEventDateTime(field, "", "");
      renderDatePicker();
      picker.querySelector("[data-clear]").focus();
    } else {
      input.value = "";
      closeDatePicker(true);
    }
  };
  picker.querySelector("[data-today]").onclick = (event) => {
    if (type === "event") {
      event.stopPropagation();
      setEventDateTime(field, todayInSaratov(), readEventTime());
      renderDatePicker();
      picker.querySelector("[data-today]").focus();
    } else {
      input.value = formatAnalyticsDate(todayInSaratov());
      closeDatePicker(true);
    }
  };
  if (type === "event") {
    const updateTime = () => {
      const time = readEventTime(false);
      if (!time) return;
      const date = valueInput.value.split("T")[0] || todayInSaratov();
      setEventDateTime(field, date, time);
      picker.querySelectorAll("[data-date]").forEach((day) => {
        const selected = day.dataset.date === date;
        day.classList.toggle("selected", selected);
        day.setAttribute("aria-pressed", String(selected));
      });
    };
    picker.querySelector("[data-event-hour]").oninput = updateTime;
    picker.querySelector("[data-event-minute]").oninput = updateTime;
  }
}
function closePromoPicker(returnFocus = false) {
  const picker = $("#analytics-promo-picker");
  if (!picker || picker.classList.contains("hide")) return;
  picker.classList.add("hide");
  $("#analytics-promo-trigger").setAttribute("aria-expanded", "false");
  if (returnFocus) $("#analytics-promo-trigger").focus();
}
function closePromoTypePicker(returnFocus = false) {
  const picker = $("#promo-kind-picker");
  if (!picker || picker.classList.contains("hide")) return;
  picker.classList.add("hide");
  $("#promo-kind-trigger").setAttribute("aria-expanded", "false");
  if (returnFocus) $("#promo-kind-trigger").focus();
}
function openDatePicker(field) {
  if (activeCalendar) closeDatePicker();
  closePromoPicker();
  const input = $(`#analytics-${field}`);
  let value = "";
  try {
    value = parseAnalyticsDate(input.value);
  } catch (error) {
    toast(error.message);
  }
  const selected = (value || todayInSaratov()).split("-").map(Number);
  activeCalendar = {
    field,
    type: "analytics",
    year: selected[0],
    month: selected[1] - 1,
  };
  datePickerElements(field, "analytics").trigger.setAttribute(
    "aria-expanded",
    "true",
  );
  renderDatePicker();
}
function openEventDatePicker(field) {
  if (activeCalendar) closeDatePicker();
  closePromoPicker();
  closePromoTypePicker();
  const value = $(`[data-k="${field}"]`).value.split("T")[0] || todayInSaratov();
  const [year, month] = value.split("-").map(Number);
  activeCalendar = {
    field,
    type: "event",
    year,
    month: month - 1,
  };
  datePickerElements(field, "event").trigger.setAttribute("aria-expanded", "true");
  renderDatePicker();
}
document.addEventListener("click", (event) => {
  if (
    activeCalendar &&
    !event.target.closest(".analytics-date-field, .event-datetime-field")
  )
    closeDatePicker();
  if (!event.target.closest(".analytics-promo-field")) closePromoPicker();
  if (!event.target.closest(".promo-type-field")) closePromoTypePicker();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && activeCalendar) closeDatePicker(true);
  if (event.key === "Escape") closePromoPicker(true);
  if (event.key === "Escape") closePromoTypePicker(true);
});

async function loadAnalytics() {
  if (!analyticsInitialized) {
    const today = todayInSaratov();
    analyticsFrom = analyticsFrom || today.slice(0, 8) + "01";
    analyticsTo = analyticsTo || today;
    analyticsInitialized = true;
  }
  const qs = new URLSearchParams();
  if (analyticsFrom) qs.set("date_from", analyticsFrom);
  if (analyticsTo) qs.set("date_to", analyticsTo);
  if (analyticsPromo) qs.set("promo_code", analyticsPromo);
  const data = await api("/analytics?" + qs);
  const promoCodes = [...new Set([...data.promo_codes, analyticsPromo].filter(Boolean))].sort();
  const promoOptions = [
    { code: "", label: "Все промокоды" },
    ...promoCodes.map((code) => ({ code, label: code })),
  ]
    .map(
      ({ code, label }) =>
        `<button class="promo-option ${code === analyticsPromo ? "selected" : ""}" type="button" role="option" aria-selected="${code === analyticsPromo}" data-promo-option="${esc(code)}">${esc(label)}</button>`,
    )
    .join("");
  $("#t-analytics").innerHTML =
    `<div class="card">
      <h2>Период продаж</h2>
      <div class="analytics-filters">
        <div class="analytics-date-field">
          <label for="analytics-from">С даты</label>
          <div class="date-entry"><input id="analytics-from" type="text" inputmode="numeric" maxlength="10" placeholder="ДД.ММ.ГГГГ" autocomplete="off" value="${formatAnalyticsDate(analyticsFrom)}">
            <button class="date-picker-trigger" type="button" data-calendar="from" aria-label="Выбрать начальную дату" aria-haspopup="dialog" aria-expanded="false">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"></rect><path d="M7.5 3.5v3M16.5 3.5v3M3.5 9.5h17"></path></svg>
            </button>
          </div>
          <div class="date-picker hide" id="analytics-from-picker" role="dialog" aria-label="Календарь начальной даты"></div>
        </div>
        <div class="analytics-date-field">
          <label for="analytics-to">По дату включительно</label>
          <div class="date-entry"><input id="analytics-to" type="text" inputmode="numeric" maxlength="10" placeholder="ДД.ММ.ГГГГ" autocomplete="off" value="${formatAnalyticsDate(analyticsTo)}">
            <button class="date-picker-trigger" type="button" data-calendar="to" aria-label="Выбрать конечную дату" aria-haspopup="dialog" aria-expanded="false">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"></rect><path d="M7.5 3.5v3M16.5 3.5v3M3.5 9.5h17"></path></svg>
            </button>
          </div>
          <div class="date-picker hide" id="analytics-to-picker" role="dialog" aria-label="Календарь конечной даты"></div>
        </div>
        <div class="analytics-promo-field">
          <label id="analytics-promo-label">Промокод</label>
          <button class="promo-picker-trigger" id="analytics-promo-trigger" type="button" aria-labelledby="analytics-promo-label analytics-promo-value" aria-haspopup="listbox" aria-expanded="false">
            <span id="analytics-promo-value">${esc(analyticsPromo || "Все промокоды")}</span>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 6 5 5 5-5"></path></svg>
          </button>
          <div class="promo-picker hide" id="analytics-promo-picker" role="listbox" aria-labelledby="analytics-promo-label">${promoOptions}</div>
        </div>
        <button class="btn red" id="analytics-apply" type="button">Показать</button>
      </div>
      <p class="analytics-note">Продажи считаются по дате оплаты (время Саратова); возвращённые заказы не учитываются.</p>
    </div>
    <div class="grid analytics-kpis">
      <div class="card kpi"><b>${data.tickets_sold}</b><span>Продано билетов</span></div>
      <div class="card kpi"><b>${data.paid_orders}</b><span>Оплаченных заказов</span></div>
      <div class="card kpi"><b>${rub(data.revenue)}</b><span>Выручка за период</span></div>
    </div>
    <div class="card">
      <h2>Продажи по тарифам</h2>
      <div class="analytics-table-wrap"><table class="analytics-table">
        <thead><tr><th>Тариф</th><th>Билетов продано</th></tr></thead>
        <tbody>${data.categories.map((row) => `<tr><td>${esc(row.name)}</td><td>${row.tickets_sold}</td></tr>`).join("") || '<tr><td colspan="2">За период продаж нет</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>Продажи по промокодам</h2>
      <div class="analytics-table-wrap"><table class="analytics-table">
        <thead><tr><th>Промокод</th><th>Заказов</th><th>Билетов продано</th><th>Выручка</th></tr></thead>
        <tbody>${data.promo_breakdown.map((row) => `<tr><td><button class="btn sm analytics-promo" type="button" data-promo="${esc(row.code)}">${esc(row.code)}</button></td><td>${row.paid_orders}</td><td>${row.tickets_sold}</td><td>${rub(row.revenue)}</td></tr>`).join("") || '<tr><td colspan="4">За период продаж по промокодам нет</td></tr>'}</tbody>
      </table></div>
    </div>`;
  const updateFilters = () => {
    let from;
    let to;
    try {
      from = parseAnalyticsDate($("#analytics-from").value);
      to = parseAnalyticsDate($("#analytics-to").value);
    } catch (error) {
      toast(error.message);
      return;
    }
    if (from && to && from > to) {
      toast("Начальная дата не может быть позже конечной");
      return;
    }
    analyticsFrom = from;
    analyticsTo = to;
    run(loadAnalytics);
  };
  $("#analytics-apply").onclick = updateFilters;
  $("#analytics-promo-trigger").onclick = () => {
    const picker = $("#analytics-promo-picker");
    const isOpen = !picker.classList.contains("hide");
    closeDatePicker();
    picker.classList.toggle("hide", isOpen);
    $("#analytics-promo-trigger").setAttribute("aria-expanded", String(!isOpen));
    if (!isOpen) picker.querySelector(".selected").focus();
  };
  const promoOptionButtons = [
    ...$("#analytics-promo-picker").querySelectorAll("[data-promo-option]"),
  ];
  $("#analytics-promo-trigger").onkeydown = (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const picker = $("#analytics-promo-picker");
    if (picker.classList.contains("hide")) {
      closeDatePicker();
      picker.classList.remove("hide");
      $("#analytics-promo-trigger").setAttribute("aria-expanded", "true");
    }
    promoOptionButtons[event.key === "ArrowDown" ? 0 : promoOptionButtons.length - 1].focus();
  };
  promoOptionButtons.forEach((button, index) => {
    button.onclick = () => {
      analyticsPromo = button.dataset.promoOption;
      closePromoPicker();
      updateFilters();
    };
    button.onkeydown = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        promoOptionButtons[(index + direction + promoOptionButtons.length) % promoOptionButtons.length].focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        promoOptionButtons[event.key === "Home" ? 0 : promoOptionButtons.length - 1].focus();
      }
    };
  });
  $("#analytics-from").onkeydown = $("#analytics-to").onkeydown = (event) => {
    if (event.key === "Enter") updateFilters();
  };
  $("#t-analytics").querySelectorAll("[data-calendar]").forEach((button) => {
    button.onclick = () => openDatePicker(button.dataset.calendar);
  });
  $("#t-analytics").querySelectorAll(".analytics-promo").forEach((button) => {
    button.onclick = () => {
      analyticsPromo = button.dataset.promo;
      run(loadAnalytics);
    };
  });
}

/* ---- заказы ---- */
async function loadOrders() {
  const qs = new URLSearchParams({
    q: $("#q").value,
    status: $("#fst").value,
    limit: 100,
  });
  $("#csv").href = "/api/admin/orders.csv?" + qs;
  const d = await api("/orders?" + qs);
  $("#orders").innerHTML =
    (d.orders
      .map(
        (o) => `<div class="row" data-id="${o.id}">
    <div><b>${esc(o.name)}</b><small>#${o.short} · ${when(o.created_at)}</small></div>
    <div>${esc(o.items)}<small>${esc(o.promo_code ? "промокод " + o.promo_code : "")}</small></div>
    <div>${esc(o.email)}<small>${esc(o.phone)}</small></div>
    <div><b>${rub(o.total)}</b></div><div><span class="st ${o.status}">${STR[o.status] || o.status}</span></div></div>`,
      )
      .join("") || "<p>Заказов нет</p>") +
    `<p style="color:var(--mute);font-size:13px;margin:10px 0 0">Всего найдено: ${d.total}</p>`;
  $("#orders")
    .querySelectorAll(".row")
    .forEach((r) => (r.onclick = () => openOrder(r.dataset.id)));
}
$("#findBtn").onclick = () => run(loadOrders);
$("#q").onkeydown = (e) => {
  if (e.key === "Enter") run(loadOrders);
};
async function openOrder(id) {
  const o = await api("/orders/" + id);
  $("#modal").innerHTML =
    `<h2>Заказ #${o.short} <span class="st ${o.status}">${STR[o.status] || o.status}</span></h2>
   <p>${esc(o.name)}<br>${esc(o.email)} · ${esc(o.phone)} ${esc(o.telegram)}</p>
   <p>${esc(o.items)}<br><b>${rub(o.total)}</b>${o.discount ? ` (скидка ${rub(o.discount)}, ${esc(o.promo_code)})` : ""}</p>
   <p style="color:var(--mute)">Создан: ${when(o.created_at)} · Оплачен: ${when(o.paid_at)} · Письмо: ${o.email_sent ? "отправлено" : "нет"}</p>
   ${o.payments.map((p) => `<p style="font-size:13px;color:var(--mute)">Платёж ${esc(p.provider)} ${esc(p.id)}: ${esc(p.status)} ${rub(p.amount)}${p.needs_refund ? ' <b style="color:#ff8a8a">— ТРЕБУЕТСЯ ВОЗВРАТ ДЕНЕГ</b>' : ""}</p>`).join("")}
   ${o.tickets.map((t, i) => `<p style="font-size:14px"><a style="color:var(--glow)" href="${esc(t.url)}" target="_blank">Билет ${i + 1}: ${esc(t.name)}</a> · ${esc(t.status)} · вошло ${t.entered}/${t.admits}</p>`).join("")}
   <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
    ${o.status !== "paid" && o.status !== "refunded" ? '<button class="btn red" data-a="mark-paid">Отметить оплаченным</button>' : ""}
    ${o.status === "paid" ? '<button class="btn" data-a="resend">Отправить билеты ещё раз</button><button class="btn" data-a="refund">Возврат</button>' : ""}
    <button class="btn" id="mClose">Закрыть</button></div>`;
  $("#ov").classList.remove("hide");
  $("#mClose").onclick = () => $("#ov").classList.add("hide");
  $("#modal")
    .querySelectorAll("[data-a]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          const a = b.dataset.a;
          if (
            a === "refund" &&
            !confirm(
              "Аннулировать билеты и освободить места? Деньги нужно вернуть отдельно в кабинете платёжной системы.",
            )
          )
            return;
          if (
            a === "mark-paid" &&
            !confirm("Отметить заказ оплаченным и выдать билеты?")
          )
            return;
          run(async () => {
            const r = await api(`/orders/${id}/${a}`, "POST");
            $("#ov").classList.add("hide");
            if (r.note) alert(r.note);
            loadOrders();
            loadStats();
          }, "Готово");
        }),
    );
}
$("#ov").onclick = (e) => {
  if (e.target.id === "ov") $("#ov").classList.add("hide");
};

/* ---- тарифы ---- */
async function loadCats() {
  const cats = await api("/categories");
  $("#t-cats").innerHTML = cats
    .map(
      (c) => `<div class="card" data-id="${c.id}"><h2>${esc(c.name)}</h2>
    <div class="two"><div><label>Название</label><input data-f="name" value="${esc(c.name)}"></div>
    <div><label>Описание</label><input data-f="description" value="${esc(c.description)}"></div>
    <div><label>Всего билетов (вместимость)</label><input data-f="capacity" type="number" min="0" value="${c.capacity}"></div>
    <div><label>Максимум в одном заказе</label><input data-f="max_per_order" type="number" min="1" max="50" value="${c.max_per_order}"></div></div>
    <label class="check-option"><input type="checkbox" data-f="is_active" ${c.is_active ? "checked" : ""}> Продаётся</label>
    <label class="check-option"><input type="checkbox" data-f="is_featured" ${c.is_featured ? "checked" : ""}> Выделить на сайте</label>
    <p><button class="btn sm red" data-save="cat">Сохранить тариф</button></p>
    <h2 style="margin-top:18px;font-size:15px">Цены по периодам</h2>
    <div class="hint" style="color:var(--mute);font-size:12px;margin-bottom:8px">Сайт берёт цену, действующую сейчас. Даты — по Саратову. Пустые даты = всегда. «Плашка» — текст под ценой, например «через 4 дня 549 ₽».</div>
    <div class="prices">${c.prices.map(pr).join("")}</div>
    <p><button class="btn sm" data-add="1">+ период</button> <button class="btn sm red" data-save="prices">Сохранить цены</button></p></div>`,
    )
    .join("");
  enhanceNumberInputs($("#t-cats"));
  document.querySelectorAll("#t-cats .card").forEach((card) => {
    const id = card.dataset.id;
    card.querySelector("[data-add]").onclick = () => {
      const prices = card.querySelector(".prices");
      prices.insertAdjacentHTML(
        "beforeend",
        pr({ price: 0, valid_from: null, valid_until: null, note: "" }),
      );
      enhanceNumberInputs(prices);
    };
    card.addEventListener("click", (e) => {
      if (e.target.dataset.del !== undefined) e.target.closest(".pr").remove();
    });
    card.querySelector('[data-save="cat"]').onclick = () =>
      run(async () => {
        const b = {};
        card.querySelectorAll("[data-f]").forEach((i) => {
          b[i.dataset.f] =
            i.type === "checkbox"
              ? i.checked
              : i.type === "number"
                ? Number(i.value)
                : i.value;
        });
        await api("/categories/" + id, "PUT", b);
        loadStats();
      }, "Тариф сохранён");
    card.querySelector('[data-save="prices"]').onclick = () =>
      run(async () => {
        const b = [...card.querySelectorAll(".pr")].map((r) => ({
          price: Number(r.querySelector('[data-p="price"]').value),
          valid_from: fromLocal(r.querySelector('[data-p="from"]').value),
          valid_until: fromLocal(r.querySelector('[data-p="until"]').value),
          note: r.querySelector('[data-p="note"]').value,
        }));
        await api(`/categories/${id}/prices`, "PUT", b);
      }, "Цены сохранены");
  });
}
const pr = (
  p,
) => `<div class="pr"><input data-p="price" type="number" min="0" step="1" value="${p.price}" title="Цена, ₽">
  <input data-p="from" type="datetime-local" value="${toLocal(p.valid_from)}" title="С"><input data-p="until" type="datetime-local" value="${toLocal(p.valid_until)}" title="До">
  <input data-p="note" class="nt" placeholder="Плашка" value="${esc(p.note)}"><button class="btn sm" data-del>✕</button></div>`;

/* ---- промокоды ---- */
async function loadPromos() {
  const ps = await api("/promos");
  $("#t-promos").innerHTML =
    `<div class="card"><h2>Новый промокод</h2><div class="two">
   <div><label>Код (латиница/цифры)</label><input id="pc"></div>
   <div class="promo-type-field">
     <label id="promo-kind-label">Тип</label>
     <input id="pk" type="hidden" value="percent">
     <button class="promo-picker-trigger" id="promo-kind-trigger" type="button" aria-labelledby="promo-kind-label promo-kind-value" aria-haspopup="listbox" aria-expanded="false">
       <span id="promo-kind-value">Процент %</span>
       <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 6 5 5 5-5"></path></svg>
     </button>
     <div class="promo-picker hide" id="promo-kind-picker" role="listbox" aria-labelledby="promo-kind-label">
       <button class="promo-option selected" type="button" role="option" aria-selected="true" data-promo-kind="percent">Процент %</button>
       <button class="promo-option" type="button" role="option" aria-selected="false" data-promo-kind="fixed">Сумма в рублях</button>
     </div>
   </div>
   <div><label>Размер скидки</label><input id="pv" type="number" min="1"></div>
   <div><label>Лимит использований (пусто = без лимита)</label><input id="pm" type="number" min="1"></div></div>
   <p><button class="btn red" id="pAdd">Добавить</button></p></div>
   <div class="card">${
     ps
       .map(
         (
           p,
         ) => `<div class="row" style="grid-template-columns:1fr 1fr 1fr auto auto;cursor:default">
    <b>${esc(p.code)}</b><span>${p.kind === "percent" ? p.value + " %" : rub(p.value)}</span><span>использовано ${p.used}${p.max_uses ? " из " + p.max_uses : ""}</span>
    <button class="btn sm" data-tg="${p.id}" data-on="${p.is_active}">${p.is_active ? "Отключить" : "Включить"}</button><button class="btn sm" data-rm="${p.id}">Удалить</button></div>`,
       )
       .join("") || "<p>Промокодов нет</p>"
   }</div>`;
  enhanceNumberInputs($("#t-promos"));
  const kindTrigger = $("#promo-kind-trigger");
  const kindPicker = $("#promo-kind-picker");
  const kindOptions = [...kindPicker.querySelectorAll("[data-promo-kind]")];
  const focusKindOption = (index) => kindOptions[index].focus();
  kindTrigger.onclick = () => {
    const isOpen = !kindPicker.classList.contains("hide");
    closeDatePicker();
    closePromoPicker();
    kindPicker.classList.toggle("hide", isOpen);
    kindTrigger.setAttribute("aria-expanded", String(!isOpen));
    if (!isOpen) kindPicker.querySelector(".selected").focus();
  };
  kindTrigger.onkeydown = (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (kindPicker.classList.contains("hide")) {
      closeDatePicker();
      closePromoPicker();
      kindPicker.classList.remove("hide");
      kindTrigger.setAttribute("aria-expanded", "true");
    }
    focusKindOption(event.key === "ArrowDown" ? 0 : kindOptions.length - 1);
  };
  kindOptions.forEach((option, index) => {
    option.onclick = () => {
      $("#pk").value = option.dataset.promoKind;
      $("#promo-kind-value").textContent = option.textContent;
      kindOptions.forEach((item) => {
        const selected = item === option;
        item.classList.toggle("selected", selected);
        item.setAttribute("aria-selected", String(selected));
      });
      closePromoTypePicker(true);
    };
    option.onkeydown = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        focusKindOption((index + direction + kindOptions.length) % kindOptions.length);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        focusKindOption(event.key === "Home" ? 0 : kindOptions.length - 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closePromoTypePicker(true);
      }
    };
  });
  $("#pAdd").onclick = () =>
    run(async () => {
      await api("/promos", "POST", {
        code: $("#pc").value,
        kind: $("#pk").value,
        value: Number($("#pv").value),
        max_uses: $("#pm").value ? Number($("#pm").value) : null,
      });
      loadPromos();
    }, "Добавлено");
  document.querySelectorAll("[data-tg]").forEach(
    (b) =>
      (b.onclick = () =>
        run(async () => {
          await api("/promos/" + b.dataset.tg, "PATCH", {
            is_active: b.dataset.on !== "true",
          });
          loadPromos();
        })),
  );
  document.querySelectorAll("[data-rm]").forEach(
    (b) =>
      (b.onclick = () => {
        if (confirm("Удалить промокод?"))
          run(async () => {
            await api("/promos/" + b.dataset.rm, "DELETE");
            loadPromos();
          });
      }),
  );
}

/* ---- событие ---- */
const EF = [
  ["title", "Название"],
  ["eyebrow", "Надпись над заголовком"],
  ["city", "Город"],
  ["age_limit", "Возраст (число)", "number"],
  ["hero_text", "Текст на первом экране", "area"],
  ["announce", "Анонс", "area"],
  ["venue_name", "Название клуба"],
  ["address", "Адрес"],
  ["landmark", "Ориентир (каждая строка — пункт)", "area"],
  ["map_embed", "Ссылка или iframe карты (пусто — по адресу)", "area"],
  [
    "poster_url",
    "Афиша (URL или путь на сервере, например /images/poster.jpg)",
  ],
  ["doors_at", "Открытие дверей (Саратов)", "dt"],
  ["ends_at", "Конец (Саратов)", "dt"],
];
async function loadEvent() {
  const e = await api("/event");
  $("#t-event").innerHTML =
    `<div class="card">${EF.map(([k, l, t]) => {
      if (t === "area")
        return `<label>${esc(l)}</label><textarea data-k="${k}">${esc(e[k])}</textarea>`;
      if (t === "dt") {
        const value = toLocal(e[k]);
        return `<div class="event-datetime-field">
          <label for="event-${k}-display">${esc(l)}</label>
          <div class="date-entry">
            <input id="event-${k}-display" type="text" readonly value="${esc(formatEventDateTime(value))}" aria-haspopup="dialog" aria-controls="event-${k}-picker" data-event-date-display="${k}">
            <button class="date-picker-trigger" type="button" data-event-calendar="${k}" aria-label="Выбрать дату и время: ${esc(l)}" aria-haspopup="dialog" aria-expanded="false">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"></rect><path d="M7.5 3.5v3M16.5 3.5v3M3.5 9.5h17"></path></svg>
            </button>
          </div>
          <input data-k="${k}" class="event-datetime-value" type="datetime-local" hidden value="${esc(value)}">
          <div class="date-picker hide" id="event-${k}-picker" role="dialog" aria-label="Выбор даты и времени: ${esc(l)}"></div>
        </div>`;
      }
      return `<label>${esc(l)}</label><input data-k="${k}" ${t ? 'type="number"' : ""} value="${esc(e[k])}">`;
    }).join("")}
   <label for="posterFile">Загрузить фото (JPG, PNG, WebP; до 8 МБ)</label>
   <input id="posterFile" type="file" accept="image/jpeg,image/png,image/webp">
   <p><button class="btn" id="posterUpload" type="button">Загрузить фото</button></p>
   <label class="check-option"><input type="checkbox" id="pub" ${e.is_published ? "checked" : ""}> Опубликовано</label>
   <p><button class="btn red" id="evSave">Сохранить</button></p></div>`;
  $("#posterUpload").onclick = () => run(uploadPoster, "Фото загружено");
  enhanceNumberInputs($("#t-event"));
  $("#t-event").querySelectorAll("[data-event-calendar]").forEach((button) => {
    button.onclick = () => openEventDatePicker(button.dataset.eventCalendar);
  });
  $("#t-event").querySelectorAll("[data-event-date-display]").forEach((input) => {
    input.onclick = () => openEventDatePicker(input.dataset.eventDateDisplay);
  });
  $("#evSave").onclick = () =>
    run(async () => {
      const b = { is_published: $("#pub").checked };
      document.querySelectorAll("[data-k]").forEach((i) => {
        const k = i.dataset.k;
        b[k] =
          i.type === "datetime-local"
            ? fromLocal(i.value)
            : i.type === "number"
              ? Number(i.value)
              : i.value;
      });
      await api("/event", "PUT", b);
    }, "Событие сохранено");
}
start();
