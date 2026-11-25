"""QR-билеты: страница билета, письмо с QR, отправка (SMTP или папка data/outbox без настройки почты)."""

import html
import logging
import smtplib
import threading
from datetime import timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from pathlib import Path
from string import Template
from typing import List

import segno

from .config import settings
from .db import SessionLocal
from .models import Event, Order, OrderStatus, Ticket, _aware, utcnow

log = logging.getLogger("rave")
SARATOV = timezone(timedelta(hours=4))
MONTHS = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
]
STATUS = {"valid": "Действителен", "used": "Уже использован", "void": "Аннулирован"}
e = html.escape
TICKET_TEMPLATE = Template(
    (Path(__file__).parent / "templates" / "ticket.html").read_text(encoding="utf-8")
)


def ticket_url(t: Ticket) -> str:
    return "%s/t/%s" % (settings.public_base_url.rstrip("/"), t.token)


def qr_png(data: str) -> bytes:
    import io

    buf = io.BytesIO()
    segno.make(data, error="m").save(
        buf, kind="png", scale=8, border=2, dark="#000000", light="#ffffff"
    )
    return buf.getvalue()


def qr_svg(data: str) -> str:
    return segno.make(data, error="m").svg_inline(
        border=2, dark="#000000", light="#ffffff", omitsize=True
    )


def when(ev: Event):
    d, f = _aware(ev.doors_at).astimezone(SARATOV), _aware(ev.ends_at).astimezone(
        SARATOV
    )
    return (
        "%d %s %d" % (d.day, MONTHS[d.month - 1], d.year),
        d.strftime("%H:%M"),
        f.strftime("%H:%M"),
    )


def persons(n: int) -> str:
    return "1 человек" if n == 1 else "%d человека" % n if n < 5 else "%d человек" % n


def render_ticket_page(t: Ticket, order: Order, ev: Event) -> str:
    date, doors, end = when(ev)
    st = t.status.value
    return TICKET_TEMPLATE.substitute(
        status_class="valid" if st == "valid" else "inactive",
        category_name=e(t.category.name),
        admits=persons(t.admits),
        status=e(STATUS.get(st, st)),
        qr_svg=qr_svg(ticket_url(t)),
        date=e(date),
        doors=e(doors),
        end=e(end),
        venue=e(ev.venue_name),
        address=e(ev.address),
        customer_name=e(order.customer_name),
        order_id=e(order.id[:8].upper()),
    )


def build_email(order: Order, tickets: List[Ticket], ev: Event) -> EmailMessage:
    date, doors, end = when(ev)
    msg = EmailMessage()
    msg["Subject"] = "Ваши билеты THE RAVE · %s" % date
    msg["From"] = formataddr(("THE RAVE", settings.smtp_from))
    msg["To"] = order.email
    lines = [
        "Здравствуйте, %s!" % order.customer_name,
        "",
        "Спасибо за заказ. Ваши билеты:",
        "",
    ]
    for i, t in enumerate(tickets, 1):
        lines.append(
            "%d. %s (%s): %s" % (i, t.category.name, persons(t.admits), ticket_url(t))
        )
    lines += [
        "",
        "%s, %s — %s. %s, %s." % (date, doors, end, ev.venue_name, ev.address),
        "Покажите QR-код на входе.",
    ]
    msg.set_content("\n".join(lines))
    cids = [make_msgid(domain="rave.local") for _ in tickets]
    blocks = "".join(
        '<div style="margin:18px 0;padding:18px;border:1px solid #3a1a22;border-radius:18px;background:#140a0d">'
        '<b style="font-size:18px">%s</b><div style="color:#a99d9f;font-size:14px">Проход: %s</div>'
        '<div style="background:#fff;display:inline-block;padding:8px;border-radius:12px;margin-top:12px">'
        '<img src="cid:%s" width="220" height="220" alt="QR"></div>'
        '<div style="margin-top:10px"><a style="color:#e2455d" href="%s">Открыть билет</a></div></div>'
        % (e(t.category.name), persons(t.admits), cid[1:-1], e(ticket_url(t)))
        for t, cid in zip(tickets, cids)
    )
    msg.add_alternative(
        '<div style="background:#09050a;color:#f6f1f1;font-family:Arial,sans-serif;padding:24px">'
        '<div style="letter-spacing:.2em;font-weight:700">THE RAVE</div>'
        '<p style="font-size:16px">Здравствуйте, %s! Ваши билеты готовы.</p>%s'
        '<p style="color:#a99d9f">%s, %s — %s<br>%s, %s</p></div>'
        % (
            e(order.customer_name),
            blocks,
            e(date),
            e(doors),
            e(end),
            e(ev.venue_name),
            e(ev.address),
        ),
        subtype="html",
    )
    html_part = msg.get_payload()[1]
    for t, cid in zip(tickets, cids):
        html_part.add_related(qr_png(ticket_url(t)), "image", "png", cid=cid)
    return msg


def _deliver(msg: EmailMessage, order_id: str) -> str:
    if settings.smtp_host:
        cls = (
            smtplib.SMTP_SSL
            if (settings.smtp_use_ssl or settings.smtp_port == 465)
            else smtplib.SMTP
        )
        with cls(settings.smtp_host, settings.smtp_port, timeout=20) as smtp:
            if cls is smtplib.SMTP and settings.smtp_port != 25:
                smtp.starttls()
            if settings.smtp_user:
                smtp.login(settings.smtp_user, settings.smtp_password)
            smtp.send_message(msg)
        return "smtp"
    out = Path("data/outbox")  # почта не настроена: складываем письмо в файл
    out.mkdir(parents=True, exist_ok=True)
    (out / ("%s.eml" % order_id)).write_bytes(bytes(msg))
    log.warning("SMTP не настроен: письмо сохранено в data/outbox/%s.eml", order_id)
    return "outbox"


def send_order_email(order_id: str, force: bool = False) -> str:
    """Отправка не более одного раза (захват через email_sent_at). force — повторная отправка без перевыпуска."""
    with SessionLocal() as s:
        s.connection(execution_options={"immediate": True})
        order = s.get(Order, order_id)
        if not order or order.status != OrderStatus.paid:
            return "skipped"
        now = utcnow()
        if order.email_sent_at and not force:
            return "already_sent"
        if (
            force
            and order.email_sent_at
            and (now - _aware(order.email_sent_at)).total_seconds() < 120
        ):
            return "too_soon"
        order.email_sent_at = now
        s.commit()
        try:
            msg = build_email(order, list(order.tickets), s.get(Event, order.event_id))
            return _deliver(msg, order.id)
        except Exception:
            log.exception("Не удалось отправить письмо по заказу %s", order_id)
            order.email_sent_at = None
            s.commit()
            return "failed"


def notify_paid(order_id: str) -> None:
    threading.Thread(target=send_order_email, args=(order_id,), daemon=True).start()
