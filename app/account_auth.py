"""Регистрация и авторизация пользователей: bcrypt, сессии и подтверждение email."""

import hashlib
import hmac
import html
import logging
import re
import secrets
import smtplib
import time
from datetime import timedelta
from email.message import EmailMessage
from email.utils import formataddr

import bcrypt
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import COOKIE, CSRF_COOKIE, TTL, make_session_token
from .config import settings
from .db import SessionLocal, get_session
from .models import (
    AuthRateLimit,
    EmailVerificationToken,
    LoginAttempt,
    User,
    UserRole,
    _aware,
    utcnow,
)
from .services import ApiError

router = APIRouter(prefix="/api/auth")
log = logging.getLogger("rave.auth")

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
LOGIN_RE = re.compile(r"^[A-Za-z0-9_.@-]{3,64}$")
_DUMMY_PASSWORD_HASH = bcrypt.hashpw(
    b"invalid-login-timing", bcrypt.gensalt(rounds=12)
).decode("ascii")


class RegisterIn(BaseModel):
    login: str = Field(min_length=3, max_length=64)
    email: str = Field(min_length=3, max_length=200)
    name: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=8, max_length=128)
    password2: str = Field(min_length=8, max_length=128)

    @field_validator("password", "password2")
    @classmethod
    def bcrypt_password_length(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Пароль должен занимать не более 72 байт")
        return value


class LoginIn(BaseModel):
    login: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("password")
    @classmethod
    def bcrypt_password_length(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Пароль должен занимать не более 72 байт")
        return value


class ResendIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)


class VerifyIn(BaseModel):
    token: str = Field(min_length=32, max_length=128)


def clean_login(value: str) -> str:
    value = value.strip().lower()
    if not LOGIN_RE.fullmatch(value):
        raise ApiError(422, "bad_login", "Логин содержит недопустимые символы")
    return value


def clean_email(value: str) -> str:
    value = value.strip().lower()
    if not EMAIL_RE.fullmatch(value) or len(value) > 200:
        raise ApiError(422, "bad_email", "Проверьте email")
    return value


def rate_limit(
    session: Session, request: Request, bucket: str, limit: int, seconds: int
) -> None:
    ip = request.client.host if request.client else "?"
    client_key = hashlib.sha256(ip.encode("utf-8")).hexdigest()
    now = utcnow()
    cutoff = now - timedelta(seconds=seconds)
    for attempt in range(2):
        session.connection(execution_options={"immediate": True})
        session.execute(
            delete(AuthRateLimit).where(
                AuthRateLimit.window_started_at < now - timedelta(days=1),
            )
        )
        session.execute(
            delete(LoginAttempt).where(
                LoginAttempt.at < now - timedelta(days=90),
            )
        )
        row = session.scalar(
            select(AuthRateLimit)
            .where(
                AuthRateLimit.bucket == bucket,
                AuthRateLimit.client_key == client_key,
            )
            .with_for_update()
        )
        if not row:
            row = AuthRateLimit(
                bucket=bucket, client_key=client_key, window_started_at=now, attempts=0
            )
            session.add(row)
            try:
                session.flush()
            except IntegrityError:
                session.rollback()
                continue
        elif _aware(row.window_started_at) <= cutoff:
            row.window_started_at = now
            row.attempts = 0
        if row.attempts >= limit:
            session.commit()
            log.warning("Rate limit exceeded bucket=%s ip=%s", bucket, ip)
            raise ApiError(429, "too_many", "Слишком много запросов. Попробуйте позже.")
        row.attempts += 1
        session.commit()
        return
    log.error("Unable to persist auth rate limit bucket=%s", bucket)
    raise ApiError(
        503,
        "rate_limit_unavailable",
        "Не удалось проверить частоту запросов. Попробуйте позже.",
    )


def verify_csrf(request: Request) -> None:
    def reject(message: str) -> None:
        log.warning(
            "CSRF validation failed ip=%s path=%s",
            request.client.host if request.client else "?",
            request.url.path,
        )
        raise ApiError(403, "csrf", message)

    cookie = request.cookies.get(CSRF_COOKIE, "")
    header = request.headers.get("x-csrf-token", "")
    if not cookie or not header or not secrets.compare_digest(cookie, header):
        reject("Проверьте сессию и обновите страницу")
    parts = cookie.split(".")
    if len(parts) != 3:
        reject("Проверьте сессию и обновите страницу")
    payload, signature = ".".join(parts[:2]), parts[2]
    expected = hmac.new(
        settings.secret_key.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()
    try:
        valid = hmac.compare_digest(signature, expected) and int(parts[0]) > int(
            time.time()
        )
    except ValueError:
        valid = False
    if not valid:
        reject("Срок действия токена истёк")


def set_session(response: JSONResponse, role: str, user_id: int) -> None:
    response.set_cookie(
        COOKIE,
        make_session_token(role, user_id),
        max_age=TTL,
        httponly=True,
        samesite="strict",
        secure=settings.public_base_url.startswith("https"),
        path="/",
    )


def password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode(
        "ascii"
    )


def password_ok(password: str, stored: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), stored.encode("ascii"))
    except (ValueError, UnicodeEncodeError):
        return False


def token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def failed_logins(session: Session, ip: str) -> int:
    cutoff = utcnow() - timedelta(minutes=5)
    return (
        session.scalar(
            select(func.count(LoginAttempt.id))
            .where(LoginAttempt.ip == ip)
            .where(LoginAttempt.succeeded.is_(False))
            .where(LoginAttempt.at >= cutoff)
        )
        or 0
    )


def require_smtp_configured() -> None:
    if not settings.smtp_host:
        raise ApiError(
            503, "email_disabled", "Регистрация требует настроенной отправки SMTP-почты"
        )


def build_verification_email(name: str, token: str) -> EmailMessage:
    link = "%s/verify-email?token=%s" % (settings.public_base_url.rstrip("/"), token)
    safe_name = html.escape(name)
    msg = EmailMessage()
    msg["Subject"] = "Подтвердите email — THE RAVE"
    msg["From"] = formataddr(("THE RAVE", settings.smtp_from))
    msg.set_content(
        "Здравствуйте, %s!\n\nПодтвердите email: %s\n\nСсылка действует 24 часа."
        % (name, link)
    )
    msg.add_alternative(
        '<div style="font-family:Arial,sans-serif;background:#09050a;color:#f6f1f1;padding:24px">'
        "<b>THE RAVE</b><p>Здравствуйте, %s!</p>"
        '<p><a href="%s" style="display:inline-block;padding:12px 18px;background:#b3122d;color:#fff;'
        'text-decoration:none;border-radius:999px">Подтвердить email</a></p>'
        '<p style="color:#a99d9f;font-size:13px">Ссылка одноразовая и действует 24 часа.</p></div>'
        % (safe_name, html.escape(link, quote=True)),
        subtype="html",
    )
    return msg


def deliver_verification(email: str, name: str, raw_token: str) -> None:
    msg = build_verification_email(name, raw_token)
    msg["To"] = email
    if not settings.smtp_host:
        raise ApiError(503, "email_disabled", "Почтовая отправка не настроена")
    cls = (
        smtplib.SMTP_SSL
        if settings.smtp_use_ssl or settings.smtp_port == 465
        else smtplib.SMTP
    )
    try:
        with cls(settings.smtp_host, settings.smtp_port, timeout=20) as smtp:
            if cls is smtplib.SMTP and settings.smtp_port != 25:
                smtp.starttls()
            if settings.smtp_user:
                smtp.login(settings.smtp_user, settings.smtp_password)
            smtp.send_message(msg)
    except (OSError, smtplib.SMTPException):
        log.exception("Verification email delivery failed")
        raise ApiError(
            502,
            "email_delivery_failed",
            "Не удалось отправить письмо. Повторите попытку позже.",
        )


@router.get("/csrf")
def csrf():
    payload = "%d.%s" % (int(time.time()) + 7200, secrets.token_urlsafe(24))
    signature = hmac.new(
        settings.secret_key.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()
    raw = payload + "." + signature
    response = JSONResponse({"csrf": raw})
    response.set_cookie(
        CSRF_COOKIE,
        raw,
        max_age=7200,
        httponly=True,
        samesite="strict",
        secure=settings.public_base_url.startswith("https"),
        path="/",
    )
    return response


@router.post("/register")
def register(
    body: RegisterIn, request: Request, session: Session = Depends(get_session)
):
    verify_csrf(request)
    rate_limit(session, request, "register", 5, 3600)
    require_smtp_configured()
    login, email = clean_login(body.login), clean_email(body.email)
    name = re.sub(r"\s+", " ", body.name).strip()
    if not 2 <= len(name) <= 120:
        raise ApiError(422, "bad_name", "Введите имя")
    if body.password != body.password2:
        raise ApiError(422, "password_mismatch", "Пароли не совпадают")
    if len(set(body.password)) < 3:
        raise ApiError(422, "weak_password", "Используйте более сложный пароль")
    if session.scalar(
        select(User).where((User.login == login) | (User.email == email))
    ):
        return JSONResponse(
            {
                "ok": True,
                "message": "Если регистрация возможна, проверьте почту или запросите письмо повторно.",
            },
            status_code=200,
        )
    user = User(
        login=login,
        email=email,
        name=name,
        password_hash=password_hash(body.password),
        role=UserRole.user,
    )
    session.add(user)
    raw = secrets.token_urlsafe(32)
    try:
        session.flush()
        session.add(
            EmailVerificationToken(
                user_id=user.id,
                token_hash=token_hash(raw),
                expires_at=utcnow() + timedelta(hours=settings.verification_hours),
            )
        )
        session.commit()
    except IntegrityError:
        session.rollback()
        return {
            "ok": True,
            "message": "Если регистрация возможна, проверьте почту или запросите письмо повторно.",
        }
    try:
        deliver_verification(email, name, raw)
    except ApiError as error:
        log.warning("Verification email failed for user_id=%d: %s", user.id, error.code)
    return {
        "ok": True,
        "message": "Если регистрация возможна, проверьте почту или запросите письмо повторно.",
    }


@router.post("/login")
def login(body: LoginIn, request: Request, session: Session = Depends(get_session)):
    verify_csrf(request)
    rate_limit(session, request, "login", 10, 300)
    ip = request.client.host if request.client else ""
    if failed_logins(session, ip) >= 5:
        log.warning("Login temporarily blocked ip=%s", ip)
        raise ApiError(
            429, "too_many", "Слишком много попыток. Попробуйте через несколько минут."
        )
    value = body.login.strip().lower()
    user = session.scalar(
        select(User).where((User.login == value) | (User.email == value))
    )
    valid = (
        password_ok(body.password, user.password_hash if user else _DUMMY_PASSWORD_HASH)
        and user is not None
    )
    session.add(LoginAttempt(login=token_hash(value)[:64], ip=ip, succeeded=valid))
    if not valid:
        session.commit()
        log.warning("Failed login ip=%s", ip)
        raise ApiError(401, "bad_credentials", "Неверный логин или пароль")
    if user.role == UserRole.user and not user.email_verified:
        session.commit()
        raise ApiError(
            403,
            "email_not_verified",
            "Подтвердите email. При необходимости запросите письмо повторно.",
        )
    session.commit()
    response = JSONResponse(
        {
            "ok": True,
            "user": {"name": user.name, "login": user.login, "role": user.role.value},
        }
    )
    set_session(response, user.role.value, user.id)
    return response


@router.post("/admin/login")
def admin_login(
    body: LoginIn, request: Request, session: Session = Depends(get_session)
):
    verify_csrf(request)
    rate_limit(session, request, "admin_login", 8, 300)
    ip = request.client.host if request.client else ""
    if failed_logins(session, ip) >= 5:
        log.warning("Admin login temporarily blocked ip=%s", ip)
        raise ApiError(
            429, "too_many", "Слишком много попыток. Попробуйте через несколько минут."
        )
    login = body.login.strip().lower()
    user = session.scalar(
        select(User).where(User.login == login).where(User.role == UserRole.admin)
    )
    valid = (
        password_ok(body.password, user.password_hash if user else _DUMMY_PASSWORD_HASH)
        and user is not None
    )
    if not valid:
        session.add(LoginAttempt(login=token_hash(login), ip=ip, succeeded=False))
        session.commit()
        log.warning("Unauthorized admin login ip=%s", ip)
        raise ApiError(401, "bad_credentials", "Неверный логин или пароль")
    session.add(LoginAttempt(login=token_hash(login), ip=ip, succeeded=True))
    session.commit()
    response = JSONResponse({"ok": True, "redirect": "/admin"})
    set_session(response, "admin", user.id)
    return response


@router.post("/logout")
def logout(request: Request):
    verify_csrf(request)
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE, path="/")
    return response


@router.get("/me")
def me(request: Request):
    from .auth import read_session

    session_info = read_session(request.cookies.get(COOKIE, ""))
    if not session_info:
        return JSONResponse({"authenticated": False}, status_code=200)
    role, user_id = session_info
    with SessionLocal() as session:
        user = session.get(User, user_id)
    if not user or user.role.value != role:
        return {"authenticated": False}
    return {
        "authenticated": True,
        "user": {
            "name": user.name,
            "login": user.login,
            "email": user.email,
            "role": role,
        },
    }


@router.post("/verify-email")
def verify_email(
    body: VerifyIn, request: Request, session: Session = Depends(get_session)
):
    verify_csrf(request)
    rate_limit(session, request, "verify", 20, 3600)
    digest = token_hash(body.token)
    record = session.scalar(
        select(EmailVerificationToken).where(
            EmailVerificationToken.token_hash == digest
        )
    )
    if not record:
        raise ApiError(400, "bad_token", "Неверная ссылка подтверждения")
    if record.used_at:
        raise ApiError(409, "already_used", "Email уже подтверждён")
    now = utcnow()
    if _aware(record.expires_at) <= now:
        raise ApiError(410, "expired_token", "Ссылка истекла")
    user = session.get(User, record.user_id)
    if not user:
        raise ApiError(400, "bad_token", "Неверная ссылка подтверждения")
    marked = session.execute(
        update(EmailVerificationToken)
        .where(EmailVerificationToken.id == record.id)
        .where(EmailVerificationToken.used_at.is_(None))
        .where(EmailVerificationToken.expires_at > now)
        .values(used_at=now)
    )
    if marked.rowcount != 1:
        raise ApiError(409, "already_used", "Ссылка уже использована или истекла")
    user.email_verified = True
    user.email_verified_at = now
    session.commit()
    return {"ok": True, "message": "Email успешно подтверждён"}


@router.post("/resend")
def resend(body: ResendIn, request: Request, session: Session = Depends(get_session)):
    verify_csrf(request)
    rate_limit(session, request, "resend", 3, 3600)
    require_smtp_configured()
    email = clean_email(body.email)
    user = session.scalar(select(User).where(User.email == email))
    if user and not user.email_verified:
        latest = session.scalar(
            select(EmailVerificationToken)
            .where(
                EmailVerificationToken.user_id == user.id,
            )
            .order_by(EmailVerificationToken.created_at.desc())
        )
        now = utcnow()
        if (
            not latest
            or not latest.created_at
            or (now - _aware(latest.created_at)).total_seconds() >= 60
        ):
            session.execute(
                update(EmailVerificationToken)
                .where(EmailVerificationToken.user_id == user.id)
                .where(EmailVerificationToken.used_at.is_(None))
                .values(used_at=now)
            )
            raw = secrets.token_urlsafe(32)
            session.add(
                EmailVerificationToken(
                    user_id=user.id,
                    token_hash=token_hash(raw),
                    expires_at=now + timedelta(hours=settings.verification_hours),
                )
            )
            session.commit()
            try:
                deliver_verification(user.email, user.name, raw)
            except ApiError as error:
                log.warning(
                    "Verification resend failed for user_id=%d: %s", user.id, error.code
                )
    return {
        "ok": True,
        "message": "Если такой email зарегистрирован, письмо отправлено",
    }
