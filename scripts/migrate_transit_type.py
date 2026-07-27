#!/usr/bin/env python3
"""Разовая миграция: транзитным сметам — свой тип расчёта вместо вранья про наличку.

До появления типа `transit` транзитные сметы помечались `payment_type='cash'`. Это был
обходной путь: после смены формулы безнала (27.07.2026) признак `bank` начал делить сумму
счёта на 0,87 второй раз, и чтобы выручка не завышалась, транзиту выставили «наличку».

Побочный эффект вранья: УСН считается только по безналу, поэтому у транзитных заказов
налог был равен нулю — хотя деньги клиента проходят через расчётный счёт и облагаются
УСН со ВСЕЙ суммы счёта. Недосчитано 19 854 ₽ на трёх заказах.

Суммы НЕ трогаем (ТЗ транзита, п.6.3): по этим трём заказам счета выставлены и часть
переводов сделана, считаем как есть, факт добирается привязками. Новые транзиты считаются
по правилу с самого начала.

Пишет через HTTP API: production.db в WAL под root, из сессии агента на запись
не открывается.

    python3 scripts/migrate_transit_type.py            # разбор, ничего не пишет
    python3 scripts/migrate_transit_type.py --apply    # записать
"""
import argparse
import json
import sqlite3
import urllib.error
import urllib.request

API = "http://127.0.0.1:8001/api"
DB = "file:/opt/ai-os/data/production.db?mode=ro"
# Заметка, которой фин-агент пометил обходной путь — вместе с ним и уходит.
WORKAROUND_NOTE_MARK = "признак «безнал»"


def api(method: str, path: str, token: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="записать изменения")
    ap.add_argument("--token-file", default=".token")
    args = ap.parse_args()

    token = open(args.token_file).read().strip() if args.apply else ""

    conn = sqlite3.connect(DB, uri=True)
    conn.row_factory = sqlite3.Row
    plans = []
    for o in conn.execute(
        "SELECT id, number, title, price_plan, cost_plan FROM orders "
        "WHERE brand = 'Транзит' AND COALESCE(archived,0) = 0 ORDER BY number"
    ):
        for s in conn.execute(
            "SELECT id, status, payment_type, bank_pct, notes FROM estimate_sets "
            "WHERE order_id = ? AND COALESCE(status,'') != 'superseded'", (o["id"],)
        ):
            if s["payment_type"] == "transit":
                continue                       # уже мигрирована
            patch = {"payment_type": "transit"}
            drop_note = bool(s["notes"] and WORKAROUND_NOTE_MARK in s["notes"])
            if drop_note:
                patch["notes"] = ""
            plans.append((o, s, patch, drop_note))

    conn.close()

    if not plans:
        print("Транзитных смет к миграции нет — все уже с типом «транзит».")
        return

    print("К ЗАПИСИ:")
    for o, s, patch, drop_note in plans:
        pct = s["bank_pct"] if s["bank_pct"] is not None else 13.0
        hold = round((o["price_plan"] or 0) * pct / 100, 2)
        print(f"\n  {o['number']} {o['title'][:46]}  смета {s['status']}")
        print(f"    тип расчёта: {s['payment_type']} → transit")
        print(f"    счёт {o['price_plan'] or 0:,.0f} · выплата {o['cost_plan'] or 0:,.0f} "
              f"· удержание {pct:g}% · УСН 6% со счёта появится: {(o['price_plan'] or 0)*0.06:,.0f} ₽")
        if drop_note:
            print(f"    снимаем заметку про обходной путь: {s['notes'][:64]!r}")
        print("    суммы не трогаем (ТЗ п.6.3)")

    if not args.apply:
        print(f"\nЭто разбор. Записать: --apply  (смет: {len(plans)})")
        return

    print("\nЗАПИСЬ")
    ok = fail = 0
    for o, s, patch, _ in plans:
        try:
            api("PUT", f"/estimates/sets/{s['id']}", token, patch)
            after = api("GET", f"/orders/{o['id']}", token)
            tr = after.get("transit") or {}
            print(f"  ✓ {o['number']}: тип {after.get('payment_type')} · выручка "
                  f"{after.get('price_plan'):,.0f} · себест {after.get('cost_plan'):,.0f} "
                  f"· УСН {after.get('tax') or 0:,.0f} · состояние {tr.get('state', '?')}")
            ok += 1
        except urllib.error.HTTPError as e:
            print(f"  ! {o['number']}: {e.code} {e.read().decode()[:160]}")
            fail += 1
    print(f"\nсмет записано {ok}, ошибок {fail}")


if __name__ == "__main__":
    main()
