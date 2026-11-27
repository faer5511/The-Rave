/* Данные события, промокоды, заказы и оплата через API сервера. */
(function () {
  "use strict";
  /* Цвета встроенного виджета ЮKassa под сайт. Сверьте имена параметров с документацией виджета. */
  const WIDGET_COLORS = {
    control_primary: "#B3122D",
    control_primary_content: "#FFFFFF",
    background: "#140A0D",
    text: "#F6F1F1",
    border: "#3A1A22",
    control_secondary: "#2A1218",
  };
  const WIDGET_SRC =
    "https://yookassa.ru/checkout-widget/v1/checkout-widget.js";

  const $$ = (s) => document.querySelector(s);
  let PROMO = null,
    idemKey = null,
    order = null,
    pollT = null,
    tickT = null,
    pollEnabled = false,
    pollInFlight = false;

  async function api(path, opts) {
    let r,
      j = {};
    try {
      r = await fetch(
        path,
        Object.assign(
          { headers: { "Content-Type": "application/json" } },
          opts,
        ),
      );
    } catch (_) {
      const e = new Error("Нет связи с сервером");
      e.status = 0;
      throw e;
    }
    try {
      j = await r.json();
    } catch (_) {}
    if (!r.ok) {
      const e = new Error(j.message || "Ошибка сервера");
      e.status = r.status;
      e.data = j;
      throw e;
    }
    return j;
  }
  const newKey = () =>
    crypto.randomUUID
      ? crypto.randomUUID()
      : String(Date.now()) + Math.random().toString(36).slice(2, 12);

  /* ---------- данные события ---------- */
  const fDate = (iso) =>
    new Intl.DateTimeFormat("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Europe/Saratov",
    })
      .format(new Date(iso))
      .replace(/\s*г\.?$/, "");
  const fTime = (iso) =>
    new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Saratov",
    }).format(new Date(iso));

  async function loadEvent() {
    try {
      const ev = await api("/api/event");
      Object.assign(cfg, {
        eyebrow: ev.eyebrow,
        heroText: ev.hero_text,
        announce: ev.announce,
        city: ev.city,
        age: ev.age + "+",
        dateText: fDate(ev.doors_at),
        doorsTime: fTime(ev.doors_at),
        endTime: fTime(ev.ends_at),
        poster: ev.poster_url || "",
      });
      Object.assign(cfg.venue, {
        name: ev.venue,
        address: ev.address,
        map: ev.map_embed || "",
        landmark: ev.landmark || cfg.venue.landmark,
      });
      cfg.tickets = ev.categories.map((c) => ({
        id: c.code,
        name: c.name,
        price: c.price,
        note: c.note,
        desc: c.description,
        feat: c.featured,
        _cid: c.id,
        _left: c.available,
        _max: c.max_per_order,
      }));
      cfg.tickets.forEach((t) => {
        qty[t.id] = Math.min(qty[t.id] || 0, cap(t));
      });
      applyConfig();
    } catch (e) {
      toast("Не удалось загрузить данные: " + e.message);
    }
  }
  const cap = (t) =>
    Math.max(0, Math.min(t._max || 10, t._left ?? t._max ?? 10));

  /* ---------- переопределения ---------- */
  renderTickets = function () {
    $$("#tkList").innerHTML = cfg.tickets
      .map((t) => {
        const sold = t._left <= 0,
          q = qty[t.id] || 0;
        return `<article class="card tk hov ${t.feat ? "feat" : ""} ${sold ? "sold" : ""}">
        <h3>${esc(t.name)}</h3>
        <div class="price">${Number(t.price).toLocaleString("ru-RU")}<small>₽</small></div>
        ${t.note ? `<div class="note">${esc(t.note)}</div>` : ""}
        ${sold ? '<div class="left">Распродано</div>' : t._left <= 20 ? `<div class="left">Осталось ${t._left}</div>` : ""}
        <p class="d">${esc(t.desc)}</p>
        <div class="qty">
          <button type="button" data-id="${esc(t.id)}" data-d="-1" aria-label="Меньше: ${esc(t.name)}">−</button>
          <output id="q-${esc(t.id)}" aria-live="polite">${q}</output>
          <button type="button" data-id="${esc(t.id)}" data-d="1" aria-label="Больше: ${esc(t.name)}" ${q >= cap(t) ? "disabled" : ""}>+</button>
        </div></article>`;
      })
      .join("");
  };

  calc = function () {
    // та же формула, что на сервере (копейки, процент — вниз до целых рублей)
    const lines = cfg.tickets
      .filter((t) => (qty[t.id] || 0) > 0)
      .map((t) => ({
        name: t.name,
        q: qty[t.id],
        k: Math.round(t.price * 100) * qty[t.id],
      }));
    const subK = lines.reduce((s, l) => s + l.k, 0);
    let dK = 0;
    if (PROMO && subK > 0) {
      dK =
        PROMO.kind === "percent"
          ? Math.min(
              subK,
              Math.floor(Math.floor((subK * PROMO.value) / 100) / 100) * 100,
            )
          : Math.min(PROMO.value, subK);
    }
    return {
      lines: lines.map((l) => ({ name: l.name, q: l.q, sum: l.k / 100 })),
      sub: subK / 100,
      disc: dK / 100,
      total: (subK - dK) / 100,
      promo: PROMO && subK > 0 ? { code: PROMO.code } : null,
      count: lines.reduce((s, l) => s + l.q, 0),
    };
  };

  async function applyPromo() {
    const code = $$("#promoIn").value.trim().toUpperCase();
    idemKey = null;
    if (!code) {
      PROMO = null;
      setMsg("");
      renderSum(true);
      return;
    }
    try {
      const r = await api("/api/promo/check", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      PROMO = { code: r.code, kind: r.kind, value: r.value };
      setMsg(r.message, "ok");
    } catch (e) {
      PROMO = null;
      setMsg(e.message, "bad");
    }
    renderSum(true);
  }

  $$("#promoBtn").addEventListener("click", applyPromo);
  $$("#promoIn").addEventListener("keydown", (event) => {
    if (event.key === "Enter") applyPromo();
  });

  $$("#tkList").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (!b) return;
    const t = cfg.tickets.find((x) => x.id === b.dataset.id);
    if (!t) return;
    qty[t.id] = Math.max(0, Math.min(cap(t), (qty[t.id] || 0) + +b.dataset.d));
    $$("#q-" + t.id).textContent = qty[t.id];
    $$(`button[data-id="${t.id}"][data-d="1"]`).disabled = qty[t.id] >= cap(t);
    idemKey = null;
    renderSum(true);
  });

  /* ---------- заказ ---------- */
  $$("#buyBtn").addEventListener("click", () =>
    $$("#stPay").classList.add("hide"),
  );
  const show = (id) =>
    ["stForm", "stPay", "stDone"].forEach((x) =>
      $$("#" + x).classList.toggle("hide", x !== id),
    );
  const mmss = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return (
      String(Math.floor(s / 60)).padStart(2, "0") +
      ":" +
      String(s % 60).padStart(2, "0")
    );
  };
  const stop = () => {
    clearTimeout(pollT);
    clearInterval(tickT);
    pollT = tickT = null;
    pollEnabled = false;
  };

  $$("#form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $$("#fName").value.trim(),
      mail = $$("#fMail").value.trim(),
      tg = $$("#fTg").value.trim();
    const checks = [
      ["fName", name.length >= 2],
      ["fMail", /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)],
      ["fTg", !tg || /^@?[A-Za-z0-9_]{5,32}$/.test(tg)],
    ];
    let ok = true;
    checks.forEach(([id, g]) => {
      $$("#" + id).parentElement.classList.toggle("bad", !g);
      if (!g) ok = false;
    });
    if (!$$("#fConsent").checked) {
      toast("Нужно согласие на обработку данных");
      ok = false;
    }
    const c = calc();
    if (!ok || !c.count) return;

    const btn = $$("#sendBtn");
    btn.disabled = true;
    btn.textContent = "Создаём заказ…";
    idemKey = idemKey || newKey();
    try {
      const r = await api("/api/orders", {
        method: "POST",
        body: JSON.stringify({
          items: cfg.tickets
            .filter((t) => qty[t.id] > 0)
            .map((t) => ({ category_id: t._cid, quantity: qty[t.id] })),
          promo_code: PROMO ? PROMO.code : null,
          name,
          email: mail,
          telegram: tg || null,
          consent: true,
          idempotency_key: idemKey,
          website: $$("#fWebsite").value,
        }),
      });
      showOrder(r);
    } catch (err) {
      toast(err.message);
      if (err.status === 409) {
        idemKey = null;
        closeModal();
        loadEvent();
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "Перейти к оплате";
    }
  });

  function showOrder(r) {
    order = r;
    stop();
    if (r.status === "paid") return done(r);
    if (r.status !== "pending" || !r.payment) return expired();
    show("stPay");
    $$("#payAmt").textContent = fmt(r.total);
    $$("#payNote").textContent =
      "Оплата защищена. Билеты удерживаются до окончания таймера.";
    const end = new Date(r.expires_at).getTime();
    const tick = () => {
      const left = end - Date.now();
      $$("#payTimer").textContent = "Осталось " + mmss(left);
      if (left <= 0) {
        stop();
        expired();
      }
    };
    tick();
    tickT = setInterval(tick, 1000);
    pollEnabled = true;
    pollT = setTimeout(poll, 3000);
    if (r.payment.mode === "mock") renderMock(r.payment);
    else renderYoo(r.payment);
  }

  function renderMock(p) {
    $$("#payBox").innerHTML =
      `<div class="mockpay"><b>ТЕСТОВАЯ ОПЛАТА</b><p>Режим разработки: платёж не списывает деньги.</p>
      <button class="btn btn-red btn-lg" id="mockBtn" type="button">Оплатить (тест)</button></div>`;
    $$("#mockBtn").addEventListener("click", async () => {
      try {
        await api("/api/mock/pay/" + p.payment_id, { method: "POST" });
        poll();
      } catch (e) {
        toast(e.message);
      }
    });
  }

  function loadWidget() {
    return new Promise((ok, fail) => {
      if (window.YooMoneyCheckoutWidget) return ok();
      const s = document.createElement("script");
      s.src = WIDGET_SRC;
      s.onload = ok;
      s.onerror = () => fail(new Error("Не загрузился виджет оплаты"));
      document.head.appendChild(s);
    });
  }
  async function renderYoo(p) {
    try {
      await loadWidget();
      const w = new window.YooMoneyCheckoutWidget({
        confirmation_token: p.confirmation_token,
        return_url: p.return_url,
        customization: { colors: WIDGET_COLORS },
        error_callback: (err) => {
          console.error(err);
          toast("Ошибка оплаты. Попробуйте ещё раз.");
        },
      });
      w.render("payBox");
    } catch (e) {
      $$("#payBox").innerHTML =
        `<div class="mockpay"><p>${esc(e.message)}</p></div>`;
    }
  }

  async function poll() {
    if (!order || !pollEnabled || pollInFlight) return;
    clearTimeout(pollT);
    pollT = null;
    pollInFlight = true;
    try {
      const r = await api("/api/orders/" + order.order_id);
      if (r.status === "paid") {
        stop();
        done(r);
      } else if (r.status !== "pending") {
        stop();
        expired();
      }
    } catch (_) {
    } finally {
      pollInFlight = false;
      if (pollEnabled) pollT = setTimeout(poll, 3000);
    }
  }

  function done(r) {
    stop();
    show("stDone");
    if (!ov.classList.contains("open"))
      toast("Оплата прошла — билеты придут на email");
    $$("#doneTitle").textContent = "Оплата прошла";
    $$("#doneAmt").textContent = fmt(r.total);
    $$("#doneText").textContent =
      "Заказ оплачен. Билеты отправлены на email (проверьте и «Спам»).";
    $$("#ticketLinks").innerHTML =
      (r.tickets || [])
        .map(
          (t, i) =>
            `<a class="btn btn-red wide" href="${esc(t.url)}" target="_blank" rel="noopener">Открыть билет ${i + 1}: ${esc(t.name)}</a>`,
        )
        .join("") +
      '<button class="btn btn-ghost wide" id="resendBtn" type="button">Отправить письмо ещё раз</button>';
    $$("#resendBtn").addEventListener("click", async () => {
      try {
        await api("/api/orders/" + r.order_id + "/resend", { method: "POST" });
        toast("Письмо отправлено");
      } catch (e) {
        toast(e.message);
      }
    });
    cfg.tickets.forEach((t) => {
      qty[t.id] = 0;
    });
    PROMO = null;
    idemKey = null;
    setMsg("");
    $$("#promoIn").value = "";
    loadEvent();
  }
  function expired() {
    stop();
    show("stDone");
    $$("#doneTitle").textContent = "Время оплаты истекло";
    $$("#doneAmt").textContent = "";
    $$("#ticketLinks").innerHTML = "";
    $$("#doneText").textContent =
      "Билеты вернулись в продажу. Оформите заказ заново.";
    idemKey = null;
    loadEvent();
  }

  /* возврат после СБП/банка: /?order=ID */
  async function resume() {
    const id = new URLSearchParams(location.search).get("order");
    if (!id) return;
    try {
      const r = await api("/api/orders/" + id);
      ov.classList.add("open");
      ov.setAttribute("aria-hidden", "false");
      window.lockPageScroll();
      showOrder(r);
      history.replaceState(null, "", location.pathname);
    } catch (e) {
      toast(e.message);
    }
  }

  loadEvent().then(resume);
})();
