"""Общие фикстуры тестов Фирмы.

Боевые базы не трогаем ни на чтение данных, ни тем более на запись: из
production.db берётся ТОЛЬКО текст CREATE-выражений (mode=ro), данные каждый
тест насыпает себе сам. Схема клонируется, а не описывается руками, — правило
code_rules 24.07: контракт это схема, а не её пересказ в другом файле.
"""
import sqlite3
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))

PROD = Path("/opt/ai-os/data/production.db")


@pytest.fixture(scope="session")
def schema_sql() -> list[str]:
    con = sqlite3.connect(f"file:{PROD}?mode=ro", uri=True, timeout=15)
    try:
        return [r[0] for r in con.execute(
            "SELECT sql FROM sqlite_master WHERE type IN ('table','index') "
            "AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")]
    finally:
        con.close()


@pytest.fixture
def conn(schema_sql):
    """Пустая база с боевой схемой. In-memory — на диск ничего не попадает."""
    c = sqlite3.connect(":memory:", timeout=15)
    c.row_factory = sqlite3.Row
    for stmt in schema_sql:
        try:
            c.execute(stmt)
        except sqlite3.OperationalError:
            # Индекс на таблицу из другой базы (ATTACH) — для тестов не нужен.
            pass
    yield c
    c.close()


def _startup_migrations() -> list[str]:
    """Список миграций читаем из main.py::startup, а не дублируем: новая
    миграция попадает под тесты сама, без правки фикстур."""
    import re
    body = (BACKEND / "main.py").read_text().split("def startup():", 1)[1]
    return [n for n in re.findall(r"^\s{4}(\w+)\(\)", body, re.M) if n != "init_admin"]


@pytest.fixture
def migrated(tmp_path, monkeypatch, schema_sql):
    """Клон боевой схемы В ФАЙЛЕ + все startup-миграции поверх.

    Нужна тестам, которые опираются на колонки СВЕЖЕЙ миграции: `conn` клонирует
    схему боевой базы, где новых колонок ещё нет (миграция доедет при рестарте
    сервиса). Файл, а не :memory:, — миграции ходят через db.get_production()."""
    import db
    prod, fin = tmp_path / "production.db", tmp_path / "finance.db"
    c = sqlite3.connect(prod)
    for stmt in schema_sql:
        try:
            c.execute(stmt)
        except sqlite3.OperationalError:
            pass
    c.commit()
    c.close()
    sqlite3.connect(fin).close()
    monkeypatch.setattr(db, "PRODUCTION_DB", prod)
    monkeypatch.setattr(db, "FINANCE_DB", fin)
    for name in _startup_migrations():
        getattr(db, name)()
    c = db.get_production()
    yield c
    c.close()
