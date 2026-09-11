#!/usr/bin/env python3
"""Доприкрепить ручные записи к транзакциям банка/ZenMoney (аудит 11.09.2026).

Платежи, расходы и оплаченные обязательства, заведённые руками без id транзакции,
в ДДС и «Личных» выглядят неразнесёнными (единая карта ищет по tx_id). Скрипт
ищет однозначные пары и ставит ссылку — НИЧЕГО не создаёт и не меняет в суммах:
  payments  без bank_tx_id / zenmoney_tx_id ↔ приход той же суммы (±1 ₽) в ±3 дня;
  expenses  без tx ↔ списание той же суммы в ±3 дня, контрагент совпадает с
            поставщиком (payee_rules / нормализованное имя мастера);
  creditors paid>0 без tx ↔ списание той же суммы в ±5 дней, контрагент совпадает
            с именем обязательства/мастера.
Кандидатов больше одного → в отчёт, не трогаем. Транзакция, уже занятая другой
записью, кандидатом не бывает. После --apply печатает cost_fact по затронутым
заказам до/после: инвариант «одна оплата = один факт» может СНЯТЬ двойной счёт
(creditor и expense с одним tx) — это находка, а не ошибка, и она печатается.

    python3 backend/scripts/relink_tx.py [--from 2026-05-01] [--apply]
"""
import argparse
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

PROD, FIN, ZEN = "/opt/ai-os/data/production.db", "/opt/fin-agent/data/finance.db", "/opt/fin-agent/data/zenmoney.db"


def ro(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True); c.row_factory = sqlite3.Row; return c


def near(d1, d2, days):
    try:
        return abs((date.fromisoformat(d1[:10]) - date.fromisoformat(d2[:10])).days) <= days
    except Exception:
        return False


def main():
    from routers.masters import _norm_name
    from alloc_map import is_self, self_patterns
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="date_from", default="2026-05-01")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    p, f, z = ro(PROD), ro(FIN), ro(ZEN)
    selfp = self_patterns(p)
    used_bank = {str(r[0]) for t in ("expenses", "creditors", "master_ledger", "accountable_ops") for r in p.execute(f"SELECT finance_tx_id FROM {t} WHERE finance_tx_id IS NOT NULL")}
    used_bank |= {str(r[0]) for r in p.execute("SELECT bank_tx_id FROM payments WHERE bank_tx_id IS NOT NULL")}
    used_zen = {str(r[0]) for t in ("expenses", "creditors", "master_ledger", "accountable_ops") for r in p.execute(f"SELECT zenmoney_tx_id FROM {t} WHERE zenmoney_tx_id IS NOT NULL")}
    used_zen |= {str(r[0]) for r in p.execute("SELECT zenmoney_tx_id FROM payments WHERE zenmoney_tx_id IS NOT NULL")}
    used_zen |= {str(r[0]) for r in z.execute("SELECT zm_tx_id FROM zm_links")}
    bank = [dict(r) for r in f.execute("SELECT id, date, direction, counterparty, amount FROM transactions WHERE date >= ?", (args.date_from,))]
    zen = [dict(r) for r in z.execute("SELECT id, date, payee, income, outcome FROM zm_transactions WHERE deleted = 0 AND date >= ?", (args.date_from,))]
    rules = [dict(r) for r in p.execute("SELECT pattern, match_type, entity_name, display_name FROM payee_rules")]
    masters = {r["id"]: r["name"] for r in p.execute("SELECT id, name FROM masters")}

    def payee_names(counterparty):
        """Имена, которыми контрагент известен в картотеке (по правилам + сам текст)."""
        c = (counterparty or "").lower().strip(); names = {_norm_name(counterparty)}
        for r in rules:
            pat = (r["pattern"] or "").lower()
            if (r["match_type"] == "exact" and c == pat) or (r["match_type"] == "prefix" and c.startswith(pat)) or (r["match_type"] == "contains" and pat in c):
                names |= {_norm_name(r["entity_name"]), _norm_name(r["display_name"])}
        return {n for n in names if n}

    changes = []   # (table, id, column, tx_id, why)
    # 1. платежи без ссылки ↔ приходы банка
    for pay in p.execute("""SELECT p.id, p.amount, p.paid_at, o.number FROM payments p JOIN orders o ON o.id = p.order_id
                            WHERE p.bank_tx_id IS NULL AND p.zenmoney_tx_id IS NULL AND p.paid_at >= ?""", (args.date_from,)):
        cands = [t for t in bank if t["direction"] == "in" and str(t["id"]) not in used_bank
                 and abs(t["amount"] - pay["amount"]) < 1 and near(t["date"], pay["paid_at"], 3) and not is_self(t["counterparty"], selfp)]
        if len(cands) == 1:
            t = cands[0]; used_bank.add(str(t["id"]))
            changes.append(("payments", pay["id"], "bank_tx_id", str(t["id"]), f"{pay['number']} платёж {pay['amount']:,.0f} {pay['paid_at'][:10]} ← банк {t['date']} {t['counterparty'][:35]}"))
        elif len(cands) > 1:
            print(f"  ? платёж {pay['number']} {pay['amount']:,.0f} {pay['paid_at'][:10]}: {len(cands)} кандидата — пропуск")
    # 2. расходы без ссылки ↔ списания (банк и ZM), контрагент совпадает
    for e in p.execute("""SELECT e.id, e.amount, e.expense_date, e.supplier, e.master_id, o.number FROM expenses e LEFT JOIN orders o ON o.id = e.order_id
                          WHERE e.finance_tx_id IS NULL AND e.zenmoney_tx_id IS NULL AND e.expense_date >= ?
                            AND COALESCE(e.payment_source, '') = '' AND COALESCE(e.settled_by, 'cash') = 'cash'""", (args.date_from,)):
        who = {_norm_name(e["supplier"]), _norm_name(masters.get(e["master_id"]))} - {""}
        if not who:
            continue
        cb = [t for t in bank if t["direction"] == "out" and str(t["id"]) not in used_bank and abs(t["amount"] - e["amount"]) < 1
              and near(t["date"], e["expense_date"], 3) and (payee_names(t["counterparty"]) & who)]
        cz = [t for t in zen if (t["outcome"] or 0) > 0 and not (t["income"] or 0) and str(t["id"]) not in used_zen and abs(t["outcome"] - e["amount"]) < 1
              and near(t["date"], e["expense_date"], 3) and (payee_names(t["payee"]) & who)]
        if len(cb) + len(cz) == 1:
            if cb:
                t = cb[0]; used_bank.add(str(t["id"])); changes.append(("expenses", e["id"], "finance_tx_id", str(t["id"]), f"{e['number'] or 'вне заказа'} расход {e['amount']:,.0f} {e['supplier']} ← банк {t['date']}"))
            else:
                t = cz[0]; used_zen.add(str(t["id"])); changes.append(("expenses", e["id"], "zenmoney_tx_id", str(t["id"]), f"{e['number'] or 'вне заказа'} расход {e['amount']:,.0f} {e['supplier']} ← ZM {t['date']} {t['payee']}"))
        elif len(cb) + len(cz) > 1:
            print(f"  ? расход {e['number']} {e['amount']:,.0f} {e['supplier']}: {len(cb) + len(cz)} кандидата — пропуск")
    # 3. оплаченные обязательства без ссылки ↔ списания банка
    for c in p.execute("""SELECT c.id, c.name, c.paid, c.total, c.updated_at, c.created_at, o.number, el.master_id
                          FROM creditors c LEFT JOIN orders o ON o.id = c.order_id LEFT JOIN estimate_lines el ON el.id = c.estimate_line_id
                          WHERE c.paid > 0 AND c.finance_tx_id IS NULL AND c.zenmoney_tx_id IS NULL"""):
        who = {_norm_name(c["name"]), _norm_name(masters.get(c["master_id"]))} - {""}
        cb = [t for t in bank if t["direction"] == "out" and str(t["id"]) not in used_bank and abs(t["amount"] - c["paid"]) < 1
              and (payee_names(t["counterparty"]) & who)]
        if len(cb) == 1:
            t = cb[0]; used_bank.add(str(t["id"]))
            changes.append(("creditors", c["id"], "finance_tx_id", str(t["id"]), f"{c['number']} обязательство «{c['name'][:30]}» paid {c['paid']:,.0f} ← банк {t['date']} {t['counterparty'][:30]}"))
        elif len(cb) > 1:
            print(f"  ? обязательство {c['number']} {c['name'][:30]} {c['paid']:,.0f}: {len(cb)} кандидата — пропуск")

    print(f"\n== Однозначных привязок: {len(changes)}")
    for tbl, rid, col, tx, why in changes:
        print(f"  • {tbl}.{col}: {why}")
    if not args.apply:
        print("\nОтчёт, ничего не записано. Применить: --apply")
        return
    orders = sorted({ch[4].split()[0] for ch in changes if ch[4].split()[0].startswith("ORD-")})
    from routers.orders import _fact_costs
    w = sqlite3.connect(PROD, timeout=10); w.row_factory = sqlite3.Row
    ids = [r["id"] for r in w.execute(f"SELECT id FROM orders WHERE number IN ({','.join('?' * len(orders))})", orders)] if orders else []
    before = _fact_costs(w, ids) if ids else {}
    try:
        w.execute("BEGIN IMMEDIATE")
        for tbl, rid, col, tx, why in changes:
            w.execute(f"UPDATE {tbl} SET {col} = ? WHERE id = ? AND {col} IS NULL", (tx, rid))
        w.commit()
    except Exception:
        w.rollback(); raise
    after = _fact_costs(w, ids) if ids else {}
    num = {r["id"]: r["number"] for r in w.execute(f"SELECT id, number FROM orders WHERE id IN ({','.join('?' * len(ids))})", ids)} if ids else {}
    print(f"Применено: {len(changes)}")
    for oid in ids:
        if abs((before.get(oid) or 0) - (after.get(oid) or 0)) > 0.01:
            print(f"  ⚠️ cost_fact {num[oid]}: {before.get(oid):,.0f} → {after.get(oid):,.0f} — инвариант снял двойной счёт, проверить")
    w.close()


if __name__ == "__main__":
    main()
