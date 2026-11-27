"""Модели THE RAVE. Деньги везде в копейках (int). Время — UTC.
Совместимо с Python 3.9: вместо `X | None` используется Optional[X]."""

import enum
import secrets
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    select,
)
from sqlalchemy.types import TypeDecorator
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_order_id() -> str:
    return uuid.uuid4().hex  # публичный id заказа (не угадывается)


def new_ticket_token() -> str:
    return secrets.token_urlsafe(24)  # содержимое QR; позже подписываем HMAC


class UTCDateTime(TypeDecorator):
    """Хранит время как UTC, отдаёт aware-datetime (SQLite сам пояс не хранит)."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).replace(tzinfo=None)

    def process_result_value(self, value, dialect):
        return None if value is None else value.replace(tzinfo=timezone.utc)


class Base(DeclarativeBase):
    pass


class OrderStatus(str, enum.Enum):
    pending = "pending"  # создан, билеты удерживаются до expires_at
    paid = "paid"
    expired = "expired"  # не оплатили вовремя, билеты вернулись в продажу
    cancelled = "cancelled"
    refunded = "refunded"


class PaymentStatus(str, enum.Enum):
    pending = "pending"
    succeeded = "succeeded"
    canceled = "canceled"
    refunded = "refunded"


class TicketStatus(str, enum.Enum):
    valid = "valid"
    used = "used"  # все гости по билету прошли
    void = "void"  # аннулирован (возврат)


class PromoKind(str, enum.Enum):
    percent = "percent"
    fixed = "fixed"  # скидка в копейках на весь заказ


class Event(Base):
    __tablename__ = "events"
    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    title: Mapped[str] = mapped_column(String(200))
    announce: Mapped[str] = mapped_column(Text, default="")
    hero_text: Mapped[str] = mapped_column(Text, default="")
    eyebrow: Mapped[str] = mapped_column(String(120), default="")
    city: Mapped[str] = mapped_column(String(80), default="")
    age_limit: Mapped[int] = mapped_column(Integer, default=14)
    doors_at: Mapped[datetime] = mapped_column(UTCDateTime())
    ends_at: Mapped[datetime] = mapped_column(UTCDateTime())
    venue_name: Mapped[str] = mapped_column(String(200), default="")
    address: Mapped[str] = mapped_column(String(300), default="")
    map_embed: Mapped[str] = mapped_column(Text, default="")
    landmark: Mapped[str] = mapped_column(Text, default="")
    poster_url: Mapped[str] = mapped_column(String(500), default="")
    is_published: Mapped[bool] = mapped_column(Boolean, default=True)

    categories: Mapped[list["TicketCategory"]] = relationship(
        back_populates="event",
        order_by="TicketCategory.sort_order",
        cascade="all, delete-orphan",
    )


class TicketCategory(Base):
    """Тариф: Танцпол / Парный танцпол / VIP. capacity считается в единицах продажи."""

    __tablename__ = "ticket_categories"
    __table_args__ = (
        UniqueConstraint("event_id", "code"),
        CheckConstraint("capacity >= 0"),
        CheckConstraint("admits >= 1"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"))
    code: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    capacity: Mapped[int] = mapped_column(Integer)  # всего единиц в продаже
    admits: Mapped[int] = mapped_column(
        Integer, default=1
    )  # человек на 1 билет (парный = 2)
    max_per_order: Mapped[int] = mapped_column(Integer, default=10)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_featured: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    event: Mapped[Event] = relationship(back_populates="categories")
    prices: Mapped[list["PriceTier"]] = relationship(
        back_populates="category",
        order_by="PriceTier.valid_from",
        cascade="all, delete-orphan",
    )

    def current_price(self, now: Optional[datetime] = None) -> Optional["PriceTier"]:
        """Последний подходящий по дате тариф цены (для «через 4 дня 549 ₽»)."""
        now = now or utcnow()
        ok = [
            p
            for p in self.prices
            if (p.valid_from is None or _aware(p.valid_from) <= now)
            and (p.valid_until is None or _aware(p.valid_until) > now)
        ]
        return max(
            ok,
            key=lambda p: (
                _aware(p.valid_from)
                if p.valid_from
                else datetime.min.replace(tzinfo=timezone.utc)
            ),
            default=None,
        )

    def next_price(self, now: Optional[datetime] = None) -> Optional["PriceTier"]:
        now = now or utcnow()
        future = [p for p in self.prices if p.valid_from and _aware(p.valid_from) > now]
        return min(future, key=lambda p: _aware(p.valid_from), default=None)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class PriceTier(Base):
    """Цена по периоду: valid_from/valid_until пустые = действует всегда."""

    __tablename__ = "price_tiers"
    __table_args__ = (CheckConstraint("price >= 0"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    category_id: Mapped[int] = mapped_column(
        ForeignKey("ticket_categories.id", ondelete="CASCADE")
    )
    price: Mapped[int] = mapped_column(Integer)  # копейки
    valid_from: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    valid_until: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    note: Mapped[str] = mapped_column(String(120), default="")  # плашка на сайте

    category: Mapped[TicketCategory] = relationship(back_populates="prices")


class PromoCode(Base):
    __tablename__ = "promo_codes"
    __table_args__ = (CheckConstraint("value > 0"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(
        String(40), unique=True
    )  # храним в верхнем регистре
    kind: Mapped[PromoKind] = mapped_column(Enum(PromoKind))
    value: Mapped[int] = mapped_column(Integer)  # % или копейки
    event_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("events.id")
    )  # None = на любое событие
    max_uses: Mapped[Optional[int]] = mapped_column(Integer)  # None = без лимита
    used_count: Mapped[int] = mapped_column(Integer, default=0)
    valid_from: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    valid_until: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (Index("ix_orders_status_expires", "status", "expires_at"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_order_id)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    status: Mapped[OrderStatus] = mapped_column(
        Enum(OrderStatus), default=OrderStatus.pending
    )
    idempotency_key: Mapped[str] = mapped_column(
        String(64), unique=True
    )  # защита от дублей
    customer_name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(200), index=True)
    phone: Mapped[str] = mapped_column(String(32), index=True)
    telegram: Mapped[str] = mapped_column(String(64), default="")
    subtotal: Mapped[int] = mapped_column(Integer)  # копейки до скидки
    discount: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer)
    promo_id: Mapped[Optional[int]] = mapped_column(ForeignKey("promo_codes.id"))
    promo_code: Mapped[str] = mapped_column(String(40), default="")  # снимок кода
    consent_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())  # конец удержания
    paid_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    email_sent_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())

    items: Mapped[list["OrderItem"]] = relationship(
        back_populates="order", cascade="all, delete-orphan"
    )
    tickets: Mapped[list["Ticket"]] = relationship(back_populates="order")
    payments: Mapped[list["Payment"]] = relationship(back_populates="order")


class OrderItem(Base):
    __tablename__ = "order_items"
    __table_args__ = (CheckConstraint("quantity > 0"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"))
    category_id: Mapped[int] = mapped_column(ForeignKey("ticket_categories.id"))
    category_name: Mapped[str] = mapped_column(String(120))  # снимок названия
    quantity: Mapped[int] = mapped_column(Integer)
    unit_price: Mapped[int] = mapped_column(Integer)  # снимок цены, копейки
    line_total: Mapped[int] = mapped_column(Integer)

    order: Mapped[Order] = relationship(back_populates="items")


class Payment(Base):
    """Попытка оплаты. provider_payment_id уникален, поэтому повторный вебхук не создаст дубль."""

    __tablename__ = "payments"
    __table_args__ = (UniqueConstraint("provider", "provider_payment_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    provider: Mapped[str] = mapped_column(String(32))  # mock | yookassa
    provider_payment_id: Mapped[str] = mapped_column(String(64))
    status: Mapped[PaymentStatus] = mapped_column(
        Enum(PaymentStatus), default=PaymentStatus.pending
    )
    amount: Mapped[int] = mapped_column(Integer)
    raw: Mapped[Optional[dict]] = mapped_column(JSON)  # последний ответ/вебхук
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow, onupdate=utcnow
    )

    order: Mapped[Order] = relationship(back_populates="payments")


class Ticket(Base):
    """Один билет = один QR. Создаётся только после успешной оплаты."""

    __tablename__ = "tickets"
    __table_args__ = (CheckConstraint("entered_count <= admits"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("ticket_categories.id"))
    token: Mapped[str] = mapped_column(
        String(64), unique=True, default=new_ticket_token
    )
    admits: Mapped[int] = mapped_column(Integer, default=1)  # сколько человек проходит
    entered_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[TicketStatus] = mapped_column(
        Enum(TicketStatus), default=TicketStatus.valid
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    first_used_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())

    order: Mapped[Order] = relationship(back_populates="tickets")
    category: Mapped[TicketCategory] = relationship()


class UserRole(str, enum.Enum):
    user = "user"
    admin = "admin"


class User(Base):
    """Аккаунт владельца билетов или администратора."""

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("length(login) >= 3"),
        CheckConstraint("length(email) >= 3"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    login: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(Enum(UserRole), default=UserRole.user)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    email_verified_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow, onupdate=utcnow
    )


USER_LOGIN_CASE_INSENSITIVE_INDEX = Index(
    "uq_users_login_case_insensitive", func.lower(User.login), unique=True
)


class AdminProfile(Base):
    """Дополнительные данные профиля администратора."""

    __tablename__ = "admin_profiles"
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    avatar_url: Mapped[Optional[str]] = mapped_column(String(500))
    description: Mapped[str] = mapped_column(Text, default="")


class EmailVerificationToken(Base):
    """Одноразовый email-код или старый токен-ссылка: в БД хранится только хеш."""

    __tablename__ = "email_verification_tokens"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    used_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class LoginAttempt(Base):
    """Журнал и агрегация подозрительных попыток входа."""

    __tablename__ = "login_attempts"
    id: Mapped[int] = mapped_column(primary_key=True)
    login: Mapped[str] = mapped_column(String(64), index=True)
    ip: Mapped[str] = mapped_column(String(64), default="")
    succeeded: Mapped[bool] = mapped_column(Boolean, default=False)
    at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class AuthRateLimit(Base):
    """Persistent per-IP auth throttling shared across worker processes."""

    __tablename__ = "auth_rate_limits"
    __table_args__ = (Index("ix_auth_rate_limits_window", "window_started_at"),)
    bucket: Mapped[str] = mapped_column(String(32), primary_key=True)
    client_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    window_started_at: Mapped[datetime] = mapped_column(UTCDateTime())
    attempts: Mapped[int] = mapped_column(Integer, default=0)


class ScanLog(Base):
    """Журнал сканирований (для споров на входе)."""

    __tablename__ = "scan_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_id: Mapped[Optional[int]] = mapped_column(ForeignKey("tickets.id"))
    token_tail: Mapped[str] = mapped_column(String(12), default="")
    result: Mapped[str] = mapped_column(
        String(24)
    )  # ok | already_used | invalid | void
    operator: Mapped[str] = mapped_column(String(64), default="")
    at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


def category_availability(
    session, category_id: int, now: Optional[datetime] = None
) -> int:
    """Остаток = capacity − оплаченные − удерживаемые (pending и не просроченные)."""
    now = now or utcnow()
    cat = session.get(TicketCategory, category_id)
    taken = session.execute(
        select(func.coalesce(func.sum(OrderItem.quantity), 0))
        .join(Order, Order.id == OrderItem.order_id)
        .where(OrderItem.category_id == category_id)
        .where(
            (Order.status == OrderStatus.paid)
            | ((Order.status == OrderStatus.pending) & (Order.expires_at > now))
        )
    ).scalar_one()
    return max(0, cat.capacity - taken)
