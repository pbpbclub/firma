#!/usr/bin/env python3
"""Бэкфилл creditor_id у ручных начислений лицевого счёта (ТЗ 03.09.2026, п.1).

Все живые проводки master_ledger заведены без creditor_id, поэтому правило
«проводка главнее строки сметы» (ledger._build_entries) на них не срабатывает,
и лицевой счёт начисляет и проводку, и строку. Скрипт ищет пары
«проводка accrual с order_id → открытая/закрытая строка creditors того же заказа
того же мастера на ту же сумму (±1 ₽)» и печатает отчёт.

По умолчанию — только отчёт (ничего не пишет). --apply ставит creditor_id ровно
у однозначных пар и пишет audit. Данные правятся ТОЛЬКО после «да» Юры.

    python3 backend/scripts/link_ledger_accruals.py            # отчёт
    python3 backend/scripts/link_ledger_accruals.py --apply    # применить однозначные
"""
import argparse
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

PROD = "/opt/ai-os/data/production.db"


def find_pairs(conn):
    from obligations import creditor_masters
    accruals = [dict(r) for r in conn.execute("""
        SELECT m.id, m.master_id, m.amount, m.happened_at, m.note, m.order_id,
               ms.name AS master_name, o.number AS order_number
          FROM master_ledger m
          JOIN masters ms ON ms.id = m.master_id
          LEFT JOIN orders o ON o.id = m.order_id
         WHERE m.kind = 'accrual' AND m.creditor_id IS NULL AND m.order_id IS NOT NULL
         ORDER BY ms.name, m.happened_at""").fetchall()]
    creds = [dict(r) for r in conn.execute("""
        SELECT c.id, c.name, c.total, c.paid, c.status, c.closed_reason, c.order_id, c.description
          FROM creditors c WHERE c.order_id IS NOT NULL AND (c.kind IS NULL OR c.kind != 'fixed')""").fetchall()]
    bound = creditor_masters(conn, [c["id"] for c in creds])
    by_order = {}
    for c in creds:
        by_order.setdefault(c["order_id"], []).append(c)
    out = []
    for a in accruals:
        cands = [c for c in by_order.get(a["order_id"], [])
                 if abs((c["total"] or 0) - (a["amount"] or 0)) < 1]
        exact = [c for c in cands if a["master_id"] in bound.get(c["id"], [])]
        loose = [c for c in cands if not bound.get(c["id"])]
        if len(exact) == 1:
            out.append((a, exact[0], "exact"))
        elif not exact and len(loose) == 1:
            out.append((a, loose[0], "loose"))
        elif exact or loose:
            out.append((a, None, f"ambiguous:{len(exact or loose)}"))
        else:
            out.append((a, None, "none"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="проставить creditor_id у однозначных пар (exact)")
    ap.add_argument("--db", default=PROD)
    args = ap.parse_args()
    conn = sqlite3.connect(args.db if args.apply else f"file:{args.db}?mode=ro", uri=not args.apply, timeout=15)
    conn.row_factory = sqlite3.Row
    pairs = find_pairs(conn)
    print(f"{'МАСТЕР':30} {'СУММА':>10} {'ДАТА':10} {'ЗАКАЗ':8} {'СТРОКА':40} {'СТАТУС':10} ВЕРДИКТ")
    for a, c, verdict in pairs:
        print(f"{a['master_name'][:30]:30} {a['amount']:>10.0f} {a['happened_at'][:10]:10} {a['order_number'] or '':8} "
              f"{(c['name'][:40] if c else '—'):40} {(c['status'] if c else ''):10} {verdict}")
    todo = [(a, c) for a, c, v in pairs if v == "exact"]
    print(f"\nоднозначных пар: {len(todo)}; всего проводок: {len(pairs)}")
    if not args.apply:
        print("режим отчёта — ничего не записано; применить: --apply")
        return
    from audit import audit
    for a, c in todo:
        conn.execute("UPDATE master_ledger SET creditor_id = ? WHERE id = ? AND creditor_id IS NULL", (c["id"], a["id"]))
        audit(conn, "ledger", a["id"], "link",
              f"Проводка {a['master_name']} {a['amount']:g} ₽ привязана к обязательству «{c['name']}» (бэкфилл 03.09.2026)")
    conn.commit()
    print(f"записано: {len(todo)}")


if __name__ == "__main__":
    main()
