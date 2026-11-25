"""python -m app.seed  — создаёт таблицы и тестовые данные (повторный запуск безопасен)."""

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
import bcrypt

from .db import SessionLocal, engine
from .models import (
    Base,
    Event,
    PriceTier,
    PromoCode,
    PromoKind,
    TicketCategory,
    User,
    UserRole,
)
from .config import settings

MSK = timezone(timedelta(hours=4))  # Саратов, UTC+4


def run():
    Base.metadata.create_all(engine)
    with SessionLocal() as s:
        if settings.admin_password:
            login = settings.admin_login.strip().lower()
            admin = s.scalar(select(User).where(User.login == login))
            if not admin:
                s.add(
                    User(
                        login=login,
                        email="%s@localhost" % login,
                        name="Администратор",
                        password_hash=bcrypt.hashpw(
                            settings.admin_password.encode(), bcrypt.gensalt(rounds=12)
                        ).decode(),
                        role=UserRole.admin,
                        email_verified=True,
                    )
                )
                s.commit()
        if s.scalar(select(Event).where(Event.slug == "the-rave-2026-12-19")):
            print("Данные уже есть")
            return
        ev = Event(
            slug="the-rave-2026-12-19",
            title="THE RAVE",
            eyebrow="СВОЯ ВОЛНА · 14+",
            city="Саратов",
            hero_text="THE RAVE — это большая семья, где каждый находит свою волну.",
            announce="Один вечер, один зал и громкая музыка для тех, кто пришёл за своей волной.",
            age_limit=14,
            doors_at=datetime(2026, 12, 19, 17, 0, tzinfo=MSK),
            ends_at=datetime(2026, 12, 19, 21, 0, tzinfo=MSK),
            venue_name="Кластер Н",
            address="Саратов, Привокзальная площадь, 1Д",
            landmark="Ориентир — Привокзальная площадь, рядом с ж/д вокзалом.",
        )
        raise_at = datetime(2026, 12, 15, 0, 0, tzinfo=MSK)  # «через 4 дня»
        ev.categories = [
            TicketCategory(
                code="dance",
                name="Танцпол",
                description="Проход на мероприятие",
                capacity=300,
                sort_order=1,
                prices=[PriceTier(price=27900)],
            ),
            TicketCategory(
                code="pair",
                name="Парный танцпол",
                admits=2,
                is_featured=True,
                description="Проход на мероприятие для двух персон",
                capacity=100,
                sort_order=2,
                prices=[
                    PriceTier(
                        price=44900, valid_until=raise_at, note="через 4 дня 549 ₽"
                    ),
                    PriceTier(price=54900, valid_from=raise_at),
                ],
            ),
            TicketCategory(
                code="vip",
                name="VIP",
                capacity=40,
                sort_order=3,
                description="Отдельный вход без очереди, VIP зона, место за столом, бар и уборные",
                prices=[PriceTier(price=59900)],
            ),
        ]
        s.add(ev)
        s.add_all(
            [
                PromoCode(code="RAVE10", kind=PromoKind.percent, value=10),
                PromoCode(code="WAVE50", kind=PromoKind.fixed, value=5000),
            ]
        )
        s.commit()
        print("Готово: событие, 3 тарифа, 2 промокода")


if __name__ == "__main__":
    run()
