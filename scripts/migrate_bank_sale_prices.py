#!/usr/bin/env python3
"""Разовая миграция: привести sale_price безналичных смет под новую формулу.

Зачем. До 27.07.2026 клиентская цена считалась `sale × (1 + bank_pct/100)` —
13% накидывались СВЕРХУ. По ТЗ Юры формула стала `sale / (1 - pct/100)`:
13% удерживаются ИЗ суммы счёта. Формулу поменяли, а данные — нет: sale_price
в старых сметах подобран так, чтобы `sale × 1,13` давало сумму согласованного
счёта. После правки те же строки дают на 400…136 600 ₽ больше — система
разъехалась со счетами, которые клиенты уже видели.

Что делает. Для смет, которые ДО правки сходились со счётом (orders.price_plan),
раскладывает сумму счёта по позициям в прежней пропорции и записывает
`sale = доля_счёта × 0,87`. После этого живой итог сметы снова равен счёту.

Округление. Клиентская цена округляется вверх до 100 ₽ ПОЗИЦИОННО, поэтому доли
округляются до сотен, а остаток кладётся на самую крупную позицию — иначе сумма
позиций уползёт выше счёта.

Заглушки. Позиция с наценкой ровно 2,0 и `cost = sale/2` — это заглушка из
`production.py estimate-create`, её ловит «Готовность» и спрашивает у Юры реальную
цифру. Если поменять только цену, наценка перестанет быть 2,0 и вопрос молча
исчезнет из списка. Поэтому у заглушек себестоимость масштабируется вместе с ценой:
фикция остаётся фикцией и остаётся видимой.

Пишет через HTTP API, а не в базу: production.db в WAL под root, из сессии агента
она на запись не открывается. Утверждённые сметы API замораживает (409) — они
в отчёт попадают, но не правятся.

    python3 scripts/migrate_bank_sale_prices.py            # разбор, ничего не пишет
    python3 scripts/migrate_bank_sale_prices.py --apply    # записать
"""
import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from money import client_price, cash_from_client, DEFAULT_BANK_PCT  # noqa: E402

API = "http://127.0.0.1:8001/api"
DB = "file:/opt/ai-os/data/production.db?mode=ro"
STUB_MARKUP = 2.0
TOLERANCE = 2.0   # ₽: расхождение старой формулы со счётом, которое считаем округлением


def api(method: str, path: str, token: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def active_set(conn, order_id: str):
    """Тот же порядок, что orders._active_set: утверждённая → основная → последняя."""
    return conn.execute(
        """SELECT * FROM estimate_sets WHERE order_id = ?
           ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'superseded' THEN 2 ELSE 1 END,
                    COALESCE(is_primary,0) DESC, created_at DESC LIMIT 1""",
        (order_id,)).fetchone()


def is_stub(item) -> bool:
    cost, sale, markup = item["cost_total"] or 0, item["sale_price"] or 0, item["markup"] or 0
    if cost <= 0 or sale <= 0 or markup <= 0:
        return False
    return abs(markup - STUB_MARKUP) < 0.001 and abs(cost * markup - sale) < 1.0


def positional_pct_skew(items, set_pct: float):
    """Позиции с собственным bank_pct, отличным от процента сметы.

    Такой процент в данных — мусор (в MIRRA от −53% до +66%): он попал в старые
    суммы счёта, и раскладка «в прежней пропорции» перекроит позиции в разы,
    а не на округление. Это уже не миграция формулы, а разбор сметы — руками."""
    return [it for it in items
            if it["bank_pct"] is not None and abs(it["bank_pct"] - set_pct) > 0.5]


def allocate(items, set_pct: float, target: float):
    """Разложить сумму счёта по позициям в пропорции старой формулы.

    Возвращает список долей, кратных 100 ₽ и дающих в сумме ровно target,
    либо None — если старая формула со счётом не сходилась (значит смета была
    сломана ещё до правки и вслепую пересчитывать её нельзя)."""
    old = []
    for it in items:
        pct = it["bank_pct"] if it["bank_pct"] is not None else set_pct
        old.append((it["sale_price"] or 0) * (1 + pct / 100))
    if abs(sum(old) - target) > TOLERANCE:
        return None
    shares = [round(v / 100) * 100 for v in old]
    gap = target - sum(shares)
    if gap:                                    # остаток — на самую крупную позицию
        shares[shares.index(max(shares))] += gap
    if any(s < 0 for s in shares):
        return None
    return shares


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="записать изменения")
    ap.add_argument("--include-approved", action="store_true",
                    help="править и утверждённые сметы: снять заморозку, записать, утвердить обратно")
    ap.add_argument("--token-file", default=".token")
    args = ap.parse_args()

    token = ""
    if args.apply:
        token = open(args.token_file).read().strip()

    conn = sqlite3.connect(DB, uri=True)
    conn.row_factory = sqlite3.Row
    plans, skipped, frozen = [], [], []

    for o in conn.execute("SELECT id, number, title, price_plan, COALESCE(archived,0) AS archived "
                          "FROM orders ORDER BY number"):
        s = active_set(conn, o["id"])
        if not s or s["payment_type"] != "bank":
            continue
        items = conn.execute(
            "SELECT id, title, sale_price, cost_total, markup, bank_pct "
            "FROM estimate_items WHERE set_id = ? ORDER BY sort_order", (s["id"],)).fetchall()
        if not items:
            continue
        target = o["price_plan"] or 0
        set_pct = s["bank_pct"] if s["bank_pct"] is not None else DEFAULT_BANK_PCT
        now = sum(client_price(it["sale_price"] or 0, "bank", set_pct) for it in items)

        if target <= 0:
            skipped.append((o, s, now, "у заказа не проставлена сумма счёта"))
            continue
        if abs(now - target) < 0.01:
            continue          # уже сходится (в т.ч. после миграции) — не трогаем и не жалуемся
        shares = allocate(items, set_pct, target)
        if shares is None:
            skipped.append((o, s, now, "смета не сходилась со счётом ещё до правки"))
            continue
        skew = positional_pct_skew(items, set_pct)
        if skew:
            skipped.append((o, s, now,
                            f"у {len(skew)} из {len(items)} позиций свой bank_pct — "
                            f"доли перекроятся в разы, не округление"))
            continue

        changes = []
        for it, share in zip(items, shares):
            new_sale = cash_from_client(share, "bank", set_pct)
            patch = {"sale_price": new_sale}
            if is_stub(it):
                # заглушку масштабируем целиком, чтобы наценка осталась 2,0
                # и позиция не выпала из вопросов «Готовности»
                patch["cost_total"] = round(new_sale / STUB_MARKUP, 2)
            elif (it["cost_total"] or 0) > 0:
                patch["markup"] = round(new_sale / it["cost_total"], 3)
            changes.append((it, share, patch))
        (frozen if s["status"] == "approved" else plans).append((o, s, now, target, changes))

    conn.close()

    def render(title, group):
        if not group:
            return
        print(f"\n{title}")
        for o, s, now, target, changes in group:
            flag = " [АРХИВ]" if o["archived"] else ""
            print(f"\n  {o['number']} {o['title'][:44]}{flag}  смета {s['status']}")
            print(f"    счёт {target:,.0f} ₽ · система показывает {now:,.0f} ₽ "
                  f"· разъезд {now - target:+,.0f} ₽")
            for it, share, patch in changes:
                stub = "  (заглушка: себестоимость тоже)" if "cost_total" in patch else ""
                print(f"      {it['title'][:38]:38s} sale {it['sale_price'] or 0:>10,.0f}"
                      f" → {patch['sale_price']:>10,.0f}   в счёте {share:>9,.0f}{stub}")

    render("К ЗАПИСИ (черновики):", plans)
    render("ЗАМОРОЖЕНЫ — смета утверждена, API вернёт 409, нужно решение Юры:", frozen)
    if skipped:
        print("\nНЕ ТРОГАЕМ (пересчёт вслепую сделает хуже):")
        for o, s, now, why in skipped:
            flag = " [АРХИВ]" if o["archived"] else ""
            print(f"  {o['number']} {o['title'][:40]}{flag}: {why} "
                  f"(счёт {o['price_plan'] or 0:,.0f}, показывает {now:,.0f})")

    if not args.apply:
        print(f"\nЭто разбор. Записать: --apply  (позиций к правке: "
              f"{sum(len(c) for *_, c in plans)})")
        return

    print("\nЗАПИСЬ")
    ok = fail = 0
    todo = list(plans)
    if args.include_approved:
        todo += frozen
    for o, s, now, target, changes in todo:
        thaw = s["status"] == "approved"
        if thaw:
            # Утверждённую смету API не даёт править. Снимаем заморозку, пишем,
            # утверждаем обратно: _approve_set идемпотентна (обязательства
            # дедуплицируются по estimate_line_id), суммы заказа пересинкаются сами.
            obl_before = len(api("GET", f"/orders/{o['id']}/obligations", token) or [])
            api("PUT", f"/estimates/sets/{s['id']}", token, {"status": "draft"})
        for it, share, patch in changes:
            try:
                api("PUT", f"/estimates/items/{it['id']}", token, patch)
                ok += 1
            except urllib.error.HTTPError as e:
                print(f"  ! {o['number']} «{it['title'][:30]}»: {e.code} {e.read().decode()[:120]}")
                fail += 1
        note = ""
        if thaw:
            api("PUT", f"/estimates/sets/{s['id']}", token, {"status": "approved"})
            back = api("GET", f"/orders/{o['id']}/estimate", token)
            st = next((x["status"] for x in back if x["id"] == s["id"]), "?")
            obl_after = len(api("GET", f"/orders/{o['id']}/obligations", token) or [])
            note = f"  [смета снова {st}, обязательств {obl_before} → {obl_after}]"
        after = api("GET", f"/orders/{o['id']}", token).get("price_plan")
        mark = "✓" if abs((after or 0) - target) < 0.01 else "✗"
        print(f"  {mark} {o['number']}: счёт {target:,.0f} → система {after:,.0f}{note}")
    print(f"\nпозиций записано {ok}, ошибок {fail}")


if __name__ == "__main__":
    main()
