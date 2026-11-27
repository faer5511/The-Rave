"""Бизнес-логика: промокоды, резерв билетов, заказ, оплата, выдача билетов."""

import logging
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from .config import settings
from .db import SessionLocal
from .models import (
    Event,
    Order,
    OrderItem,
    OrderStatus,
    Payment,
    PaymentStatus,
    PromoCode,
    Ticket,
    TicketCategory,
    _aware,
    category_availability,
    utcnow,
)
from .money import calc_discount
from .payments import PaymentError
from .tickets import notify_paid

log = logging.getLogger("rave")


class ApiError(Exception):
    def __init__(
        self, status: int, code: str, message: str, extra: Optional[dict] = None
    ):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = (
            status,
            code,
            message,
            extra or {},
        )


def lock_write(session: Session) -> None:
    """Первым вызовом в сессии: берём блокировку записи (SQLite BEGIN IMMEDIATE)."""
    session.connection(execution_options={"immediate": True})


# ---------- промокоды ----------
def promo_uses(session: Session, promo_id: int, now: datetime) -> int:
    return (
        session.scalar(
            select(func.count(Order.id))
            .where(Order.promo_id == promo_id)
            .where(
                (Order.status == OrderStatus.paid)
                | ((Order.status == OrderStatus.pending) & (Order.expires_at > now))
            )
        )
        or 0
    )


def find_promo(session: Session, code: str, event_id: int, now: datetime) -> PromoCode:
    code = (code or "").strip().upper()
    p = session.scalar(select(PromoCode).where(PromoCode.code == code))
    if not p or not p.is_active or (p.event_id is not None and p.event_id != event_id):
        raise ApiError(404, "promo_not_found", "Такого промокода нет")
    if p.valid_from and _aware(p.valid_from) > now:
        raise ApiError(422, "promo_not_started", "Промокод ещё не действует")
    if p.valid_until and _aware(p.valid_until) <= now:
        raise ApiError(422, "promo_expired", "Срок действия промокода истёк")
    if p.max_uses is not None and promo_uses(session, p.id, now) >= p.max_uses:
        raise ApiError(422, "promo_exhausted", "Лимит использований промокода исчерпан")
    return p


def current_event(session: Session) -> Event:
    ev = session.scalar(
        select(Event).where(Event.is_published).order_by(Event.doors_at)
    )
    if not ev:
        raise ApiError(404, "no_event", "Событие не найдено")
    return ev


# ---------- заказ ----------
def expire_stale(session: Session, now: datetime) -> None:
    session.execute(
        update(Order)
        .where(Order.status == OrderStatus.pending, Order.expires_at <= now)
        .values(status=OrderStatus.expired)
    )


def create_order(session: Session, data) -> Order:
    """Атомарно: проверка остатков + резерв + запись заказа. Повтор с тем же ключом вернёт тот же заказ."""
    lock_write(session)
    existing = session.scalar(
        select(Order).where(Order.idempotency_key == data.idempotency_key)
    )
    if existing:
        return existing
    now = utcnow()
    expire_stale(session, now)
    ev = current_event(session)

    wanted: Dict[int, int] = {}
    for it in data.items:
        wanted[it.category_id] = wanted.get(it.category_id, 0) + it.quantity

    items, subtotal = [], 0
    for cid, qty in wanted.items():
        cat = session.scalar(
            select(TicketCategory).where(TicketCategory.id == cid).with_for_update()
        )
        if not cat or cat.event_id != ev.id or not cat.is_active:
            raise ApiError(404, "category_not_found", "Тариф недоступен")
        if qty > cat.max_per_order:
            raise ApiError(
                422,
                "too_many",
                "«%s»: не более %d за заказ" % (cat.name, cat.max_per_order),
            )
        left = category_availability(session, cid, now)
        if qty > left:
            raise ApiError(
                409,
                "sold_out",
                (
                    "«%s»: осталось %d" % (cat.name, left)
                    if left
                    else "«%s» распродан" % cat.name
                ),
                {"category_id": cid, "available": left},
            )
        price = cat.current_price(now)
        if not price:
            raise ApiError(409, "no_price", "Для тарифа «%s» не задана цена" % cat.name)
        items.append(
            OrderItem(
                category_id=cid,
                category_name=cat.name,
                quantity=qty,
                unit_price=price.price,
                line_total=price.price * qty,
            )
        )
        subtotal += price.price * qty

    promo, discount = None, 0
    if data.promo_code and data.promo_code.strip():
        promo = find_promo(session, data.promo_code, ev.id, now)
        discount = calc_discount(promo.kind.value, promo.value, subtotal)

    order = Order(
        event_id=ev.id,
        idempotency_key=data.idempotency_key,
        customer_name=data.name,
        email=data.email,
        phone="",
        telegram=data.telegram or "",
        subtotal=subtotal,
        discount=discount,
        total=subtotal - discount,
        promo_id=promo.id if promo else None,
        promo_code=promo.code if promo else "",
        consent_at=now,
        expires_at=now + timedelta(minutes=settings.hold_minutes),
    )
    order.items = items
    session.add(order)
    session.flush()
    if order.total == 0:  # бесплатный заказ (скидка 100%) — сразу выдаём билеты
        issue_tickets(session, order, now)
    session.commit()
    return order


def issue_tickets(session: Session, order: Order, now: datetime) -> None:
    if order.tickets:
        return
    for it in order.items:
        cat = session.get(TicketCategory, it.category_id)
        for _ in range(it.quantity):
            session.add(
                Ticket(order_id=order.id, category_id=cat.id, admits=cat.admits)
            )
    if order.promo_id:
        promo = session.get(PromoCode, order.promo_id)
        promo.used_count += 1
    order.status = OrderStatus.paid
    order.paid_at = now


# ---------- платежи ----------
def payment_payload(pay: Payment) -> Dict[str, Any]:
    conf = (pay.raw or {}).get("confirmation") or {}
    return {
        "mode": pay.provider,
        "payment_id": pay.provider_payment_id,
        "confirmation_token": conf.get("confirmation_token", ""),
        "return_url": "%s/?order=%s"
        % (settings.public_base_url.rstrip("/"), pay.order_id),
    }


def ensure_payment(session: Session, order: Order, provider) -> Optional[Payment]:
    """Возвращает активный платёж заказа или создаёт новую попытку."""
    if order.status != OrderStatus.pending or order.total <= 0:
        return None
    if _aware(order.expires_at) <= utcnow():
        return None
    rows = session.scalars(
        select(Payment)
        .where(Payment.order_id == order.id, Payment.provider == provider.name)
        .order_by(Payment.id)
    ).all()
    for p in reversed(rows):
        if p.status == PaymentStatus.pending:
            return p
    try:
        res = provider.create_payment(
            order,
            "%s/?order=%s" % (settings.public_base_url.rstrip("/"), order.id),
            "%s-%d" % (order.id, len(rows) + 1),
        )
    except PaymentError as e:
        log.error("create_payment failed: %s", e)
        raise ApiError(
            502,
            "payment_unavailable",
            "Платёжный сервис недоступен. Попробуйте ещё раз.",
        )
    pay = Payment(
        order_id=order.id,
        provider=provider.name,
        provider_payment_id=res["id"],
        amount=order.total,
        raw=res,
    )
    session.add(pay)
    session.commit()
    return pay


def apply_payment_result(
    provider_name: str, payment_id: str, status: str, raw: Dict[str, Any]
) -> Optional[str]:
    """Идемпотентно применяет статус платежа (вебхук, опрос, mock). Возвращает order_id."""
    with SessionLocal() as s:
        lock_write(s)
        pay = s.scalar(
            select(Payment).where(
                Payment.provider == provider_name,
                Payment.provider_payment_id == payment_id,
            )
        )
        if not pay:
            return None
        order = s.get(Order, pay.order_id)
        now = utcnow()
        if status == "succeeded" and pay.status != PaymentStatus.succeeded:
            pay.status, pay.raw = PaymentStatus.succeeded, raw
            if order.status == OrderStatus.pending:
                issue_tickets(s, order, now)
            elif order.status in (OrderStatus.expired, OrderStatus.cancelled):
                # оплатили после истечения удержания: пробуем вернуть билеты, если они ещё свободны
                if all(
                    category_availability(s, i.category_id, now) >= i.quantity
                    for i in order.items
                ):
                    issue_tickets(s, order, now)
                else:
                    pay.raw = dict(raw, needs_refund=True)
                    log.error(
                        "ТРЕБУЕТСЯ ВОЗВРАТ: заказ %s оплачен после истечения, билетов нет",
                        order.id,
                    )
        elif status == "canceled" and pay.status == PaymentStatus.pending:
            pay.status, pay.raw = PaymentStatus.canceled, raw
        s.commit()
        if order.status == OrderStatus.paid and not order.email_sent_at:
            notify_paid(order.id)
        return order.id


def sync_order(order_id: str, provider) -> None:
    """Подстраховка, если вебхук не дошёл (локальная разработка): спрашиваем статус у ЮKassa."""
    if provider.name != "yookassa":
        return
    with SessionLocal() as s:
        ids = s.scalars(
            select(Payment.provider_payment_id).where(
                Payment.order_id == order_id,
                Payment.status == PaymentStatus.pending,
                Payment.provider == "yookassa",
            )
        ).all()
    for pid in ids:
        try:
            remote = provider.get_payment(pid)
        except PaymentError as e:
            log.warning("sync failed: %s", e)
            continue
        if remote:
            apply_payment_result("yookassa", pid, remote.get("status", ""), remote)
