"""Разноска прошлых трат: банковские и ZenMoney-списания → expenses по заказам.

Инбокс показывает только НЕразнесённые списания. «Разнесено» — это не флаг на
транзакции (его негде хранить: finance.db и zenmoney.db веб только читает), а
производный признак: id транзакции встречается в expenses / creditors / zm_links.
Три разных файла БД, ATTACH в проекте не используется → анти-джойн делаем в Python.
"""
import sqlite3

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


def _allocated_ids() -> tuple[set, set, bool]:
    """id уже разнесённых транзакций: (банк, zenmoney, degraded).

    Источники: expenses (наша разноска), creditors (привязка обязательств),
    accountable_ops (выдачи под отчёт — учтены, разносить нельзя),
    zm_links (разноска фин-агента, expenses не создаёт).

    degraded=True — какой-то источник прочитать не удалось, набор НЕПОЛНЫЙ.
    Молчать об этом нельзя: инбокс покажет уже разнесённую транзакцию как
    свежую, а from-tx заведёт второй расход на тот же перевод. Отсутствие
    колонки на старой схеме деградацией не считается."""
    bank, zen = set(), set()
    degraded = False
    try:
        conn = get_production()
        try:
            for tbl in ("expenses", "creditors", "accountable_ops"):
                for col, dest in (("finance_tx_id", bank), ("zenmoney_tx_id", zen)):
                    try:
                        for r in conn.execute(f"SELECT DISTINCT {col} FROM {tbl} WHERE {col} IS NOT NULL AND {col} != ''"):
                            dest.add(str(r[0]))
                    except sqlite3.OperationalError as e:
                        if "no such column" not in str(e) and "no such table" not in str(e):
                            degraded = True
        finally:
            conn.close()
    except Exception:
        degraded = True
    try:
        zc = get_zenmoney()
        try:
            for r in zc.execute("SELECT DISTINCT zm_tx_id FROM zm_links WHERE zm_tx_id IS NOT NULL AND zm_tx_id != ''"):
                zen.add(str(r[0]))
        finally:
            zc.close()
    except sqlite3.OperationalError as e:
        if "no such table" not in str(e):
            degraded = True
    except Exception:
        degraded = True
    return bank, zen, degraded


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
    limit: int = Query(100, le=2000),
):
    """Неразнесённые списания. payee_hint — подсказка поставщика/категории."""
    bank_done, zen_done, degraded = _allocated_ids()
    dismissed = _dismissed_out_map(source)
    rules = _load_payee_rules()
    masters_match, name_to_id = _load_masters_matching()
    out = []
    truncated = False

    if source == "bank":
        conn = get_finance()
        try:
            # Авто-распределённые мимо инбокса: налоги → раздел «Налоги», переводы
            # между своими — не расход бизнеса, комиссии банка → «Регулярные траты»
            # (на заказы их не разнести).
            from routers.taxes import TAX_TX_SQL
            from routers.finance import OWN_TRANSFER_SQL, BANK_FEE_SQL
            sql = (f"SELECT * FROM transactions WHERE direction = 'out'"
                   f" AND NOT {TAX_TX_SQL} AND NOT {OWN_TRANSFER_SQL} AND NOT {BANK_FEE_SQL}")
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
            # Разнесённые/скрытые отсеиваются в Python (разные файлы БД) → читаем
            # страницами, пока не набрали limit. «Запас limit*3» терял старые
            # неразнесённые, когда разнесённых большинство (тот же приём, что в payments).
            sql += " ORDER BY date DESC, id DESC LIMIT ? OFFSET ?"
            CHUNK, offset, done = 500, 0, False
            while not done and len(out) < limit:
                page = conn.execute(sql, params + [CHUNK, offset]).fetchall()
                if len(page) < CHUNK:
                    done = True
                offset += CHUNK
                for r in page:
                    if str(r["id"]) in bank_done:
                        continue
                    if str(r["id"]) in dismissed and not show_dismissed:
                        continue
                    res = _resolve_payee(r["counterparty"] or "", rules, masters_match)
                    # Контрагент помечен «личное» правилом — не бизнес-расход, мимо Разноски.
                    if res.get("entity_type") == "personal" and not show_dismissed:
                        continue
                    out.append({
                        "id": str(r["id"]), "source": "bank", "date": r["date"], "amount": r["amount"],
                        "counterparty": r["counterparty"], "purpose": r["purpose"], "bank": r["bank"],
                        "payee_hint": res.get("display_name"),
                        "category_hint": _guess_category(res.get("category")),
                        "dismissed_reason": dismissed.get(str(r["id"])),
                        **_payee_fields(res, name_to_id),
                    })
                    if len(out) >= limit:
                        truncated = not (done and r is page[-1])
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
            sql += " ORDER BY date DESC, id DESC LIMIT ? OFFSET ?"
            import json as _json
            from routers.finance import ZEN_OWN_PAYEES, zen_recurring_category
            CHUNK, offset, done = 500, 0, False
            while not done and len(out) < limit:
                page = conn.execute(sql, params + [CHUNK, offset]).fetchall()
                if len(page) < CHUNK:
                    done = True
                offset += CHUNK
                for r in page:
                    if str(r["id"]) in zen_done:
                        continue
                    # Перевод себе на карту вне ZenMoney (Райффайзен) — не расход.
                    if (r["payee"] or "").strip() in ZEN_OWN_PAYEES:
                        continue
                    # Личные регулярки (подписки/связь/услуги карт) → «Регулярные траты».
                    if zen_recurring_category(r["payee"]):
                        continue
                    if str(r["id"]) in dismissed and not show_dismissed:
                        continue
                    res = _resolve_payee(r["payee"] or "", rules, masters_match)
                    # Контрагент помечен «личное» (друг, разовое) — в личном ZM-леджере
                    # трата остаётся, а из Разноски убираем.
                    if res.get("entity_type") == "personal" and not show_dismissed:
                        continue
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
                        truncated = not (done and r is page[-1])
                        break
        finally:
            conn.close()

    # degraded: набор «уже разнесённых» неполный — часть строк может быть
    # ложно-свежей. UI обязан показать предупреждение вместо тихого списка.
    return {"items": out, "count": len(out), "truncated": truncated, "source": source,
            "degraded": degraded}


class Allocation(BaseModel):
    # order_id пуст → строка уходит «без заказа» с назначением purpose
    # (запас / собственный образец / общехозяйственное, ТЗ stock_and_samples 01.08.2026).
    order_id: Optional[str] = None
    purpose: Optional[str] = None       # stock | sample | overhead | contractor_pay | contractor_third_party
    amount: float
    # Гранулярность по строке: своя категория/подрядчик/поставщик на каждый заказ.
    # Если не заданы — берём из тела (обратная совместимость со старым форматом).
    category: Optional[str] = None
    master_id: Optional[str] = None
    supplier: Optional[str] = None
    creditor_id: Optional[str] = None   # какое обязательство гасит эта строка
    # Расход по допработе заказа (order_extras.id, ТЗ extra_works 01.08.2026):
    # «это по допу», а не по смете — в план-факт основной сметы такой расход не идёт.
    extra_id: Optional[str] = None


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
    from routers.orders import EXPENSE_CATEGORIES, _check_extra
    from routers.general_expenses import PURPOSES, LEDGER_PURPOSES

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
        if not a.order_id and not a.purpose:
            raise HTTPException(status_code=400, detail=f"строке нужен order_id либо purpose ({'|'.join(PURPOSES)})")
        if a.order_id and a.purpose:
            # purpose заполняется ТОЛЬКО при order_id IS NULL (см. general_expenses).
            # Молча уронить его в заказной ветке нельзя: клиент считает, что завёл
            # запас, а строка легла в себестоимость заказа.
            raise HTTPException(
                status_code=400,
                detail="order_id и purpose взаимоисключающие: расход либо на заказ, либо общий "
                       f"({'|'.join(PURPOSES)})")
        if a.purpose and a.purpose not in PURPOSES:
            raise HTTPException(status_code=400, detail=f"purpose must be {'|'.join(PURPOSES)}")
        if a.purpose in LEDGER_PURPOSES and not (a.master_id or body.master_id):
            # Оборот лицевого счёта без мастера повис бы в воздухе: деньги ушли,
            # ни заказ, ни лицевой счёт их не видят.
            raise HTTPException(status_code=400,
                                detail=f"purpose={a.purpose} требует master_id (чей это лицевой счёт)")

    # Транзакция должна существовать и быть ещё не разнесённой
    bank_done, zen_done, degraded = _allocated_ids()
    if degraded:
        # Набор «уже разнесённых» неполный — создание расхода сейчас рискует
        # дублем на тот же перевод. Тот же паттерн, что в payments.py.
        raise HTTPException(status_code=503, detail="Список разнесённых транзакций прочитан не полностью — попробуй ещё раз через минуту")
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
        # Мастер обязан существовать: непустой, но выдуманный id создавал расход,
        # который не виден ни в заказе (order_id IS NULL), ни на одном лицевом счёте
        # (_entries ищет по master_id) — ровно то, что проверка должна была исключить.
        for mid in {a.master_id or body.master_id for a in body.allocations
                    if a.purpose in LEDGER_PURPOSES}:
            if not conn.execute("SELECT 1 FROM masters WHERE id = ?", (mid,)).fetchone():
                raise HTTPException(status_code=404, detail=f"Подрядчик не найден: {mid}")
        col = "finance_tx_id" if body.source == "bank" else "zenmoney_tx_id"
        created = []
        for a in body.allocations:
            if a.purpose and not a.order_id:
                # Часть перевода не относится ни к какому заказу: запас/образец/общехоз.
                # Обязательства не гасит (они у заказов), tx-ссылка остаётся — иначе
                # инбокс посчитает транзакцию неразнесённой и заведёт дубль.
                eid = str(uuid4())
                conn.execute(
                    """INSERT INTO expenses (id, order_id, title, amount, category, supplier, master_id,
                                             expense_date, source, finance_tx_id, zenmoney_tx_id,
                                             group_id, purpose, match_status, matched_by, created_at)
                       VALUES (?, NULL, ?, ?, ?, ?, ?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, 'manual', 'inbox', datetime('now'))""",
                    (eid, title, a.amount, a.category or body.category, a.supplier or supplier,
                     a.master_id or body.master_id, exp_date, src, fin_id, zen_id, group_id, a.purpose))
                created.append(eid)
                continue
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
                    # Погашено целиком — закрываем С ПРИЧИНОЙ: строка без closed_reason
                    # читалась лицевым счётом как «списано», а не «оплачено».
                    conn.execute(
                        f"""UPDATE creditors
                            SET paid = ?, {col} = COALESCE({col}, ?),
                                closed_at = CASE WHEN ? >= total - 0.01 AND status != 'closed'
                                                 THEN datetime('now') ELSE closed_at END,
                                closed_reason = CASE WHEN ? >= total - 0.01
                                                     THEN COALESCE(closed_reason, 'paid_in_full') ELSE closed_reason END,
                                status = CASE WHEN ? >= total - 0.01 THEN 'closed' ELSE status END
                            WHERE id = ?""",
                        (new_paid, body.tx_id, new_paid, new_paid, new_paid, cred)
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
                                         group_id, extra_id, match_status, matched_by, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?, 'manual', 'inbox', datetime('now'))""",
                (eid, oid, title, a.amount, row_cat, row_supplier, row_master,
                 exp_date, src, cred, fin_id, zen_id, group_id,
                 # Доп обязан быть допом ЭТОГО заказа — как и creditor_id выше:
                 # чужой id увёл бы траты в cost_fact допа другого заказа.
                 _check_extra(conn, oid, a.extra_id))
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


@router.get("/map")
def expenses_map():
    """Куда разнесены СПИСАНИЯ — зеркало orders.payments-map для поступлений.

    В ДДС было видно, к каким заказам привязаны приходы, но не расходы: транзакция
    выглядела неразнесённой, хотя деньги давно разложены по заказам, а откатить
    ошибочную разноску можно было только зайдя в один из затронутых заказов.

    Ключ — id транзакции строкой (в finance.db он INTEGER, в zenmoney UUID),
    с префиксом источника, чтобы id банка и ZenMoney не столкнулись."""
    conn = get_production()
    try:
        rows = conn.execute(
            """SELECT e.id AS expense_id, e.amount, e.expense_date, e.category, e.title,
                      e.group_id, e.finance_tx_id, e.zenmoney_tx_id, e.purpose,
                      o.id AS order_id, o.number, o.title AS order_title
               FROM expenses e LEFT JOIN orders o ON o.id = e.order_id
               WHERE e.finance_tx_id IS NOT NULL OR e.zenmoney_tx_id IS NOT NULL"""
        ).fetchall()
        out = {}
        for r in rows:
            d = dict(r)
            key = (f"bank:{d['finance_tx_id']}" if d["finance_tx_id"]
                   else f"zen:{d['zenmoney_tx_id']}")
            out.setdefault(key, []).append(d)
        return out
    finally:
        conn.close()


@router.delete("/groups/{group_id}")
def delete_group(group_id: str):
    """Откат всей разноски одной поездки/платежа."""
    conn = get_production()
    try:
        # Касса фондов: снять связанные движения, иначе после отката группы
        # в кассе остаются фантомные списания (образец — delete_expense).
        conn.execute(
            "DELETE FROM fund_transactions WHERE expense_id IN (SELECT id FROM expenses WHERE group_id = ?)",
            (group_id,))
        cur = conn.execute("DELETE FROM expenses WHERE group_id = ?", (group_id,))
        conn.commit()
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Not found")
        return {"ok": True, "deleted": cur.rowcount}
    finally:
        conn.close()
