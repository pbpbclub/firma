"""Разноска прошлых трат: банковские и ZenMoney-списания → expenses по заказам.

Инбокс показывает только НЕразнесённые списания. «Разнесено» — это не флаг на
транзакции (его негде хранить: finance.db и zenmoney.db веб только читает), а
производный признак: id транзакции встречается в expenses / creditors / zm_links.
Три разных файла БД, ATTACH в проекте не используется → анти-джойн делаем в Python.
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from uuid import uuid4
from datetime import date, timedelta

from db import get_production, get_finance, get_zenmoney
from routers.zenmoney import _load_payee_rules, _resolve_payee, _CATEGORY_RU, contractor_tokens


def _load_masters_matching():
    """Мастера для похожести: список [{name, tokens, id}] + карта name→id."""
    contractors, name_to_id = [], {}
    try:
        conn = get_production()
        try:
            for m in conn.execute("SELECT id, name FROM masters").fetchall():
                nm = m["name"] or ""
                contractors.append({"name": nm, "tokens": contractor_tokens(nm), "id": m["id"]})
                name_to_id[nm] = m["id"]
        finally:
            conn.close()
    except Exception:
        pass
    return contractors, name_to_id


def _payee_fields(res: dict, name_to_id: dict) -> dict:
    """master_id (из правила, уверенно) / master_suggested (похожесть, предложение) / match_source."""
    if res.get("entity_type") == "master" and res.get("entity_id"):
        return {"master_id": res["entity_id"], "master_suggested": None, "match_source": "rule"}
    # Алгоритм вернул имя — это предложение; резолвим имя→id мастера.
    if res.get("matched_via") == "algorithm" and res.get("display_name"):
        nm = res["display_name"]
        mid = name_to_id.get(nm)
        if mid:
            return {"master_id": None, "master_suggested": {"id": mid, "name": nm}, "match_source": "suggest"}
    return {"master_id": None, "master_suggested": None, "match_source": None}

router = APIRouter()

# ZenMoney — 3.5к исходящих за всё время. Без окна инбокс бесполезен;
# Юра заполняет «от какой-то даты», поэтому окно расширяемое фильтром.
ZEN_DEFAULT_DAYS = 90

# Категория расхода по подсказке из payee_rules / тега ZenMoney.
_CATEGORY_GUESS = {
    "материал": "material", "материалы": "material", "metal": "material",
    "работа": "work", "работы": "work", "услуга": "work", "услуги": "work",
    "доставка": "delivery", "транспорт": "delivery", "transport": "delivery",
}


def _guess_category(hint: Optional[str]) -> str:
    return _CATEGORY_GUESS.get((hint or "").strip().lower(), "other")


def _allocated_ids() -> tuple[set, set]:
    """id уже разнесённых транзакций: (банк, zenmoney).

    Источники: expenses (наша разноска), creditors (привязка обязательств),
    zm_links (разноска фин-агента, expenses не создаёт)."""
    bank, zen = set(), set()
    conn = get_production()
    try:
        for tbl in ("expenses", "creditors"):
            for col, dest in (("finance_tx_id", bank), ("zenmoney_tx_id", zen)):
                try:
                    for r in conn.execute(f"SELECT DISTINCT {col} FROM {tbl} WHERE {col} IS NOT NULL AND {col} != ''"):
                        dest.add(str(r[0]))
                except Exception:
                    pass  # колонки может не быть на старой схеме
    finally:
        conn.close()
    try:
        zc = get_zenmoney()
        try:
            for r in zc.execute("SELECT DISTINCT zm_tx_id FROM zm_links WHERE zm_tx_id IS NOT NULL AND zm_tx_id != ''"):
                zen.add(str(r[0]))
        finally:
            zc.close()
    except Exception:
        pass
    return bank, zen


# Скрытие списаний из инбокса (внутренние переводы между своими счетами, возвраты).
# Та же таблица inbox_dismissed, что у поступлений (source='bank-in'), но свои ключи.
_DISMISS_OUT = {"bank": "bank-out", "zen": "zen-out"}


def _dismissed_out_map(source: str) -> dict:
    """tx_id → причина скрытия для инбокса списаний."""
    conn = get_production()
    try:
        return {
            str(r["tx_id"]): r["reason"]
            for r in conn.execute(
                "SELECT tx_id, reason FROM inbox_dismissed WHERE source = ?",
                (_DISMISS_OUT[source],),
            )
        }
    finally:
        conn.close()


@router.get("/inbox")
def inbox(
    source: str = Query("bank", pattern="^(bank|zen)$"),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    search: Optional[str] = None,
    amount_min: Optional[float] = None,
    amount_max: Optional[float] = None,
    show_dismissed: bool = False,
    limit: int = Query(100, le=500),
):
    """Неразнесённые списания. payee_hint — подсказка поставщика/категории."""
    bank_done, zen_done = _allocated_ids()
    dismissed = _dismissed_out_map(source)
    rules = _load_payee_rules()
    masters_match, name_to_id = _load_masters_matching()
    out = []

    if source == "bank":
        conn = get_finance()
        try:
            # Платежи в налоговую распределяются автоматически в раздел «Налоги» —
            # на заказы их не разнести, в инбоксе им делать нечего.
            from routers.taxes import TAX_TX_SQL
            sql = f"SELECT * FROM transactions WHERE direction = 'out' AND NOT {TAX_TX_SQL}"
            params: list = []
            if date_from:
                sql += " AND date >= ?"; params.append(date_from)
            if date_to:
                sql += " AND date <= ?"; params.append(date_to)
            if amount_min is not None:
                sql += " AND amount >= ?"; params.append(amount_min)
            if amount_max is not None:
                sql += " AND amount <= ?"; params.append(amount_max)
            if search:
                sql += " AND (counterparty LIKE ? OR purpose LIKE ?)"; params += [f"%{search}%"] * 2
            sql += " ORDER BY date DESC, id DESC LIMIT ?"
            params.append(limit * 3)  # запас: часть отсеется как разнесённая
            for r in conn.execute(sql, params).fetchall():
                if str(r["id"]) in bank_done:
                    continue
                if str(r["id"]) in dismissed and not show_dismissed:
                    continue
                res = _resolve_payee(r["counterparty"] or "", rules, masters_match)
                out.append({
                    "id": str(r["id"]), "source": "bank", "date": r["date"], "amount": r["amount"],
                    "counterparty": r["counterparty"], "purpose": r["purpose"], "bank": r["bank"],
                    "payee_hint": res.get("display_name"),
                    "category_hint": _guess_category(res.get("category")),
                    "dismissed_reason": dismissed.get(str(r["id"])),
                    **_payee_fields(res, name_to_id),
                })
                if len(out) >= limit:
                    break
        finally:
            conn.close()
    else:
        if not date_from:
            date_from = (date.today() - timedelta(days=ZEN_DEFAULT_DAYS)).isoformat()
        conn = get_zenmoney()
        try:
            sql = "SELECT * FROM zm_transactions WHERE outcome > 0 AND income = 0 AND deleted = 0"
            params: list = []
            if date_from:
                sql += " AND date >= ?"; params.append(date_from)
            if date_to:
                sql += " AND date <= ?"; params.append(date_to)
            if amount_min is not None:
                sql += " AND outcome >= ?"; params.append(amount_min)
            if amount_max is not None:
                sql += " AND outcome <= ?"; params.append(amount_max)
            if search:
                sql += " AND (payee LIKE ? OR comment LIKE ?)"; params += [f"%{search}%"] * 2
            sql += " ORDER BY date DESC LIMIT ?"
            params.append(limit * 3)
            import json as _json
            for r in conn.execute(sql, params).fetchall():
                if str(r["id"]) in zen_done:
                    continue
                if str(r["id"]) in dismissed and not show_dismissed:
                    continue
                res = _resolve_payee(r["payee"] or "", rules, masters_match)
                try:
                    tags = _json.loads(r["tags"] or "[]")
                except Exception:
                    tags = []
                zen_cat = tags[0] if tags else ""
                out.append({
                    "id": str(r["id"]), "source": "zen", "date": r["date"], "amount": r["outcome"],
                    "counterparty": r["payee"], "purpose": r["comment"], "account": r["outcome_account"],
                    "payee_hint": res.get("display_name"),
                    "category_hint": _guess_category(res.get("category") or _CATEGORY_RU.get(zen_cat) or zen_cat),
                    "zen_tag": _CATEGORY_RU.get(zen_cat) or zen_cat or None,
                    "dismissed_reason": dismissed.get(str(r["id"])),
                    **_payee_fields(res, name_to_id),
                })
                if len(out) >= limit:
                    break
        finally:
            conn.close()

    return {"items": out, "count": len(out), "source": source}


class Allocation(BaseModel):
    order_id: str
    amount: float
    # Гранулярность по строке: своя категория/подрядчик/поставщик на каждый заказ.
    # Если не заданы — берём из тела (обратная совместимость со старым форматом).
    category: Optional[str] = None
    master_id: Optional[str] = None
    supplier: Optional[str] = None
    creditor_id: Optional[str] = None   # какое обязательство гасит эта строка


class FromTxIn(BaseModel):
    source: str                      # bank | zen
    tx_id: str
    title: Optional[str] = None
    category: str = "other"
    supplier: Optional[str] = None
    master_id: Optional[str] = None
    expense_date: Optional[str] = None
    allocations: List[Allocation]


@router.post("/from-tx", status_code=201)
def create_from_tx(body: FromTxIn):
    """Разнести транзакцию на 1..N заказов. N>1 — одна поездка на несколько заказов."""
    from routers.orders import EXPENSE_CATEGORIES

    if body.source not in ("bank", "zen"):
        raise HTTPException(status_code=400, detail="source must be bank|zen")
    if body.category not in EXPENSE_CATEGORIES:
        raise HTTPException(status_code=400, detail=f"category must be one of {'|'.join(EXPENSE_CATEGORIES)}")
    if not body.allocations:
        raise HTTPException(status_code=400, detail="allocations required")
    if any(a.amount is None or a.amount <= 0 for a in body.allocations):
        raise HTTPException(status_code=400, detail="each allocation amount must be > 0")
    for a in body.allocations:
        if a.category and a.category not in EXPENSE_CATEGORIES:
            raise HTTPException(status_code=400, detail=f"category must be one of {'|'.join(EXPENSE_CATEGORIES)}")

    # Транзакция должна существовать и быть ещё не разнесённой
    bank_done, zen_done = _allocated_ids()
    if body.source == "bank":
        if str(body.tx_id) in bank_done:
            raise HTTPException(status_code=409, detail="Транзакция уже разнесена")
        c = get_finance()
        try:
            tx = c.execute("SELECT * FROM transactions WHERE id = ?", (body.tx_id,)).fetchone()
        finally:
            c.close()
        if not tx:
            raise HTTPException(status_code=404, detail="Транзакция не найдена")
        tx_amount, tx_date = tx["amount"], tx["date"]
        tx_payee, tx_note = tx["counterparty"], tx["purpose"]
    else:
        if str(body.tx_id) in zen_done:
            raise HTTPException(status_code=409, detail="Транзакция уже разнесена")
        c = get_zenmoney()
        try:
            tx = c.execute("SELECT * FROM zm_transactions WHERE id = ?", (body.tx_id,)).fetchone()
        finally:
            c.close()
        if not tx:
            raise HTTPException(status_code=404, detail="Транзакция не найдена")
        tx_amount, tx_date = tx["outcome"], tx["date"]
        tx_payee, tx_note = tx["payee"], tx["comment"]

    total = round(sum(a.amount for a in body.allocations), 2)
    if abs(total - round(tx_amount or 0, 2)) > 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"Сумма разноски {total} не сходится с транзакцией {round(tx_amount or 0, 2)}"
        )

    title = (body.title or tx_payee or tx_note or "Расход").strip()
    supplier = body.supplier or tx_payee
    exp_date = body.expense_date or (tx_date or "")[:10] or None
    group_id = str(uuid4()) if len(body.allocations) > 1 else None
    fin_id = body.tx_id if body.source == "bank" else None
    zen_id = body.tx_id if body.source == "zen" else None
    src = "bank" if body.source == "bank" else "zenmoney"

    conn = get_production()
    try:
        col = "finance_tx_id" if body.source == "bank" else "zenmoney_tx_id"
        created = []
        for a in body.allocations:
            o = conn.execute("SELECT id FROM orders WHERE id = ? OR number = ?", (a.order_id, a.order_id)).fetchone()
            if not o:
                raise HTTPException(status_code=404, detail=f"Заказ не найден: {a.order_id}")
            oid = o["id"]
            # Per-row поля с откатом на тело (обратная совместимость)
            row_cat = a.category or body.category
            row_master = a.master_id or body.master_id
            row_supplier = a.supplier or supplier

            # Гашение обязательства. Явный creditor_id из строки, иначе авто-поиск
            # открытого обязательства этого заказа с тем же подрядчиком (по имени)
            # или уже привязанного к этой транзакции.
            cred = a.creditor_id
            if cred:
                # Строка гасит конкретное обязательство — двигаем paid и линкуем tx.
                c = conn.execute("SELECT id, total, paid FROM creditors WHERE id = ? AND order_id = ?", (cred, oid)).fetchone()
                if c:
                    new_paid = round((c["paid"] or 0) + a.amount, 2)
                    conn.execute(
                        f"""UPDATE creditors
                            SET paid = ?, {col} = COALESCE({col}, ?),
                                status = CASE WHEN ? >= total THEN 'closed' ELSE status END
                            WHERE id = ?""",
                        (new_paid, body.tx_id, new_paid, cred)
                    )
                else:
                    cred = None  # чужое/несуществующее обязательство — не гасим
            if not cred:
                # Связать с обязательством, уже привязанным к этой транзакции (только линк).
                cr = conn.execute(f"SELECT id FROM creditors WHERE order_id = ? AND {col} = ?", (oid, body.tx_id)).fetchone()
                if cr:
                    cred = cr["id"]

            eid = str(uuid4())
            conn.execute(
                """INSERT INTO expenses (id, order_id, title, amount, category, supplier, master_id,
                                         expense_date, source, creditor_id, finance_tx_id, zenmoney_tx_id,
                                         group_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, datetime('now'))""",
                (eid, oid, title, a.amount, row_cat, row_supplier, row_master,
                 exp_date, src, cred, fin_id, zen_id, group_id)
            )
            created.append(eid)
        # Разнесли по-настоящему → скрытие (если было) снимаем, как в payments.
        conn.execute(
            "DELETE FROM inbox_dismissed WHERE tx_id = ? AND source = ?",
            (str(body.tx_id), _DISMISS_OUT.get(body.source, "bank-out")),
        )
        conn.commit()
        rows = [dict(r) for r in conn.execute(
            f"SELECT * FROM expenses WHERE id IN ({','.join('?' * len(created))})", created
        ).fetchall()]
        return {"ok": True, "group_id": group_id, "created": len(rows), "items": rows}
    finally:
        conn.close()


class DismissOutIn(BaseModel):
    source: str = "bank"             # bank | zen
    reason: Optional[str] = None


@router.post("/inbox/{tx_id}/dismiss")
def dismiss_out_tx(tx_id: str, body: Optional[DismissOutIn] = None):
    """Скрыть списание из инбокса: внутренний перевод между своими счетами, возврат…
    Транзакция уходит из Разноски; помеченные «Перевод между своими» ещё и
    исключаются из оборотов ДДС (finance._transfer_tx_ids)."""
    src = (body.source if body else "bank")
    if src not in _DISMISS_OUT:
        raise HTTPException(status_code=400, detail="source must be bank|zen")
    conn = get_production()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO inbox_dismissed (tx_id, source, reason) VALUES (?, ?, ?)",
            (str(tx_id), _DISMISS_OUT[src], body.reason if body else None),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/inbox/{tx_id}/dismiss")
def undismiss_out_tx(tx_id: str, source: str = Query("bank", pattern="^(bank|zen)$")):
    conn = get_production()
    try:
        conn.execute(
            "DELETE FROM inbox_dismissed WHERE tx_id = ? AND source = ?",
            (str(tx_id), _DISMISS_OUT[source]),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/groups/{group_id}")
def delete_group(group_id: str):
    """Откат всей разноски одной поездки/платежа."""
    conn = get_production()
    try:
        cur = conn.execute("DELETE FROM expenses WHERE group_id = ?", (group_id,))
        conn.commit()
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Not found")
        return {"ok": True, "deleted": cur.rowcount}
    finally:
        conn.close()
