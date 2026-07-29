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
