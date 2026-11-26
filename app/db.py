import os
from sqlalchemy import Index, create_engine, event, text
from sqlalchemy.orm import sessionmaker

from .config import settings

IS_SQLITE = settings.database_url.startswith("sqlite")

if settings.database_url.startswith("sqlite:///./"):
    os.makedirs(
        os.path.dirname(settings.database_url.replace("sqlite:///", "")) or ".",
        exist_ok=True,
    )

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False} if IS_SQLITE else {},
)

if IS_SQLITE:

    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_conn, _):
        dbapi_conn.isolation_level = None  # транзакциями управляем сами (см. _on_begin)
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()

    @event.listens_for(engine, "begin")
    def _on_begin(conn):
        # execution_options(immediate=True) -> сразу берём блокировку записи:
        # так два параллельных заказа не смогут купить последние билеты одновременно.
        immediate = conn.get_execution_options().get("immediate")
        conn.exec_driver_sql("BEGIN IMMEDIATE" if immediate else "BEGIN")


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def ensure_index(index: Index) -> None:
    if engine.dialect.name == "sqlite":
        with engine.connect() as connection:
            exists = connection.scalar(
                text("SELECT 1 FROM sqlite_master WHERE type='index' AND name=:name"),
                {"name": index.name},
            )
        if exists:
            return
        index.create(engine, checkfirst=False)
        return
    index.create(engine, checkfirst=True)


def get_session():
    with SessionLocal() as s:
        yield s
