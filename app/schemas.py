import re
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
TG_RE = re.compile(r"^@?[A-Za-z0-9_]{5,32}$")


class ItemIn(BaseModel):
    category_id: int
    quantity: int = Field(ge=1, le=50)


class PromoCheckIn(BaseModel):
    code: str = Field(min_length=1, max_length=40)


class OrderIn(BaseModel):
    items: List[ItemIn] = Field(min_length=1, max_length=10)
    promo_code: Optional[str] = None
    name: str
    email: str
    telegram: Optional[str] = None
    consent: bool
    idempotency_key: str
    website: Optional[str] = None  # honeypot: у людей пустое

    @field_validator("name")
    @classmethod
    def _name(cls, v):
        v = v.strip()
        if not 2 <= len(v) <= 120:
            raise ValueError("Введите имя")
        return v

    @field_validator("email")
    @classmethod
    def _email(cls, v):
        v = v.strip().lower()
        if not EMAIL_RE.match(v) or len(v) > 200:
            raise ValueError("Проверьте email")
        return v

    @field_validator("telegram")
    @classmethod
    def _tg(cls, v):
        v = (v or "").strip()
        if not v:
            return None
        if not TG_RE.match(v):
            raise ValueError("Формат Telegram: @username")
        return v if v.startswith("@") else "@" + v

    @field_validator("consent")
    @classmethod
    def _consent(cls, v):
        if not v:
            raise ValueError("Нужно согласие на обработку данных")
        return v

    @field_validator("idempotency_key")
    @classmethod
    def _key(cls, v):
        if not KEY_RE.match(v):
            raise ValueError("Некорректный ключ запроса")
        return v
