"""Подписанная краткоживущая cookie-сессия с проверкой роли по БД."""
import hashlib
import hmac
import secrets
import time
import logging
from typing import Optional

from fastapi import Request
from sqlalchemy import select

from .config import settings
from .db import SessionLocal
from .models import User, UserRole
from .services import ApiError

COOKIE = "rave_auth"
TTL = max(1, settings.session_hours) * 3600
CSRF_COOKIE = "rave_csrf"
log = logging.getLogger("rave.auth")


def _sig(payload: str) -> str:
    return hmac.new(settings.secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()


def make_session_token(role: str, user_id: int) -> str:
    nonce = secrets.token_urlsafe(16)
    p = "%s.%d.%d.%s" % (role, user_id, int(time.time()) + TTL, nonce)
    return "%s.%s" % (p, _sig(p))


def read_role(token: str) -> Optional[str]:
    session = read_session(token)
    return session[0] if session else None


def read_session(token: str) -> Optional[tuple]:
    """Возвращает (роль, user_id) только для действующей подписанной сессии."""
    parts = (token or "").split(".")
    if len(parts) != 5:
        return None
    payload, sig = ".".join(parts[:-1]), parts[-1]
    if not hmac.compare_digest(sig, _sig(payload)):
        return None
    role, user_id, exp, _nonce = parts[:-1]
    try:
        if not _nonce or role not in (UserRole.user.value, UserRole.admin.value):
            return None
        if int(exp) <= time.time() or int(user_id) <= 0:
            return None
        return role, int(user_id)
    except ValueError:
        return None


def require_admin(request: Request) -> None:
    session = read_session(request.cookies.get(COOKIE, ""))
    if not session or session[0] != UserRole.admin.value:
        log.warning("Admin access denied ip=%s path=%s",
                    request.client.host if request.client else "?", request.url.path)
        raise ApiError(401, "unauthorized", "Нужен вход")
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.id == session[1], User.role == UserRole.admin))
    if not user:
        log.warning("Admin access denied for inactive role ip=%s path=%s",
                    request.client.host if request.client else "?", request.url.path)
        raise ApiError(401, "unauthorized", "Нужен вход")
