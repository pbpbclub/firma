#!/usr/bin/env python3
"""Smoke боевой Фирмы после деплоя: API отвечает и миграции применились.

`systemctl status` показывает лишь «процесс жив» — а падают миграции и роутеры
по-другому: сервис поднимается, а половина эндпоинтов отдаёт 500, либо стартовый
ALTER не прошёл и колонка, которой ждёт фронт, отсутствует. Оба случая видно
только запросом.

JWT минтится из FIRMA_SECRET_KEY тем же способом, что и в screenshot.cjs, —
секрет читается из /opt/firma/backend/.env, нигде не хардкодится и не печатается.

    python3 scripts/smoke.py            # после рестарта firma
    python3 scripts/smoke.py --base http://127.0.0.1:8001
"""
import argparse
import base64
import hashlib
import hmac
import json
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ENV_FILE = Path("/opt/firma/backend/.env")
PROD_DB = Path("/opt/ai-os/data/production.db")
EMAIL = "yuranek@pbpb.club"

# Эндпоинты, без которых интерфейс бесполезен. Держать коротким: smoke не
# заменяет тесты, он ловит «сервис поднялся, но не работает».
ENDPOINTS = ["/api/orders", "/api/customers", "/api/masters", "/api/suppliers",
             "/api/estimates/review-queue", "/api/expenses/inbox",
             "/api/payments/inbox", "/api/general-expenses/summary"]

# Колонки, добавленные ALTER-миграциями: их отсутствие означает, что стартовая
# миграция не прошла, а сервис при этом живой. Пополнять при новых миграциях.
REQUIRED_COLUMNS = {
    "orders": ["reserved_amount", "reserve_released_at", "discount", "discount_note"],
    # updated_at — волна ЛЕСКОВО-1 (Б7), проставляется триггерами trg_*_updated_at
    "payments": ["zenmoney_tx_id", "channel", "updated_at"],
    "estimate_sets": ["payment_type", "bank_pct", "is_primary"],
    "expenses": ["creditor_id", "finance_tx_id", "zenmoney_tx_id", "payment_source", "master_id",
                 # траты без заказа: запас / образцы / общехоз (01.08.2026)
                 "purpose", "stock_parent_id", "updated_at"],
    "creditors": ["estimate_line_id", "amount_plan", "kind", "updated_at"],
    # клиент ↔ подрядчик: один человек в двух картотеках (мердж Пинчука, 26.07)
    "customers": ["telegram", "whatsapp", "master_id", "updated_at"],
    # A9: снимок применённой ставки в строке (волна ЛЕСКОВО-1)
    "estimate_lines": ["applied_rate", "rate_scheme", "rate_date", "updated_at"],
    "catalog_item_lines": ["applied_rate", "rate_scheme", "rate_date"],
}


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def mint_token(days: int = 1) -> str:
    m = re.search(r"^FIRMA_SECRET_KEY=(.+)$", ENV_FILE.read_text(), re.M)
    if not m:
        raise SystemExit(f"FIRMA_SECRET_KEY не найден в {ENV_FILE}")
    secret = m.group(1).strip().encode()
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64(json.dumps({"sub": EMAIL,
                            "exp": int(time.time()) + days * 86400}).encode())
    signing = f"{head}.{body}"
    sig = _b64(hmac.new(secret, signing.encode(), hashlib.sha256).digest())
    return f"{signing}.{sig}"


def check_api(base: str, token: str) -> list[str]:
    problems = []
    for path in ENDPOINTS:
        req = urllib.request.Request(base + path,
                                     headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                if r.status != 200:
                    problems.append(f"{path}: HTTP {r.status}")
                    continue
                json.loads(r.read().decode())   # не только код, но и валидный JSON
                print(f"  ok  {path}")
        except urllib.error.HTTPError as e:
            problems.append(f"{path}: HTTP {e.code}")
        except Exception as e:  # noqa: BLE001 — сеть, таймаут, битый JSON
            problems.append(f"{path}: {type(e).__name__}: {e}")
    return problems


def check_migrations() -> list[str]:
    problems = []
    con = sqlite3.connect(f"file:{PROD_DB}?mode=ro", uri=True, timeout=15)
    try:
        for table, cols in REQUIRED_COLUMNS.items():
            have = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
            if not have:
                problems.append(f"нет таблицы {table}")
                continue
            missing = [c for c in cols if c not in have]
            if missing:
                problems.append(f"{table}: нет колонок {', '.join(missing)}")
            else:
                print(f"  ok  {table} ({len(cols)} колонок миграций на месте)")
    finally:
        con.close()
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description="Smoke Фирмы после деплоя")
    ap.add_argument("--base", default="http://127.0.0.1:8001")
    args = ap.parse_args()

    print("=== Smoke: схема ===")
    problems = check_migrations()
    print("=== Smoke: API ===")
    problems += check_api(args.base, mint_token())

    if problems:
        print("\nSMOKE ПРОВАЛЕН:", file=sys.stderr)
        for p in problems:
            print(f"  ✗ {p}", file=sys.stderr)
        return 1
    print("\nSmoke пройден.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
