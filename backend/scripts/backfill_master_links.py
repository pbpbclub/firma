#!/usr/bin/env python3
"""Бэкфилл estimate_lines.master_id по contractor_name (аудит 11.09.2026).

До 11.09.2026 approve находил мастера по имени и результат выбрасывал — id имела
1 строка из 493, обязательства цеплялись к мастеру только по точному совпадению
имени (ledger._entries_bulk, obligations.creditor_masters). Скрипт проставляет
id найденным (в т.ч. вариантам написания из NAME_VARIANTS), сальдо подрядчиков
НЕ меняет — это проверяется прямо здесь: отчёт печатает сальдо до/после по копии
базы и отказывается применять, если хоть одно сдвинулось (решение Юры 11.09.2026:
существующая картина расчётов верна, править её — только через фин-агента).

    python3 backend/scripts/backfill_master_links.py            # отчёт
    python3 backend/scripts/backfill_master_links.py --apply    # применить
"""
import argparse
import sqlite3
import sys
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

PROD = "/opt/ai-os/data/production.db"

# Варианты написания → имя из картотеки (masters.name). Разовая уборка, не правило.
NAME_VARIANTS = {
    "Малафеев Эдуард Леонидович": "Эдуард Малафеев",
    "Спектр-Колор": "Спектр-Колор (Сергей Устинов)",
}


def _connect(path):
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def plan_changes(conn) -> list:
    from routers.estimates import _find_master
    masters = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM masters")}
    ch = []
    for ln in conn.execute("""
        SELECT el.id, el.contractor_name, el.title, o.number
          FROM estimate_lines el
          JOIN estimate_items ei ON ei.id = el.item_id
          JOIN estimate_sets es ON es.id = ei.set_id
          JOIN orders o ON o.id = es.order_id
         WHERE el.master_id IS NULL AND COALESCE(el.contractor_name, '') <> ''
         ORDER BY o.number"""):
        name = ln["contractor_name"].strip()
        mid = _find_master(conn, NAME_VARIANTS.get(name, name))
        ch.append({"id": ln["id"], "new": mid,
                   "why": f"{ln['number']} «{ln['title'][:60]}»: {name} → "
                          f"{masters[mid] if mid else '— в картотеке нет, остаётся по имени'}"})
    return ch


def apply_changes(conn, changes) -> int:
    n = 0
    for c in changes:
        if c["new"]:
            conn.execute("UPDATE estimate_lines SET master_id = ? WHERE id = ? AND master_id IS NULL",
                         (c["new"], c["id"]))
            n += 1
    return n


def balances(conn) -> dict:
    from routers.ledger import _entries_bulk, _totals
    masters = [dict(r) for r in conn.execute("SELECT id, name FROM masters ORDER BY name")]
    bulk = _entries_bulk(conn, masters)
    return {m["name"]: _totals(bulk.get(m["id"], [])) for m in masters}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=PROD)
    ap.add_argument("--apply", action="store_true", help="писать в живую базу (после «да» Юры)")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="backfill_"))
    src = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    for p in (tmp / "before.db", tmp / "after.db"):
        dst = sqlite3.connect(str(p)); src.backup(dst); dst.close()
    src.close()

    before = balances(_connect(str(tmp / "before.db")))
    conn_after = _connect(str(tmp / "after.db"))
    changes = plan_changes(conn_after)
    apply_changes(conn_after, changes)
    conn_after.commit()
    after = balances(conn_after)
    conn_after.close()

    print("== Изменения ==")
    for c in changes:
        print(f"  {'•' if c['new'] else '—'} {c['why']}")
    moved = [(n, before[n]["balance"], after[n]["balance"]) for n in before
             if abs(before[n]["balance"] - after[n]["balance"]) > 0.01
             or abs(before[n]["accrued"] - after[n]["accrued"]) > 0.01]
    print(f"\nПривязывается строк: {sum(1 for c in changes if c['new'])} из {len(changes)}")
    if moved:
        print("⚠️ САЛЬДО МЕНЯЕТСЯ — применять нельзя:")
        for n, b, a in moved:
            print(f"   {n}: {b:.0f} → {a:.0f}")
        sys.exit(2)
    print("Сальдо и начисления всех подрядчиков — без изменений.")
    if not args.apply:
        print(f"Отчёт, ничего не записано. Применить: --apply")
        return
    bak = Path(args.db).with_name(f"production.backup-master-links-{datetime.now():%Y%m%d-%H%M}.db")
    src = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    dst = sqlite3.connect(str(bak)); src.backup(dst); dst.close(); src.close()
    print(f"Бэкап: {bak}")
    conn = _connect(args.db)
    try:
        conn.execute("BEGIN IMMEDIATE")
        n = apply_changes(conn, plan_changes(conn))
        conn.commit()
        print(f"Применено: {n}")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
