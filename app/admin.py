"""API админки: /api/admin/*. Всё, кроме /login, закрыто cookie-сессией."""

import csv
import io
from pathlib import Path
from datetime import date, datetime, time, timedelta, timezone
from typing import List, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .auth import COOKIE, require_admin
from .account_auth import (
    LoginIn as AccountLoginIn,
    admin_login as account_admin_login,
    verify_csrf,
)
from .config import settings
from .db import SessionLocal, get_session
from .models import (
    Event,
    Order,
    OrderItem,
    OrderStatus,
    Payment,
    PaymentStatus,
    PriceTier,
    PromoCode,
    PromoKind,
    Ticket,
    TicketCategory,
    TicketStatus,
    _aware,
    category_availability,
    utcnow,
)
from .services import ApiError, current_event, issue_tickets, lock_write, promo_uses
from .tickets import SARATOV, notify_paid, send_order_email

router = APIRouter(prefix="/api/admin")
auth = [Depends(require_admin)]


def verify_admin_csrf(request: Request) -> None:
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        verify_csrf(request)


auth.append(Depends(verify_admin_csrf))


# ---------- вход ----------
class LoginIn(BaseModel):
    login: str = settings.admin_login
    password: str


@router.post("/login")
def login(body: LoginIn, request: Request, session: Session = Depends(get_session)):
    account_body = AccountLoginIn(
        login=(body.login or settings.admin_login),
        password=body.password,
    )
    return account_admin_login(account_body, request, session)


@router.post("/logout")
def logout(request: Request):
    verify_csrf(request)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


@router.get("/me", dependencies=auth)
def me():
    return {"ok": True}


# ---------- помощники ----------
def iso(dt: Optional[datetime]) -> Optional[str]:
    return _aware(dt).isoformat() if dt else None


def eff_status(o: Order, now: datetime) -> str:
    return (
        "expired"
        if o.status == OrderStatus.pending and _aware(o.expires_at) <= now
        else o.status.value
    )


def order_row(o: Order, now: datetime) -> dict:
    return {
        "id": o.id,
        "short": o.id[:8].upper(),
        "status": eff_status(o, now),
        "created_at": iso(o.created_at),
        "name": o.customer_name,
        "email": o.email,
        "phone": o.phone,
        "telegram": o.telegram,
        "total": o.total / 100,
        "discount": o.discount / 100,
        "promo_code": o.promo_code,
        "items": ", ".join("%s × %d" % (i.category_name, i.quantity) for i in o.items),
        "paid_at": iso(o.paid_at),
        "email_sent": bool(o.email_sent_at),
    }


def get_order(s: Session, order_id: str) -> Order:
    o = s.get(Order, order_id)
    if not o:
        raise ApiError(404, "order_not_found", "Заказ не найден")
    return o


# ---------- статистика ----------
@router.get("/stats", dependencies=auth)
def stats(session: Session = Depends(get_session)):
    ev, now = current_event(session), utcnow()
    cats = []
    for c in ev.categories:
        sold = (
            session.scalar(
                select(func.coalesce(func.sum(OrderItem.quantity), 0))
                .join(Order, Order.id == OrderItem.order_id)
                .where(OrderItem.category_id == c.id, Order.status == OrderStatus.paid)
            )
            or 0
        )
        left = category_availability(session, c.id, now)
        cats.append(
            {
                "id": c.id,
                "name": c.name,
                "capacity": c.capacity,
                "sold": sold,
                "held": max(0, c.capacity - sold - left),
                "available": left,
            }
        )
    revenue = (
        session.scalar(
            select(func.coalesce(func.sum(Order.total), 0)).where(
                Order.status == OrderStatus.paid
            )
        )
        or 0
    )
    paid = (
        session.scalar(
            select(func.count(Order.id)).where(Order.status == OrderStatus.paid)
        )
        or 0
    )
    return {"revenue": revenue / 100, "paid_orders": paid, "categories": cats}


@router.get("/analytics", dependencies=auth)
def analytics(
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    promo_code: Optional[str] = None,
    session: Session = Depends(get_session),
):
    if date_from and date_to and date_from > date_to:
        raise ApiError(422, "bad_date_range", "Начальная дата не может быть позже конечной")

    saratov = timezone(timedelta(hours=4))
    filters = [Order.status == OrderStatus.paid]
    if date_from:
        start = datetime.combine(date_from, time.min, tzinfo=saratov).astimezone(timezone.utc)
        filters.append(Order.paid_at >= start)
    if date_to:
        end = datetime.combine(date_to + timedelta(days=1), time.min, tzinfo=saratov).astimezone(timezone.utc)
        filters.append(Order.paid_at < end)

    selected_filters = list(filters)
    selected_promo = (promo_code or "").strip().upper()
    if selected_promo:
        selected_filters.append(Order.promo_code == selected_promo)

    paid_orders, revenue = session.execute(
        select(func.count(Order.id), func.coalesce(func.sum(Order.total), 0)).where(*selected_filters)
    ).one()
    tickets_sold = session.scalar(
        select(func.coalesce(func.sum(OrderItem.quantity), 0))
        .join(Order, Order.id == OrderItem.order_id)
        .where(*selected_filters)
    ) or 0
    category_rows = session.execute(
        select(OrderItem.category_name, func.sum(OrderItem.quantity))
        .join(Order, Order.id == OrderItem.order_id)
        .where(*selected_filters)
        .group_by(OrderItem.category_name)
        .order_by(OrderItem.category_name)
    ).all()

    promo_order_rows = session.execute(
        select(
            Order.promo_code,
            func.count(Order.id),
            func.coalesce(func.sum(Order.total), 0),
        )
        .where(*filters, Order.promo_code != "")
        .group_by(Order.promo_code)
        .order_by(Order.promo_code)
    ).all()
    promo_ticket_rows = session.execute(
        select(Order.promo_code, func.coalesce(func.sum(OrderItem.quantity), 0))
        .join(Order, Order.id == OrderItem.order_id)
        .where(*filters, Order.promo_code != "")
        .group_by(Order.promo_code)
    ).all()
    promo_tickets = dict(promo_ticket_rows)
    promo_breakdown = [
        {
            "code": code,
            "paid_orders": order_count,
            "tickets_sold": promo_tickets.get(code, 0),
            "revenue": total / 100,
        }
        for code, order_count, total in promo_order_rows
    ]
    promo_codes = set(session.scalars(select(PromoCode.code)).all())
    promo_codes.update(
        session.scalars(select(Order.promo_code).where(Order.promo_code != "").distinct()).all()
    )

    return {
        "date_from": date_from.isoformat() if date_from else None,
        "date_to": date_to.isoformat() if date_to else None,
        "promo_code": selected_promo or None,
        "tickets_sold": tickets_sold,
        "paid_orders": paid_orders,
        "revenue": revenue / 100,
        "categories": [{"name": name, "tickets_sold": quantity} for name, quantity in category_rows],
        "promo_codes": sorted(promo_codes),
        "promo_breakdown": promo_breakdown,
    }


# ---------- заказы ----------
def _filtered(status: Optional[str], q: Optional[str]):
    stmt = select(Order).order_by(Order.created_at.desc())
    if status:
        try:
            stmt = stmt.where(Order.status == OrderStatus(status))
        except ValueError:
            raise ApiError(422, "bad_status", "Неизвестный статус")
    if q and q.strip():
        like = "%" + q.strip() + "%"
        stmt = stmt.where(
            or_(
                Order.email.ilike(like),
                Order.phone.ilike(like),
                Order.customer_name.ilike(like),
                Order.id.ilike(like),
                Order.telegram.ilike(like),
            )
        )
    return stmt


@router.get("/orders", dependencies=auth)
def orders_list(
    status: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    session: Session = Depends(get_session),
):
    stmt = _filtered(status, q)
    total = session.scalar(
        select(func.count()).select_from(stmt.order_by(None).subquery())
    )
    rows = session.scalars(
        stmt.limit(max(1, min(limit, 200))).offset(max(0, offset))
    ).all()
    now = utcnow()
    return {"total": total, "orders": [order_row(o, now) for o in rows]}


@router.get("/orders/{order_id}", dependencies=auth)
def order_detail(order_id: str, session: Session = Depends(get_session)):
    o = get_order(session, order_id)
    d = order_row(o, utcnow())
    d["payments"] = [
        {
            "provider": p.provider,
            "id": p.provider_payment_id,
            "status": p.status.value,
            "amount": p.amount / 100,
            "needs_refund": bool((p.raw or {}).get("needs_refund")),
            "created_at": iso(p.created_at),
        }
        for p in o.payments
    ]
    d["tickets"] = [
        {
            "name": t.category.name,
            "status": t.status.value,
            "admits": t.admits,
            "entered": t.entered_count,
            "url": "/t/" + t.token,
        }
        for t in o.tickets
    ]
    return d


@router.post("/orders/{order_id}/mark-paid", dependencies=auth)
def mark_paid(order_id: str):
    """Ручное подтверждение оплаты (например, перевод пришёл мимо шлюза)."""
    with SessionLocal() as s:
        lock_write(s)
        o, now = get_order(s, order_id), utcnow()
        if o.status == OrderStatus.paid:
            return {"ok": True}
        if o.status == OrderStatus.refunded:
            raise ApiError(409, "refunded", "Заказ уже возвращён")
        held = o.status == OrderStatus.pending and _aware(o.expires_at) > now
        if not held:
            for i in o.items:
                if category_availability(s, i.category_id, now) < i.quantity:
                    raise ApiError(
                        409, "sold_out", "Билетов «%s» уже не хватает" % i.category_name
                    )
        issue_tickets(s, o, now)
        s.commit()
    notify_paid(order_id)
    return {"ok": True}


@router.post("/orders/{order_id}/refund", dependencies=auth)
def refund(order_id: str):
    """Аннулирует билеты и освобождает места. Деньги возвращаются вручную в кабинете платёжной системы."""
    with SessionLocal() as s:
        lock_write(s)
        o = get_order(s, order_id)
        if o.status != OrderStatus.paid:
            raise ApiError(409, "not_paid", "Вернуть можно только оплаченный заказ")
        for t in o.tickets:
            t.status = TicketStatus.void
        for p in o.payments:
            if p.status == PaymentStatus.succeeded:
                p.status = PaymentStatus.refunded
        if o.promo_id:
            promo = s.get(PromoCode, o.promo_id)
            promo.used_count = max(0, promo.used_count - 1)
        o.status = OrderStatus.refunded
        s.commit()
    return {
        "ok": True,
        "note": "Билеты аннулированы. Деньги верните покупателю в кабинете платёжной системы.",
    }


@router.post("/orders/{order_id}/resend", dependencies=auth)
def resend(order_id: str):
    res = send_order_email(order_id, force=True)
    if res == "too_soon":
        raise ApiError(429, "too_soon", "Письмо уже отправлялось меньше 2 минут назад")
    if res in ("skipped", "failed"):
        raise ApiError(409, res, "Не удалось отправить письмо")
    return {"ok": True, "mode": res}


def _safe(v) -> str:
    v = "" if v is None else str(v)
    return "'" + v if v[:1] in ("=", "+", "-", "@") else v


@router.get("/orders.csv", dependencies=auth)
def orders_csv(
    status: Optional[str] = None,
    q: Optional[str] = None,
    session: Session = Depends(get_session),
):
    now, buf = utcnow(), io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(
        [
            "Заказ",
            "Создан (Саратов)",
            "Статус",
            "Имя",
            "Email",
            "Телефон",
            "Telegram",
            "Состав",
            "Сумма ₽",
            "Промокод",
            "Оплачен",
        ]
    )
    fmt = lambda d: (
        _aware(d).astimezone(SARATOV).strftime("%d.%m.%Y %H:%M") if d else ""
    )
    for o in session.scalars(_filtered(status, q)).all():
        r = order_row(o, now)
        w.writerow(
            [
                _safe(x)
                for x in (
                    r["short"],
                    fmt(o.created_at),
                    r["status"],
                    r["name"],
                    r["email"],
                    r["phone"],
                    r["telegram"],
                    r["items"],
                    r["total"],
                    r["promo_code"],
                    fmt(o.paid_at),
                )
            ]
        )
    return Response(
        "\ufeff" + buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="orders.csv"'},
    )


# ---------- событие ----------
class EventIn(BaseModel):
    title: Optional[str] = None
    eyebrow: Optional[str] = None
    city: Optional[str] = None
    age_limit: Optional[int] = Field(default=None, ge=0, le=99)
    announce: Optional[str] = None
    hero_text: Optional[str] = None
    venue_name: Optional[str] = None
    address: Optional[str] = None
    map_embed: Optional[str] = None
    landmark: Optional[str] = None
    poster_url: Optional[str] = None
    doors_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    is_published: Optional[bool] = None


EVENT_FIELDS = [
    "title",
    "eyebrow",
    "city",
    "age_limit",
    "announce",
    "hero_text",
    "venue_name",
    "address",
    "map_embed",
    "landmark",
    "poster_url",
    "is_published",
]

MAX_POSTER_SIZE = 8 * 1024 * 1024


@router.get("/event", dependencies=auth)
def event_get(session: Session = Depends(get_session)):
    ev = current_event(session)
    d = {k: getattr(ev, k) for k in EVENT_FIELDS}
    d.update(doors_at=iso(ev.doors_at), ends_at=iso(ev.ends_at))
    return d


@router.put("/event", dependencies=auth)
def event_put(body: EventIn, session: Session = Depends(get_session)):
    lock_write(session)
    ev = current_event(session)
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is not None:
            setattr(ev, k, v)
    if _aware(ev.ends_at) <= _aware(ev.doors_at):
        raise ApiError(
            422, "bad_time", "Конец мероприятия должен быть позже открытия дверей"
        )
    session.commit()
    return {"ok": True}


@router.post("/event/poster", dependencies=auth)
async def event_poster_upload(
    file: UploadFile = File(...), session: Session = Depends(get_session)
):
    content = await file.read(MAX_POSTER_SIZE + 1)
    if len(content) > MAX_POSTER_SIZE:
        raise ApiError(
            413, "poster_too_large", "Размер изображения не должен превышать 8 МБ"
        )

    if content.startswith(b"\xff\xd8\xff"):
        extension = "jpg"
    elif content.startswith(b"\x89PNG\r\n\x1a\n"):
        extension = "png"
    elif content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        extension = "webp"
    else:
        raise ApiError(415, "invalid_poster", "Загрузите изображение JPG, PNG или WebP")

    upload_dir = Path(__file__).resolve().parent.parent / "static" / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid4().hex}.{extension}"
    image_path = upload_dir / filename
    poster_url = f"/uploads/{filename}"

    committed = False
    try:
        image_path.write_bytes(content)
        lock_write(session)
        ev = current_event(session)
        ev.poster_url = poster_url
        session.commit()
        committed = True
    finally:
        if not committed:
            image_path.unlink(missing_ok=True)

    return {"ok": True, "poster_url": poster_url}


# ---------- тарифы и цены ----------
@router.get("/categories", dependencies=auth)
def categories_get(session: Session = Depends(get_session)):
    ev = current_event(session)
    return [
        {
            "id": c.id,
            "code": c.code,
            "name": c.name,
            "description": c.description,
            "capacity": c.capacity,
            "max_per_order": c.max_per_order,
            "admits": c.admits,
            "is_active": c.is_active,
            "is_featured": c.is_featured,
            "prices": [
                {
                    "price": p.price / 100,
                    "valid_from": iso(p.valid_from),
                    "valid_until": iso(p.valid_until),
                    "note": p.note,
                }
                for p in c.prices
            ],
        }
        for c in ev.categories
    ]


class CategoryIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = None
    capacity: Optional[int] = Field(default=None, ge=0)
    max_per_order: Optional[int] = Field(default=None, ge=1, le=50)
    is_active: Optional[bool] = None
    is_featured: Optional[bool] = None


@router.put("/categories/{cid}", dependencies=auth)
def category_put(cid: int, body: CategoryIn, session: Session = Depends(get_session)):
    lock_write(session)
    c = session.get(TicketCategory, cid)
    if not c:
        raise ApiError(404, "not_found", "Тариф не найден")
    data = body.model_dump(exclude_unset=True)
    if data.get("capacity") is not None:
        taken = c.capacity - category_availability(session, cid, utcnow())
        if data["capacity"] < taken:
            raise ApiError(
                409,
                "capacity_low",
                "Уже продано или удерживается %d — меньше поставить нельзя" % taken,
            )
    for k, v in data.items():
        if v is not None:
            setattr(c, k, v)
    session.commit()
    return {"ok": True}


class PriceIn(BaseModel):
    price: float = Field(ge=0)  # в рублях
    valid_from: Optional[datetime] = None
    valid_until: Optional[datetime] = None
    note: str = ""


@router.put("/categories/{cid}/prices", dependencies=auth)
def prices_put(cid: int, body: List[PriceIn], session: Session = Depends(get_session)):
    """Полная замена списка цен. Уже созданные заказы цену не меняют."""
    if not body:
        raise ApiError(422, "no_prices", "Нужна хотя бы одна цена")
    lock_write(session)
    c = session.get(TicketCategory, cid)
    if not c:
        raise ApiError(404, "not_found", "Тариф не найден")
    for p in list(c.prices):
        session.delete(p)
    session.flush()
    for p in body:
        session.add(
            PriceTier(
                category_id=cid,
                price=int(round(p.price * 100)),
                valid_from=p.valid_from,
                valid_until=p.valid_until,
                note=p.note.strip()[:120],
            )
        )
    session.commit()
    return {"ok": True}


# ---------- промокоды ----------
def promo_row(p: PromoCode, session: Session, now: datetime) -> dict:
    return {
        "id": p.id,
        "code": p.code,
        "kind": p.kind.value,
        "value": p.value if p.kind == PromoKind.percent else p.value / 100,
        "max_uses": p.max_uses,
        "used": promo_uses(session, p.id, now),
        "is_active": p.is_active,
        "valid_until": iso(p.valid_until),
    }


@router.get("/promos", dependencies=auth)
def promos_get(session: Session = Depends(get_session)):
    now = utcnow()
    return [
        promo_row(p, session, now)
        for p in session.scalars(select(PromoCode).order_by(PromoCode.id)).all()
    ]


class PromoIn(BaseModel):
    code: str = Field(min_length=2, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    kind: str = Field(pattern="^(percent|fixed)$")
    value: float = Field(gt=0)  # % или рубли
    max_uses: Optional[int] = Field(default=None, ge=1)
    valid_until: Optional[datetime] = None


@router.post("/promos", dependencies=auth)
def promo_create(body: PromoIn, session: Session = Depends(get_session)):
    code = body.code.upper()
    if body.kind == "percent" and body.value > 100:
        raise ApiError(422, "bad_value", "Процент не больше 100")
    lock_write(session)
    if session.scalar(select(PromoCode).where(PromoCode.code == code)):
        raise ApiError(409, "exists", "Такой код уже есть")
    session.add(
        PromoCode(
            code=code,
            kind=PromoKind(body.kind),
            max_uses=body.max_uses,
            value=(
                int(round(body.value))
                if body.kind == "percent"
                else int(round(body.value * 100))
            ),
            valid_until=body.valid_until,
        )
    )
    session.commit()
    return {"ok": True}


class PromoPatch(BaseModel):
    is_active: Optional[bool] = None
    max_uses: Optional[int] = Field(default=None, ge=1)


@router.patch("/promos/{pid}", dependencies=auth)
def promo_patch(pid: int, body: PromoPatch, session: Session = Depends(get_session)):
    lock_write(session)
    p = session.get(PromoCode, pid)
    if not p:
        raise ApiError(404, "not_found", "Промокод не найден")
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is not None:
            setattr(p, k, v)
    session.commit()
    return {"ok": True}


@router.delete("/promos/{pid}", dependencies=auth)
def promo_delete(pid: int, session: Session = Depends(get_session)):
    lock_write(session)
    p = session.get(PromoCode, pid)
    if not p:
        raise ApiError(404, "not_found", "Промокод не найден")
    if session.scalar(select(func.count(Order.id)).where(Order.promo_id == pid)):
        raise ApiError(
            409,
            "in_use",
            "Код уже использован в заказах — отключите его вместо удаления",
        )
    session.delete(p)
    session.commit()
    return {"ok": True}
