#!/usr/bin/env python3
"""Переводы себе с р/с ИП → расход purpose='owner_draw' (решение Юры 11.09.2026).

Аудит показал 42 списания «НЕКРАСОВ ЮРИЙ» с р/с ИП на 2,04 млн ₽ с мая без единой
записи: сводка «сколько взято» (GET /general-expenses/owner-draws) была пуста, а в ДДС
переводы выглядели неразнесёнными. По правилу 03.09.2026 вывод с р/с ИП на личный —
изъятие прибыли: в себестоимость и накладные не идёт, только в сводку выводов.

Идёт через API Фирмы (POST /api/general-expenses с finance_tx_id) — та же дверь, что
у формы; дедуп — транзакция, у которой уже есть любая запись в единой карте
(GET /finance/alloc-map), пропускается. По умолчанию — отчёт; --apply пишет.

    FIRMA_TOKEN=... python3 backend/scripts/backfill_owner_draws.py [--from 2026-05-01] [--apply]
"""
import argparse
import json
import os
import sqlite3
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from alloc_map import is_self, self_patterns  # noqa: E402

FINANCE_DB = "/opt/fin-agent/data/finance.db"
PROD_DB = "/opt/ai-os/data/production.db"
BASE = os.environ.get("FIRMA_API", "http://localhost:8001/api")


def call(token, method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="date_from", default="2026-01-01")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    token = os.environ.get("FIRMA_TOKEN") or (Path(os.environ.get("FIRMA_TOKEN_FILE", "/dev/null")).read_text().strip()
                                              if os.environ.get("FIRMA_TOKEN_FILE") else None)
    if not token:
        sys.exit("FIRMA_TOKEN (или FIRMA_TOKEN_FILE) не задан")

    prod = sqlite3.connect(f"file:{PROD_DB}?mode=ro", uri=True); prod.row_factory = sqlite3.Row
    patterns = self_patterns(prod); prod.close()
    fin = sqlite3.connect(f"file:{FINANCE_DB}?mode=ro", uri=True); fin.row_factory = sqlite3.Row
    txs = [dict(r) for r in fin.execute(
        "SELECT id, date, bank, counterparty, purpose, amount FROM transactions WHERE direction = 'out' AND date >= ? ORDER BY date",
        (args.date_from,)).fetchall()]
    fin.close()
    amap = call(token, "GET", "/finance/alloc-map")["map"]

    todo, skipped = [], []
    for t in txs:
        if not is_self(t["counterparty"], patterns):
            continue
        notes = [n for n in amap.get(f"bank:{t['id']}", []) if n["kind"] not in ("self_transfer", "service")]
        (skipped if notes else todo).append((t, notes))
    print(f"== Переводы себе с р/с ИП с {args.date_from}: {len(todo) + len(skipped)}, "
          f"уже с записью: {len(skipped)}, к записи: {len(todo)}, сумма {sum(t['amount'] for t, _ in todo):,.0f} ₽")
    for t, _ in todo:
        print(f"  • {t['date']} {t['bank']:5} {t['amount']:>10,.0f}  {(t['purpose'] or '')[:60]}")
    for t, notes in skipped:
        print(f"  ↷ {t['date']} {t['bank']:5} {t['amount']:>10,.0f}  уже: {', '.join(n['label'] for n in notes)}")
    if not args.apply:
        print("\nОтчёт. Записать: --apply")
        return
    n = 0
    for t, _ in todo:
        call(token, "POST", "/general-expenses", {
            "title": "Вывод владельца (перевод себе с р/с ИП)", "amount": t["amount"], "purpose": "owner_draw",
            "category": "other", "supplier": "Некрасов Ю.В. (личный счёт)", "expense_date": t["date"],
            "finance_tx_id": str(t["id"]), "note": (t["purpose"] or "")[:200]})
        n += 1
    print(f"Записано выводов: {n}")


if __name__ == "__main__":
    main()
