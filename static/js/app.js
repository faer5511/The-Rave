const DEFAULT_CONFIG = {
  eyebrow: "СВОЯ ВОЛНА · 14+",
  heroText:
    "THE RAVE — это большая семья, где каждый находит свою волну: живой звук, свет и люди, с которыми хочется остаться до конца вечера.",
  announce:
    "Один вечер, один зал и громкая музыка для тех, кто пришёл за своей волной. Берите друзей — вместе веселее.",
  dateText: "19 декабря 2026",
  doorsTime: "17:00",
  endTime: "21:00",
  age: "14+",
  city: "Саратов",
  poster: "",
  venue: {
    name: "Кластер Н",
    address: "Саратов, Привокзальная площадь, 1Д",
    map: "",
    landmark:
      "Ориентир — Привокзальная площадь, рядом с железнодорожным вокзалом.\nИщите здание «Кластер Н» по адресу 1Д.\nПриходите заранее: двери открываются в 17:00.",
  },
  tickets: [
    {
      id: "dance",
      name: "Танцпол",
      price: 279,
      note: "",
      desc: "Проход на мероприятие",
      feat: false,
    },
    {
      id: "pair",
      name: "Парный танцпол",
      price: 449,
      note: "через 4 дня 549 ₽",
      desc: "Проход на мероприятие для двух персон",
      feat: true,
    },
    {
      id: "vip",
      name: "VIP",
      price: 599,
      note: "",
      desc: "Отдельный вход без очереди, доступ к VIP зоне, место за столом, дополнительный бар и уборные",
      feat: false,
    },
  ],
};

const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
const fmt = (amount) =>
  `${Math.round(amount)
    .toLocaleString("ru-RU")
    .replace(/\u00a0/g, " ")} ₽`;
const plural = (amount, forms) =>
  forms[
    amount % 10 === 1 && amount % 100 !== 11
      ? 0
      : amount % 10 >= 2 &&
          amount % 10 <= 4 &&
          (amount % 100 < 10 || amount % 100 >= 20)
        ? 1
        : 2
  ];
const safeUrl = (value) => {
  const url = (value || "").trim();
  const isServerPath =
    url.startsWith("/") && !url.startsWith("//") && !url.includes("\\");
  return /^(https?:\/\/|data:image\/)/i.test(url) || isServerPath ? url : "";
};

let cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
const qty = {};
let toastTimer;
let lastMap = "";

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
}

window.toast = toast;

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    field.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(field);
    field.select();

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }

    field.remove();
    return copied;
  }
}

function calc() {
  const lines = cfg.tickets
    .filter((ticket) => (qty[ticket.id] || 0) > 0)
    .map((ticket) => ({
      name: ticket.name,
      q: qty[ticket.id],
      sum: ticket.price * qty[ticket.id],
    }));
  const sub = lines.reduce((sum, line) => sum + line.sum, 0);

  return {
    lines,
    sub,
    disc: 0,
    total: sub,
    promo: null,
    count: lines.reduce((sum, line) => sum + line.q, 0),
  };
}

function chips() {
  return [cfg.dateText, `Старт ${cfg.doorsTime}`, cfg.age, cfg.city]
    .filter(Boolean)
    .map((value) => `<span class="chip">${esc(value)}</span>`)
    .join("");
}

function mapSrc() {
  const value = (cfg.venue.map || "").trim();
  const source = value.startsWith("<")
    ? (value.match(/src=["']([^"']+)["']/i) || [])[1]
    : value;
  const location = `q=${encodeURIComponent(cfg.venue.address)}`;

  return source && /^https:\/\//i.test(source)
    ? source
    : `https://maps.google.com/maps?hl=ru&output=embed&t=k&z=16&${location}`;
}

function applyConfig() {
  document.title = `THE RAVE — билеты · ${cfg.dateText}`;
  $("#eyebrow").textContent = cfg.eyebrow;
  $("#heroText").textContent = cfg.heroText;
  $("#heroChips").innerHTML = chips();
  $("#evChips").innerHTML = chips();
  $("#evTitle").textContent = `THE RAVE · ${cfg.venue.name}`;
  $("#announce").textContent = cfg.announce;
  $("#tDoors").textContent = cfg.doorsTime;
  $("#tEnd").textContent = cfg.endTime;

  const poster = safeUrl(cfg.poster);
  $("#poster").classList.toggle("has-image", Boolean(poster));
  $("#poster").innerHTML =
    `${poster ? `<img src="${esc(poster)}" alt="" aria-hidden="true">` : ""}
    <div class="pt"><b>THE<br>RAVE</b><span>${esc(cfg.dateText)} · ${esc(cfg.venue.name)}</span></div>`;

  renderTickets();
  $("#rVenue").textContent = cfg.venue.name;
  $("#rAddr").textContent = cfg.venue.address;
  $("#rList").innerHTML = cfg.venue.landmark
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<li>${esc(line)}</li>`)
    .join("");
  $("#rOpen").href =
    `https://maps.google.com/maps?hl=ru&t=k&z=16&q=${encodeURIComponent(cfg.venue.address)}`;

  const source = mapSrc();
  if (source !== lastMap) {
    lastMap = source;
    $("#mapBox").innerHTML =
      `<iframe src="${esc(source)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" ` +
      `title="Карта: ${esc(cfg.venue.name)}" allowfullscreen></iframe>`;
  }

  $("#infoBox").innerHTML = `
    <div class="card hov"><h4>Вход с ${esc(cfg.doorsTime)}</h4><p>Двери открываются в ${esc(cfg.doorsTime)}, мероприятие заканчивается в ${esc(cfg.endTime)}.</p></div>
    <div class="card hov"><h4>Вход строго ${esc(cfg.age)}</h4><p>Возрастное ограничение действует для всех гостей без исключений.</p></div>
    <div class="card hov"><h4>Оплата</h4><p>Оплата проходит онлайн. Билеты придут на email.</p></div>`;
  renderSum();
}

function renderTickets() {
  $("#tkList").innerHTML = cfg.tickets
    .map(
      (ticket) => `
        <article class="card tk hov ${ticket.feat ? "feat" : ""}">
          <h3>${esc(ticket.name)}</h3>
          <div class="price">${Number(ticket.price).toLocaleString("ru-RU")}<small>₽</small></div>
          ${ticket.note ? `<div class="note">${esc(ticket.note)}</div>` : ""}
          <p class="d">${esc(ticket.desc)}</p>
          <div class="qty">
            <button type="button" data-id="${esc(ticket.id)}" data-d="-1" aria-label="Меньше: ${esc(ticket.name)}">−</button>
            <output id="q-${esc(ticket.id)}" aria-live="polite">${qty[ticket.id] || 0}</output>
            <button type="button" data-id="${esc(ticket.id)}" data-d="1" aria-label="Больше: ${esc(ticket.name)}">+</button>
          </div>
        </article>`,
    )
    .join("");
}

function renderSum(bump = false) {
  const cart = calc();
  const value = $("#sumVal");
  $("#sumInfo").textContent = cart.count
    ? `${cart.count} ${plural(cart.count, ["билет", "билета", "билетов"])}`
    : "Билеты не выбраны";
  $("#sumDisc").textContent = cart.disc
    ? `Скидка по коду ${cart.promo.code.toUpperCase()}: −${fmt(cart.disc)} (было ${fmt(cart.sub)})`
    : "";
  value.textContent = fmt(cart.total);

  if (bump) {
    value.classList.remove("bump");
    void value.offsetWidth;
    value.classList.add("bump");
  }
  $("#buyBtn").disabled = !cart.count;
}

function setMsg(message, type) {
  const element = $("#pmsg");
  element.textContent = message;
  element.className = `pmsg${type ? ` ${type}` : ""}`;
}

const header = $("#hdr");
addEventListener(
  "scroll",
  () => header.classList.toggle("stuck", scrollY > 20),
  { passive: true },
);
header.classList.toggle("stuck", scrollY > 20);

document.querySelectorAll("[data-scroll]").forEach((button) => {
  button.addEventListener("click", () =>
    $(button.dataset.scroll).scrollIntoView({ behavior: "smooth" }),
  );
});
document
  .querySelectorAll(".reveal")
  .forEach((element) => element.classList.add("in"));

$("#rCopy").addEventListener("click", async () => {
  toast(
    (await copyText(cfg.venue.address))
      ? "Адрес скопирован"
      : "Не удалось скопировать",
  );
});

const ov = $("#ov");
let lockedScrollY = 0;
let bodyScrollStyles = null;

function lockPageScroll() {
  if (document.documentElement.classList.contains("lock")) return;

  lockedScrollY = window.scrollY;
  bodyScrollStyles = {
    position: document.body.style.position,
    top: document.body.style.top,
    width: document.body.style.width,
  };
  document.documentElement.classList.add("lock");
  document.body.classList.add("lock");
  document.body.style.position = "fixed";
  document.body.style.top = `-${lockedScrollY}px`;
  document.body.style.width = "100%";
}

function unlockPageScroll() {
  if (!document.documentElement.classList.contains("lock")) return;

  document.documentElement.classList.remove("lock");
  document.body.classList.remove("lock");
  document.body.style.position = bodyScrollStyles.position;
  document.body.style.top = bodyScrollStyles.top;
  document.body.style.width = bodyScrollStyles.width;
  const scrollBehavior = document.documentElement.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = "auto";
  window.scrollTo(0, lockedScrollY);
  document.documentElement.style.scrollBehavior = scrollBehavior;
  bodyScrollStyles = null;
}

window.lockPageScroll = lockPageScroll;
window.unlockPageScroll = unlockPageScroll;

function openModal() {
  const cart = calc();
  if (!cart.count) return;

  $("#orderBox").innerHTML =
    cart.lines
      .map(
        (line) =>
          `<div><span>${esc(line.name)} × ${line.q}</span><span>${fmt(line.sum)}</span></div>`,
      )
      .join("") +
    (cart.disc
      ? `<div class="dsc"><span>Промокод ${esc(cart.promo.code.toUpperCase())}</span><span>−${fmt(cart.disc)}</span></div>`
      : "") +
    `<div class="tot"><span>Итого</span><span>${fmt(cart.total)}</span></div>`;
  $("#stForm").classList.remove("hide");
  $("#stDone").classList.add("hide");
  ov.classList.add("open");
  ov.setAttribute("aria-hidden", "false");
  lockPageScroll();
  setTimeout(() => $("#fName").focus(), 350);
}

function closeModal() {
  ov.classList.remove("open");
  ov.setAttribute("aria-hidden", "true");
  unlockPageScroll();
}

$("#buyBtn").addEventListener("click", openModal);
$("#mClose").addEventListener("click", closeModal);
$("#doneClose").addEventListener("click", closeModal);
ov.addEventListener("mousedown", (event) => {
  if (event.target === ov) closeModal();
});
addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});

applyConfig();
