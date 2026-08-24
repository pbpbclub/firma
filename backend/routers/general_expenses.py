"""Траты без заказа: запас, собственные образцы, общехозяйственное.

ТЗ stock_and_samples (01.08.2026). Живой случай: перевод 11 800 ₽ Денису Мельничуку —
9 500 ₽ порезка ламелей заказа + 2 300 ₽ резка логотипов pbpb ПРО ЗАПАС. Второй части
не было места: на заказ вешать нельзя (завысит себестоимость и занизит маржу), не
записать — деньги исчезают из учёта.

Три назначения (`expenses.purpose`, заполняется только при order_id IS NULL):
  stock    — куплено/нарезано впрок. Деньги ушли сегодня, а себестоимость должна лечь
             на заказ в день ИСПОЛЬЗОВАНИЯ → операция «списать в заказ» (write-off).
  sample   — собственный/тестовый экземпляр. Заказчика нет и не будет, выручки не будет
             никогда: это не убыток заказа, а вложение в продукт — отдельная строка отчёта.
  overhead — общехозяйственное, к заказам не относится вовсе.

Инвариант «одна оплата = один факт» не ломается: списание запаса в заказ уменьшает
исходную строку ровно на списанную сумму (паттерн split/from-tx — несколько строк
одной транзакции), tx-ссылки копируются на обе части, а creditor_id у общих строк
всегда NULL — обязательство принадлежит заказу, а не запасу.
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from uuid import uuid4

from db import get_production
from routers.orders import EXPENSE_CATEGORIES

router = APIRouter()

# contractor_pay / contractor_third_party — обороты лицевого счёта подрядчика
# (ТЗ 05.08.2026, routers/ledger.py): деньги ушли, но это не наша себестоимость
# и не накладные — это дебет лицевого счёта, гасится будущими работами мастера.
PURPOSES = ("stock", "sample", "overhead", "contractor_pay", "contractor_third_party")
LEDGER_PURPOSES = ("contractor_pay", "contractor_third_party")
PURPOSE_LABELS = {
    "stock": "Запас",
    "sample": "Образцы и тесты",
    "overhead": "Общехозяйственные",
    "contractor_pay": "Аванс подрядчику",
    "contractor_third_party": "Оплата за подрядчика",
}


class GeneralExpenseIn(BaseModel):
    title: str
    amount: float
    purpose: str = "stock"
    category: str = "other"
    supplier: Optional[str] = None
    master_id: Optional[str] = None
    expense_date: Optional[str] = None
    finance_tx_id: Optional[str] = None
    zenmoney_tx_id: Optional[str] = None
    payment_source: Optional[str] = None
    accountable_person_id: Optional[str] = None
    note: Optional[str] = None


class GeneralExpenseUpdate(BaseModel):
    """PATCH: все поля опциональны, непереданное сохраняет текущее значение.

    Полнотельная модель здесь была ловушкой: форма правки знает только title/amount/
    purpose/category/supplier/master_id/expense_date, а дефолты модели затирали
    finance_tx_id и zenmoney_tx_id — «Разноска» переставала видеть перевод разнесённым
    и заводила на него второй расход. Заодно терялся payment_source, и _sync_cash
    молча убирал движение по кассе."""
    title: Optional[str] = None
    amount: Optional[float] = None
    purpose: Optional[str] = None
    category: Optional[str] = None
    supplier: Optional[str] = None
    master_id: Optional[str] = None
    expense_date: Optional[str] = None
    finance_tx_id: Optional[str] = None
    zenmoney_tx_id: Optional[str] = None
    payment_source: Optional[str] = None
    accountable_person_id: Optional[str] = None
    note: Optional[str] = None


class WriteOffIn(BaseModel):
    order_id: str
    amount: Optional[float] = None       # None = списать остаток целиком
    expense_date: Optional[str] = None   # дата ИСПОЛЬЗОВАНИЯ, не покупки
    category: Optional[str] = None       # по умолчанию — категория запаса
    title: Optional[str] = None


def _validate(body: GeneralExpenseIn, check_amount: bool = True):
    """check_amount=False — сумму не присылали (частичный PATCH): у полностью
    списанной в заказы строки запаса остаток законно равен нулю, и требование
    «> 0» запрещало бы поправить у неё, например, название."""
    if not (body.title or "").strip():
        raise HTTPException(status_code=400, detail="title required")
    if check_amount and (body.amount is None or body.amount <= 0):
        raise HTTPException(status_code=400, detail="amount must be > 0")
    if body.purpose not in PURPOSES:
        raise HTTPException(status_code=400, detail=f"purpose must be one of {'|'.join(PURPOSES)}")
    if body.category not in EXPENSE_CATEGORIES:
        raise HTTPException(status_code=400, detail=f"category must be one of {'|'.join(EXPENSE_CATEGORIES)}")
    if body.purpose in LEDGER_PURPOSES and not body.master_id:
        # Оборот лицевого счёта без мастера повис бы в воздухе: деньги ушли,
        # а чей это аванс — неизвестно (см. routers/ledger.py).
        raise HTTPException(status_code=400,
                            detail=f"purpose={body.purpose} требует master_id (чей это лицевой счёт)")
    if body.payment_source not in (None, "cash_fund", "accountable"):
        raise HTTPException(status_code=400, detail="payment_source must be cash_fund|accountable or empty")
    if body.payment_source == "accountable" and not body.accountable_person_id:
        raise HTTPException(status_code=400, detail="accountable_person_id required for payment_source=accountable")


def _row(conn, eid: str) -> dict:
    r = conn.execute("SELECT * FROM expenses WHERE id = ?", (eid,)).fetchone()
    return dict(r) if r else {}


@router.get("")
def list_general(
    purpose: Optional[str] = Query(None, pattern="^(stock|sample|overhead|contractor_pay|contractor_third_party)$"),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    with_spent: bool = True,
):
    """Траты без заказа. Для stock показываем и остаток (amount), и уже списанное
    в заказы (сумма детей по stock_parent_id) — иначе непонятно, что стало с покупкой."""
    conn = get_production()
    try:
        sql = ["SELECT e.*, m.name AS master_name FROM expenses e",
               "LEFT JOIN masters m ON m.id = e.master_id",
               "WHERE e.order_id IS NULL"]
        params = []
        if purpose:
            sql.append("AND e.purpose = ?")
            params.append(purpose)
        if date_from:
            sql.append("AND e.expense_date >= ?")
            params.append(date_from)
        if date_to:
            sql.append("AND e.expense_date <= ?")
            params.append(date_to)
        sql.append("ORDER BY e.expense_date DESC, e.created_at DESC")
        rows = [dict(r) for r in conn.execute(" ".join(sql), params).fetchall()]

        # Списанное в заказы — одним запросом на все строки (code_rules: без N+1).
        # Отдаём не только сумму, но и сами строки: без их id откатить списание из
        # интерфейса было нечем (DELETE /write-offs/{expense_id} принимает id ребёнка).
        spent, children = {}, {}
        if with_spent and rows:
            for r in conn.execute(
                """SELECT e.id, e.stock_parent_id AS pid, e.amount, e.expense_date,
                          e.order_id, o.title AS order_title, o.number AS order_number
                     FROM expenses e LEFT JOIN orders o ON o.id = e.order_id
                    WHERE e.stock_parent_id IS NOT NULL
                    ORDER BY e.expense_date DESC"""
            ).fetchall():
                d = dict(r)
                pid = d.pop("pid")
                agg = spent.setdefault(pid, {"amount": 0.0, "count": 0, "titles": []})
                agg["amount"] = round(agg["amount"] + (d["amount"] or 0), 2)
                agg["count"] += 1
                if d["order_title"] and d["order_title"] not in agg["titles"]:
                    agg["titles"].append(d["order_title"])
                children.setdefault(pid, []).append(d)
        for r in rows:
            s = spent.get(r["id"], {"amount": 0, "count": 0, "titles": []})
            r["written_off"] = s["amount"]
            r["written_off_count"] = s["count"]
            r["written_off_orders"] = " • ".join(s["titles"]) or None
            r["write_offs"] = children.get(r["id"], [])
            r["purpose_label"] = PURPOSE_LABELS.get(r["purpose"] or "", r["purpose"])
        return {
            "items": rows,
            "total": round(sum(r["amount"] or 0 for r in rows), 2),
        }
    finally:
        conn.close()


@router.get("/summary")
def summary(date_from: Optional[str] = None, date_to: Optional[str] = None):
    """Отдельные строки для план-факта и P&L. В себестоимость клиентских заказов
    эти суммы не входят — они и не попадают в _plan_fact, у них order_id IS NULL.

    stock_open      — «Запас (не списано)»: лежит на балансе, ещё не в заказе;
    stock_written_off — уже ушло в заказы (там оно и есть себестоимость);
                      период считается по дате СПИСАНИЯ (она же дата использования)
                      — иначе отчёт за месяц смешивал бы списания всех времён
                      с остатками периода;
    sample          — «Образцы и тесты»: расход периода, выручки не будет;
    overhead        — общехозяйственное.
    """
    conn = get_production()
    try:
        where, params = ["order_id IS NULL"], []
        if date_from:
            where.append("expense_date >= ?")
            params.append(date_from)
        if date_to:
            where.append("expense_date <= ?")
            params.append(date_to)
        w = " AND ".join(where)
        by = {r["purpose"]: {"amount": round(r["total"] or 0, 2), "count": r["cnt"]}
              for r in conn.execute(
                  f"SELECT purpose, SUM(amount) AS total, COUNT(*) AS cnt FROM expenses WHERE {w} GROUP BY purpose",
                  params).fetchall()}
        wo_where, wo_params = ["stock_parent_id IS NOT NULL"], []
        if date_from:
            wo_where.append("expense_date >= ?")
            wo_params.append(date_from)
        if date_to:
            wo_where.append("expense_date <= ?")
            wo_params.append(date_to)
        wo = conn.execute(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE "
            + " AND ".join(wo_where), wo_params
        ).fetchone()
        ledger = {"amount": round(sum(by.get(p, {}).get("amount", 0) for p in LEDGER_PURPOSES), 2),
                  "count": sum(by.get(p, {}).get("count", 0) for p in LEDGER_PURPOSES)}
        stock = by.get("stock", {"amount": 0, "count": 0})
        sample = by.get("sample", {"amount": 0, "count": 0})
        overhead = by.get("overhead", {"amount": 0, "count": 0})
        return {
            "stock_open": stock["amount"],
            "stock_count": stock["count"],
            "stock_written_off": round(wo["total"] or 0, 2),
            "sample": sample["amount"],
            "sample_count": sample["count"],
            "overhead": overhead["amount"],
            "overhead_count": overhead["count"],
            # Лицевой счёт подрядчика — не расход периода, а выданный аванс:
            # в total (P&L общего контура) не входит, но и не теряется из виду.
            "contractor_ledger": ledger["amount"],
            "contractor_ledger_count": ledger["count"],
            "total": round(stock["amount"] + sample["amount"] + overhead["amount"], 2),
        }
    finally:
        conn.close()


@router.post("", status_code=201)
def create_general(body: GeneralExpenseIn):
    _validate(body)
    conn = get_production()
    try:
        eid = str(uuid4())
        conn.execute(
            """INSERT INTO expenses (id, order_id, title, amount, category, supplier, master_id,
                                     expense_date, source, finance_tx_id, zenmoney_tx_id,
                                     payment_source, accountable_person_id, purpose, created_at)
               VALUES (?, NULL, ?, ?, ?, ?, ?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?, datetime('now'))""",
            (eid, body.title.strip(), body.amount, body.category, body.supplier, body.master_id,
             body.expense_date,
             "bank" if body.finance_tx_id else ("zenmoney" if body.zenmoney_tx_id else "manual"),
             body.finance_tx_id, body.zenmoney_tx_id, body.payment_source,
             body.accountable_person_id if body.payment_source == "accountable" else None,
             body.purpose)
        )
        _sync_cash(conn, eid, body.payment_source, body.amount, body.title.strip(), body.expense_date)
        conn.commit()
        return _row(conn, eid)
    finally:
        conn.close()


@router.patch("/{expense_id}")
def update_general(expense_id: str, body: GeneralExpenseUpdate):
    patch = body.model_dump(exclude_unset=True)
    conn = get_production()
    try:
        r = conn.execute("SELECT * FROM expenses WHERE id = ? AND order_id IS NULL", (expense_id,)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        cur = dict(r)

        def val(key):
            """Переданное поле — из тела (в т.ч. явный null для очистки),
            непереданное — текущее значение строки."""
            return patch[key] if key in patch else cur.get(key)

        merged = GeneralExpenseIn(
            title=val("title") or "",
            amount=val("amount") or 0,
            purpose=val("purpose") or "stock",
            category=val("category") or "other",
            supplier=val("supplier"),
            master_id=val("master_id"),
            expense_date=val("expense_date"),
            finance_tx_id=val("finance_tx_id"),
            zenmoney_tx_id=val("zenmoney_tx_id"),
            payment_source=val("payment_source"),
            accountable_person_id=val("accountable_person_id"),
        )
        _validate(merged, check_amount="amount" in patch)
        wo = conn.execute(
            "SELECT COALESCE(SUM(amount), 0) AS t FROM expenses WHERE stock_parent_id = ?", (expense_id,)
        ).fetchone()["t"]
        # Из строки уже списывали в заказы — увести её из запаса нельзя: списанные части
        # ссылаются на неё через stock_parent_id, а откат списания возвращает сумму
        # именно в запас. Та же защита, что и в delete_general.
        if wo and merged.purpose != "stock":
            raise HTTPException(
                status_code=409,
                detail="Из этой строки уже списано в заказы — назначение остаётся «запас»")
        conn.execute(
            """UPDATE expenses SET title = ?, amount = ?, category = ?, supplier = ?, master_id = ?,
                      expense_date = COALESCE(?, expense_date), purpose = ?,
                      finance_tx_id = ?, zenmoney_tx_id = ?, payment_source = ?, accountable_person_id = ?
               WHERE id = ?""",
            (merged.title.strip(), merged.amount, merged.category, merged.supplier, merged.master_id,
             merged.expense_date, merged.purpose, merged.finance_tx_id, merged.zenmoney_tx_id,
             merged.payment_source,
             merged.accountable_person_id if merged.payment_source == "accountable" else None,
             expense_id))
        _sync_cash(conn, expense_id, merged.payment_source, merged.amount,
                   merged.title.strip(), merged.expense_date)
        conn.commit()
        out = _row(conn, expense_id)
        # amount — ОСТАТОК запаса, списанное живёт отдельными строками; отдаём обе
        # величины, чтобы «остаток + списанное» было видно целиком.
        out["written_off"] = round(wo or 0, 2)
        return out
    finally:
        conn.close()


@router.delete("/{expense_id}")
def delete_general(expense_id: str):
    """Запас, из которого уже списывали в заказы, удалить нельзя — иначе списанные
    части осиротеют и след первоисточника потеряется."""
    conn = get_production()
    try:
        r = conn.execute("SELECT id FROM expenses WHERE id = ? AND order_id IS NULL", (expense_id,)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        wo = conn.execute(
            "SELECT COUNT(*) AS c FROM expenses WHERE stock_parent_id = ?", (expense_id,)
        ).fetchone()["c"]
        if wo:
            raise HTTPException(
                status_code=409,
                detail=f"Из этой строки уже списано в заказы ({wo} шт.) — сначала удали списания")
        conn.execute("DELETE FROM fund_transactions WHERE expense_id = ?", (expense_id,))
        conn.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("/{expense_id}/write-off", status_code=201)
def write_off(expense_id: str, body: WriteOffIn):
    """Списать запас (часть или весь остаток) в заказ ДАТОЙ ИСПОЛЬЗОВАНИЯ.

    Исходная строка уменьшается на списанную сумму, в заказе появляется обычный расход
    со ссылкой stock_parent_id и с теми же tx-ссылками (паттерн from-tx). Сумма по двум
    строкам равна исходной — двойного счёта нет. Остаток так и лежит запасом."""
    conn = get_production()
    try:
        r = conn.execute(
            "SELECT * FROM expenses WHERE id = ? AND order_id IS NULL", (expense_id,)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        if (r["purpose"] or "") != "stock":
            raise HTTPException(status_code=400, detail="Списывать в заказ можно только запас (purpose=stock)")
        o = conn.execute("SELECT id, title FROM orders WHERE id = ? OR number = ?",
                         (body.order_id, body.order_id)).fetchone()
        if not o:
            raise HTTPException(status_code=404, detail=f"Заказ не найден: {body.order_id}")
        rest = round(r["amount"] or 0, 2)
        amount = round(body.amount if body.amount is not None else rest, 2)
        if amount <= 0:
            raise HTTPException(status_code=400, detail="Сумма списания должна быть > 0")
        if amount > rest + 0.01:
            raise HTTPException(
                status_code=400, detail=f"Списываем {amount:.2f} ₽, а в запасе осталось {rest:.2f} ₽")
        category = body.category or r["category"] or "material"
        if category not in EXPENSE_CATEGORIES:
            raise HTTPException(status_code=400, detail=f"category must be one of {'|'.join(EXPENSE_CATEGORIES)}")
        title = (body.title or "").strip() or f"{r['title']} (из запаса)"
        eid = str(uuid4())
        conn.execute(
            """INSERT INTO expenses (id, order_id, title, amount, category, supplier, master_id,
                                     expense_date, source, finance_tx_id, zenmoney_tx_id,
                                     payment_source, accountable_person_id, stock_parent_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?, datetime('now'))""",
            (eid, o["id"], title, amount, category, r["supplier"], r["master_id"],
             body.expense_date, r["source"] or "manual", r["finance_tx_id"], r["zenmoney_tx_id"],
             r["payment_source"], r["accountable_person_id"], expense_id))
        left = round(rest - amount, 2)
        if left <= 0.005:
            # Запас израсходован целиком — строка-остаток обнуляется, но не удаляется:
            # она первоисточник для списанных частей (stock_parent_id) и след транзакции.
            conn.execute("UPDATE expenses SET amount = 0 WHERE id = ?", (expense_id,))
        else:
            conn.execute("UPDATE expenses SET amount = ? WHERE id = ?", (left, expense_id))
        # Касса: движение по исходной строке пересчитываем под остаток, на списанную
        # часть заводим своё — иначе кассовый остаток разойдётся с фактами.
        _sync_cash(conn, expense_id, r["payment_source"], max(left, 0), r["title"], r["expense_date"])
        _sync_cash(conn, eid, r["payment_source"], amount, title, body.expense_date or r["expense_date"])
        conn.commit()
        return {"ok": True, "order_id": o["id"], "order_title": o["title"],
                "written_off": amount, "stock_left": max(left, 0),
                "expense": _row(conn, eid), "stock": _row(conn, expense_id)}
    finally:
        conn.close()


@router.delete("/write-offs/{expense_id}")
def undo_write_off(expense_id: str):
    """Откатить списание: сумма возвращается в запас, строка расхода заказа удаляется."""
    conn = get_production()
    try:
        r = conn.execute(
            "SELECT * FROM expenses WHERE id = ? AND stock_parent_id IS NOT NULL", (expense_id,)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        parent = conn.execute("SELECT * FROM expenses WHERE id = ?", (r["stock_parent_id"],)).fetchone()
        if not parent:
            raise HTTPException(status_code=409, detail="Исходная строка запаса не найдена")
        left = round((parent["amount"] or 0) + (r["amount"] or 0), 2)
        conn.execute("UPDATE expenses SET amount = ? WHERE id = ?", (left, parent["id"]))
        conn.execute("DELETE FROM fund_transactions WHERE expense_id = ?", (expense_id,))
        conn.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
        _sync_cash(conn, parent["id"], parent["payment_source"], left, parent["title"], parent["expense_date"])
        conn.commit()
        return {"ok": True, "stock_left": left}
    finally:
        conn.close()


def _sync_cash(conn, eid: str, payment_source, amount: float, title: str, expense_date):
    """Наличный расход = expense + списание кассы (см. orders._sync_cash_fund).
    Здесь своя копия: там она завязана на модель ExpenseIn заказа."""
    conn.execute("DELETE FROM fund_transactions WHERE expense_id = ?", (eid,))
    if payment_source == "cash_fund" and amount > 0:
        fund = conn.execute("SELECT id FROM funds WHERE kind = 'cash'").fetchone()
        if fund:
            conn.execute(
                """INSERT INTO fund_transactions (id, fund_id, direction, amount, note, date, expense_id)
                   VALUES (?, ?, 'out', ?, ?, COALESCE(?, date('now')), ?)""",
                (str(uuid4()), fund["id"], amount, f"Расход: {title}", expense_date, eid))
