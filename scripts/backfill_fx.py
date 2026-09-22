#!/usr/bin/env python3
"""История курсов Нацбанка Грузии — разовая загрузка (22.09.2026).

У NBG нет запроса диапазоном: одна дата — один запрос. 180 дней ≈ 180 запросов,
поэтому качаем скриптом, а не из ручки, и с паузой, чтобы не долбить чужой сервис.
Повторный запуск догружает только недостающие дни.

    python3 scripts/backfill_fx.py [дней]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import db  # noqa: E402
import fx  # noqa: E402

if __name__ == "__main__":
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 180
    db.ensure_fx_rates_schema()
    print(f"Загружаю историю за {days} дней (USD/EUR/RUB → GEL)…")
    res = fx.backfill(days=days)
    print(f"  записей: {res['stored']}, дней без ответа: {res['failed']}")
    for base in ("USD", "EUR", "RUB"):
        rows = fx.series(base, "GEL", days)
        if rows:
            lo = min(r["rate"] for r in rows)
            hi = max(r["rate"] for r in rows)
            print(f"  {base}/GEL: {len(rows)} дней, от {lo} до {hi}, последний {rows[-1]['date']} = {rows[-1]['rate']}")
