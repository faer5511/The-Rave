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
];
const LOAD = {
  orders: loadOrders,
  cats: loadCats,
  promos: loadPromos,
  event: loadEvent,
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
    <label><input type="checkbox" data-f="is_active" ${c.is_active ? "checked" : ""}> Продаётся</label>
    <label><input type="checkbox" data-f="is_featured" ${c.is_featured ? "checked" : ""}> Выделить на сайте</label>
    <p><button class="btn sm red" data-save="cat">Сохранить тариф</button></p>
    <h2 style="margin-top:18px;font-size:15px">Цены по периодам</h2>
    <div class="hint" style="color:var(--mute);font-size:12px;margin-bottom:8px">Сайт берёт цену, действующую сейчас. Даты — по Саратову. Пустые даты = всегда. «Плашка» — текст под ценой, например «через 4 дня 549 ₽».</div>
    <div class="prices">${c.prices.map(pr).join("")}</div>
    <p><button class="btn sm" data-add="1">+ период</button> <button class="btn sm red" data-save="prices">Сохранить цены</button></p></div>`,
    )
    .join("");
  document.querySelectorAll("#t-cats .card").forEach((card) => {
    const id = card.dataset.id;
    card.querySelector("[data-add]").onclick = () =>
      card
        .querySelector(".prices")
        .insertAdjacentHTML(
          "beforeend",
          pr({ price: 0, valid_from: null, valid_until: null, note: "" }),
        );
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
   <div><label>Тип</label><select id="pk"><option value="percent">Процент %</option><option value="fixed">Сумма в рублях</option></select></div>
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
    `<div class="card">${EF.map(([k, l, t]) => `<label>${l}</label>` + (t === "area" ? `<textarea data-k="${k}">${esc(e[k])}</textarea>` : t === "dt" ? `<input data-k="${k}" type="datetime-local" value="${toLocal(e[k])}">` : `<input data-k="${k}" ${t ? 'type="number"' : ""} value="${esc(e[k])}">`)).join("")}
   <label for="posterFile">Загрузить фото (JPG, PNG, WebP; до 8 МБ)</label>
   <input id="posterFile" type="file" accept="image/jpeg,image/png,image/webp">
   <p><button class="btn" id="posterUpload" type="button">Загрузить фото</button></p>
   <label><input type="checkbox" id="pub" ${e.is_published ? "checked" : ""}> Опубликовано</label>
   <p><button class="btn red" id="evSave">Сохранить</button></p></div>`;
  $("#posterUpload").onclick = () => run(uploadPoster, "Фото загружено");
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
