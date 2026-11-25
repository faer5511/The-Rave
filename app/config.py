import secrets
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./data/rave.db"
    public_base_url: str = "http://localhost:8000"
    secret_key: str = Field(default_factory=lambda: secrets.token_urlsafe(48))
    hold_minutes: int = 15
    admin_password: str = ""             # пароль входа администратора

    payment_mode: Literal["mock", "yookassa"] = "mock"
    yookassa_shop_id: str = ""
    yookassa_secret_key: str = ""
    yookassa_send_receipt: bool = False  # включите, если у магазина подключены онлайн-чеки (54-ФЗ)

    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_use_ssl: bool = False           # True для порта 465
    smtp_from: str = "tickets@example.com"
    verification_hours: int = Field(default=24, ge=1, le=168)
    session_hours: int = Field(default=12, ge=1, le=24)
    admin_login: str = Field(default="admin", min_length=3, max_length=64)

    @field_validator("admin_password")
    @classmethod
    def validate_admin_password_length(cls, value: str) -> str:
        if value and len(value.encode("utf-8")) > 72:
            raise ValueError("ADMIN_PASSWORD must not exceed bcrypt's 72-byte limit")
        return value

    @model_validator(mode="after")
    def validate_auth_security(self):
        if len(self.secret_key) < 32 or self.secret_key in {
            "dev-secret-change-me",
            "change-me-to-long-random-string",
        }:
            raise ValueError("SECRET_KEY must be a persistent random value of at least 32 characters")
        parsed = urlsplit(self.public_base_url)
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("PUBLIC_BASE_URL must use HTTPS outside localhost")
        if self.payment_mode == "mock" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("PAYMENT_MODE=mock is only allowed on localhost")
        return self


settings = Settings()
