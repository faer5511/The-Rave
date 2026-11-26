import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any, Dict
from urllib.parse import urlsplit, urlunsplit

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .admin import router as admin_router
from .account_auth import router as account_router
from .config import settings
from .db import SessionLocal, engine, ensure_index, get_session
from .models import (
    Base,
    Event,
    Order,
    OrderStatus,
    Ticket,
    USER_LOGIN_CASE_INSENSITIVE_INDEX,
    _aware,
    category_availability,
    utcnow,
)
from .payments import PaymentError, get_provider
from .schemas import OrderIn, PromoCheckIn
from .tickets import notify_paid, render_ticket_page, send_order_email
from .services import (
    ApiError,
    apply_payment_result,
    create_order,
    current_event,
    ensure_payment,
    expire_stale,
    find_promo,
    lock_write,
    payment_payload,
    sync_order,
)

log = logging.getLogger("rave")


def _expire_once():
    with SessionLocal() as s:
        lock_write(s)
        expire_stale(s, utcnow())
        s.commit()


async def _expire_loop():
    while True:
        await asyncio.sleep(60)
        try:
            await run_in_threadpool(_expire_once)
        except Exception:
            log.exception("expire loop")


@asynccontextmanager
async def lifespan(_app):
    Base.metadata.create_all(engine)
    ensure_index(USER_LOGIN_CASE_INSENSITIVE_INDEX)
    task = asyncio.create_task(_expire_loop())
    yield
    task.cancel()


app = FastAPI(title="THE RAVE", lifespan=lifespan)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    public = urlsplit(settings.public_base_url)
    if public.scheme == "https" and request.url.scheme != "https":
        canonical_url = urlunsplit(
            (
                "https",
                public.netloc,
                request.url.path,
                request.url.query,
                "",
            )
        )
        return RedirectResponse(canonical_url, status_code=308)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; "
        "frame-ancestors 'none'; img-src 'self' data: https: blob:; style-src 'self' 'unsafe-inline' "
        "https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; "
        "script-src 'self' https://yookassa.ru; frame-src 'self' https://yookassa.ru "
        "https://maps.google.com https://www.google.com https://yandex.ru; "
        "connect-src 'self' https://yookassa.ru"
    )
    if public.scheme == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000"
    return response


@app.exception_handler(ApiError)
async def _api_error(_req, e: ApiError):
    return JSONResponse(
        {"error": e.code, "message": e.message, **e.extra}, status_code=e.status
    )


@app.exception_handler(RequestValidationError)
async def _validation(_req, e):
    return JSONResponse(
        {"error": "validation", "message": "Проверьте данные формы"}, status_code=422
    )


app.include_router(admin_router)
app.include_router(account_router)


@app.get("/admin", include_in_schema=False)
def admin_page(request: Request):
    from .auth import require_admin

    try:
        require_admin(request)
    except ApiError:
        return RedirectResponse("/admin/login")
    return FileResponse("static/admin.html")


@app.get("/admin/login", include_in_schema=False)
def admin_login_page():
    return FileResponse("static/admin-login.html")


@app.get("/admin.html", include_in_schema=False)
def legacy_admin_page():
    return RedirectResponse("/admin")


@app.get("/verify-email", include_in_schema=False)
def verify_email_page(token: str = ""):
    if token:
        return RedirectResponse("/?verify=" + token)
    return RedirectResponse("/")


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/event")
def event(session: Session = Depends(get_session)):
    ev = current_event(session)
    now = utcnow()
    cats = []
    for c in ev.categories:
        if not c.is_active:
            continue
        p, nxt = c.current_price(now), c.next_price(now)
        cats.append(
            {
                "id": c.id,
                "code": c.code,
                "name": c.name,
                "description": c.description,
                "price": (p.price if p else 0) / 100,
                "note": (p.note if p else ""),
                "next_price": nxt.price / 100 if nxt else None,
                "admits": c.admits,
                "featured": c.is_featured,
                "max_per_order": c.max_per_order,
                "available": category_availability(session, c.id, now),
            }
        )
    return {
        "title": ev.title,
        "eyebrow": ev.eyebrow,
        "city": ev.city,
        "age": ev.age_limit,
        "doors_at": ev.doors_at.isoformat(),
        "ends_at": ev.ends_at.isoformat(),
        "venue": ev.venue_name,
        "address": ev.address,
        "map_embed": ev.map_embed,
        "landmark": ev.landmark,
        "announce": ev.announce,
        "hero_text": ev.hero_text,
        "poster_url": ev.poster_url,
        "categories": cats,
    }


@app.post("/api/promo/check")
def promo_check(body: PromoCheckIn, session: Session = Depends(get_session)):
    ev = current_event(session)
    p = find_promo(session, body.code, ev.id, utcnow())
    if p.kind.value == "percent":
        msg = "Промокод применён: скидка %d%%" % p.value
    else:
        msg = "Промокод применён: скидка %d ₽" % (p.value // 100)
    return {"code": p.code, "kind": p.kind.value, "value": p.value, "message": msg}


def _order_view(
    session: Session, order: Order, with_payment: bool = True
) -> Dict[str, Any]:
    now = utcnow()
    status = order.status.value
    if order.status == OrderStatus.pending and _aware(order.expires_at) <= now:
        status = "expired"
    view = {
        "order_id": order.id,
        "status": status,
        "total": order.total / 100,
        "discount": order.discount / 100,
        "promo_code": order.promo_code,
        "expires_at": _aware(order.expires_at).isoformat(),
        "items": [
            {"name": i.category_name, "quantity": i.quantity, "sum": i.line_total / 100}
            for i in order.items
        ],
        "tickets_count": len(order.tickets),
        "payment": None,
        "tickets": (
            [
                {"name": t.category.name, "admits": t.admits, "url": "/t/" + t.token}
                for t in order.tickets
            ]
            if status == "paid"
            else []
        ),
    }
    if with_payment and status == "pending":
        pay = ensure_payment(session, order, get_provider())
        if pay:
            view["payment"] = payment_payload(pay)
    return view


@app.post("/api/orders")
def orders_create(body: OrderIn, session: Session = Depends(get_session)):
    if body.website:  # honeypot
        raise ApiError(400, "bad_request", "Запрос отклонён")
    order = create_order(session, body)
    if order.status == OrderStatus.paid and not order.email_sent_at:
        notify_paid(order.id)  # бесплатный заказ (скидка 100%)
    return _order_view(session, order)


@app.get("/api/orders/{order_id}")
def order_get(order_id: str):
    sync_order(order_id, get_provider())  # подстраховка на случай недошедшего вебхука
    with SessionLocal() as s:
        order = s.scalar(select(Order).where(Order.id == order_id))
        if not order:
            raise ApiError(404, "order_not_found", "Заказ не найден")
        return _order_view(s, order)


@app.get("/t/{token}", response_class=HTMLResponse)
def ticket_page(token: str):
    with SessionLocal() as s:
        t = s.scalar(select(Ticket).where(Ticket.token == token))
        order = s.get(Order, t.order_id) if t else None
        if not t or order.status != OrderStatus.paid:
            return HTMLResponse("<h1>Билет не найден</h1>", status_code=404)
        return HTMLResponse(render_ticket_page(t, order, s.get(Event, order.event_id)))


@app.post("/api/orders/{order_id}/resend")
def order_resend(order_id: str):
    """Повторная отправка письма с теми же билетами (не чаще раза в 2 минуты)."""
    res = send_order_email(order_id, force=True)
    if res == "too_soon":
        raise ApiError(
            429, "too_soon", "Письмо уже отправлено. Повторить можно через пару минут."
        )
    if res in ("skipped", "failed"):
        raise ApiError(
            409 if res == "skipped" else 502, res, "Не удалось отправить письмо"
        )
    return {"ok": True, "mode": res}


@app.post("/api/payments/webhook")
async def payments_webhook(request: Request):
    """Уведомления ЮKassa. Телу не доверяем: статус перепроверяем запросом к API."""
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"ok": False}, status_code=400)
    obj = payload.get("object") or {}
    pid = obj.get("id")
    if payload.get("event") not in ("payment.succeeded", "payment.canceled") or not pid:
        return {"ok": True}
    provider = get_provider()
    if provider.name != "yookassa":
        return {"ok": True}
    try:
        remote = await run_in_threadpool(provider.get_payment, pid)
    except PaymentError:
        return JSONResponse({"ok": False}, status_code=500)  # пусть ЮKassa повторит
    await run_in_threadpool(
        apply_payment_result, "yookassa", pid, remote.get("status", ""), remote
    )
    return {"ok": True}


@app.post("/api/mock/pay/{payment_id}")
def mock_pay(payment_id: str):
    """Только для PAYMENT_MODE=mock: имитирует успешную оплату."""
    if settings.payment_mode != "mock":
        raise ApiError(404, "not_found", "Не найдено")
    oid = apply_payment_result(
        "mock", payment_id, "succeeded", {"id": payment_id, "status": "succeeded"}
    )
    if not oid:
        raise ApiError(404, "payment_not_found", "Платёж не найден")
    return {"ok": True, "order_id": oid}


# Ваш сайт отдаётся с того же сервера: static/index.html
app.mount("/", StaticFiles(directory="static", html=True), name="static")
