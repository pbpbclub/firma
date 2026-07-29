"""Витрина УСН (routers/taxes.py): база налога — только ПОСТУПЛЕНИЯ.

Инцидент 29.07.2026: запрос дохода фильтровал `amount > 0` без `direction='in'`,
а в finance.db суммы положительны у обеих ног — списания попадали в доход,
база УСН за 2026 удвоилась (8,47 млн вместо 4,23 млн), фантомный налог +254 тыс.
"""
from datetime import datetime

import pytest

import routers.taxes as taxes


class _NoClose:
    """sqlite3.Connection с заглушенным close(): эндпоинт закрывает соединение
    в finally, а фикстуре оно нужно живым на все проверки теста."""
    def __init__(self, conn): self._c = conn
    def __getattr__(self, name): return getattr(self._c, name)
    def close(self): pass


@pytest.fixture
def fin(monkeypatch):
    """In-memory finance.db с боевой схемой transactions (клон CREATE, mode=ro)."""
    import sqlite3
    src = sqlite3.connect("file:/opt/fin-agent/data/finance.db?mode=ro", uri=True, timeout=15)
    try:
        stmts = [r[0] for r in src.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL "
            "AND name NOT LIKE 'sqlite_%'")]
    finally:
        src.close()
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    for stmt in stmts:
        c.execute(stmt)
    wrapped = _NoClose(c)
    monkeypatch.setattr(taxes, "get_finance", lambda: wrapped)
    yield c
    c.close()


def _tx(conn, amount, direction, date=None, counterparty="ООО Клиент", purpose="оплата"):
    conn.execute(
        "INSERT INTO transactions (bank, account, date, amount, direction, counterparty, purpose) "
        "VALUES ('tbank', 'acc', ?, ?, ?, ?, ?)",
        (date or f"{datetime.now().year}-02-10", amount, direction, counterparty, purpose))


class TestTaxBase:
    def test_база_усн_только_поступления(self, fin):
        _tx(fin, 100_000, "in")
        _tx(fin, 40_000, "out")          # списание: в finance.db тоже положительное
        s = taxes.tax_summary()
        assert s["income_year"] == 100_000
        assert s["tax_year"] == 6_000    # 6% от поступлений, не от оборота

    def test_квартальная_база_тоже_только_in(self, fin):
        y = datetime.now().year
        q = taxes.current_quarter()
        in_q = f"{y}-{(q - 1) * 3 + 1:02d}-05"
        _tx(fin, 50_000, "in", date=in_q)
        _tx(fin, 20_000, "out", date=in_q)
        s = taxes.tax_summary()
        assert s["income_quarter"] == 50_000
