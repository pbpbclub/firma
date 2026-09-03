"""Лицевой счёт подрядчика — взаиморасчёты с оборотами в обе стороны и сальдо.

ТЗ фин-агента 05.08.2026. Расчёты с мастером шире, чем «расход по заказу»:
  • Кебра просит оплатить с ИП ткань для ЧУЖОГО заказа — деньги наши, себестоимость
    не наша ни по одному заказу: это аванс в натуре, гасится его будущими работами;
  • один перевод 20 000 ₽ уходит авансом сразу на два заказа;
  • «сколько мы должны мастеру на сегодня» не считается: начисления в creditors,
    выплаты в expenses, и вместе они нигде не сходятся.

РЕГИСТР СОБИРАЕТСЯ ИЗ СУЩЕСТВУЮЩИХ ИСТОЧНИКОВ, а не дублирует их (иначе оборот
задвоится, как задваивался факт до инварианта «одна оплата = один факт»):
  начислено   (+)  creditors по имени мастера — total;
  выплачено   (−)  expenses.master_id + creditors.paid, НЕ покрытые расходом;
  за него     (−)  expenses.purpose='contractor_third_party' (оплата третьему лицу);
  аванс       (−)  expenses.purpose='contractor_pay' (деньги мастеру вне заказа);
  зачёт/ручное     master_ledger — только то, чему нет места среди денег и обязательств.

Сальдо = Σ начислено − Σ выплачено. Плюс — мы должны мастеру, минус — он должен
отработать (выдан аванс).

Обе новые purpose живут ТОЛЬКО при order_id IS NULL, поэтому в себестоимость заказов
и в накладные (A8 фильтрует purpose='overhead') не попадают по построению.
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from uuid import uuid4

from audit import audit
from db import get_production
from obligations import recognized as _recognized

router = APIRouter()

# Знак оборота: +1 — мы должны больше, −1 — наш долг гасится, 0 — справка.
KIND_SIGN = {"accrual": 1, "payment": -1, "third_party": -1, "offset": -1, "adjust": 1,
             "accepted": 0}
KIND_LABELS = {
    "accrual":     "Начислено",
    "payment":     "Выплачено",
    "third_party": "Оплачено за него",
    "offset":      "Зачёт",
    "adjust":      "Корректировка",
    "accepted":    "Принято, не оплачено",
}
# Виды, которые можно завести руками (POST /entries). «accepted» сюда не входит:
# это не оборот, а справочная строка, и master_ledger.kind под CHECK без неё.
MANUAL_KINDS = tuple(k for k in KIND_SIGN if k != "accepted")
# purpose расходов, относящихся к лицевому счёту, а не к заказам
LEDGER_PURPOSES = ("contractor_pay", "contractor_third_party")

# A1 (ТЗ 24.08.2026): расход по заказу — это «работа принята». Двинул ли он деньги
# мастеру, говорит expenses.settled_by. Движение по лицевому счёту рождают только
# cash и offset; advance/third_party значат «минус уже проведён в другом месте»
# (выдачей аванса, оплатой за него), none — «ещё должны».
# NULL у старых строк = cash: миграция не меняет ни одного сальдо.
SETTLED_KIND = {
    None:          "payment",
    "":            "payment",
    "cash":        "payment",
    "offset":      "offset",
    "advance":     "accepted",
    "third_party": "accepted",
    "none":        "accepted",
}
SETTLED_LABELS = {
    "cash":        "деньгами",
    "offset":      "зачётом",
    "advance":     "авансом",
    "third_party": "оплатой за него",
    "none":        "не оплачено",
}


def _master(conn, master_id: str) -> dict:
    row = conn.execute("SELECT * FROM masters WHERE id = ?", (master_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Подрядчик не найден")
    return dict(row)


# Обязательство привязано к мастеру идентификатором через строку сметы
# (creditors.estimate_line_id → estimate_lines.master_id). Имя — только фолбэк для
# строк без такой привязки: переименование мастера рвало бы связь молча, а начисления
# обнулялись бы без единой ошибки (code_rules 05.08.2026).
_CREDITOR_SQL = """SELECT c.*, o.number AS order_number, o.title AS order_title,
                          el.master_id AS line_master_id
                     FROM creditors c
                     LEFT JOIN orders o ON o.id = c.order_id
                     LEFT JOIN estimate_lines el ON el.id = c.estimate_line_id"""
_EXPENSE_SQL = """SELECT e.*, o.number AS order_number, o.title AS order_title
                    FROM expenses e LEFT JOIN orders o ON o.id = e.order_id"""
_MANUAL_SQL = """SELECT m.*, o.number AS order_number, o.title AS order_title
                   FROM master_ledger m LEFT JOIN orders o ON o.id = m.order_id"""


def _entries(conn, master: dict) -> list[dict]:
    """Лента оборотов по мастеру, от свежих к старым. Каждая строка — один оборот
    ровно из одного источника: дубли между creditors.paid и expenses снимаются тем
    же правилом, что в masters._paid_total (creditor_id либо совпадение id транзакции)."""
    mid, name = master["id"], master["name"]

    creditors = [dict(r) for r in conn.execute(
        _CREDITOR_SQL + """
           WHERE el.master_id = ?
              OR (c.name = ? AND (el.master_id IS NULL OR el.master_id = ?))""",
        (mid, name, mid)).fetchall()]
    # Только явный master_id (ТЗ A1 п.3 от 24.08.2026). Фолбэк по e.supplier
    # раньше тянул в выплаты чужие расходы: supplier — свободный текст («Ант Сервис
    # (Денис Мельничук)»), совпадение с именем мастера случайно. Подсказку «похоже,
    # это он — привязать?» даёт интерфейс, сальдо на догадках не строится.
    expenses = [dict(r) for r in conn.execute(
        _EXPENSE_SQL + " WHERE e.master_id = ?", (mid,)).fetchall()]
    manual = [dict(r) for r in conn.execute(
        _MANUAL_SQL + " WHERE m.master_id = ?", (mid,)).fetchall()]

    from obligations import coverage as _coverage
    return _build_entries(creditors, expenses, manual, _coverage(conn))


def _entries_bulk(conn, masters: list[dict]) -> dict[str, list[dict]]:
    """То же самое сразу по всем мастерам: три запроса на весь список, а не три на
    каждого (code_rules 17.07.2026 — N+1 в списочных эндпоинтах запрещён).
    Правила отнесения строки к мастеру те же, что в _entries."""
    by_name: dict[str, list[str]] = {}
    for m in masters:
        by_name.setdefault(m["name"], []).append(m["id"])
    known_ids = {m["id"] for m in masters}

    cred: dict[str, list[dict]] = {}
    exp: dict[str, list[dict]] = {}
    man: dict[str, list[dict]] = {}

    def put(bucket: dict, mids, row: dict):
        for mid in mids:
            bucket.setdefault(mid, []).append(row)

    for r in conn.execute(_CREDITOR_SQL).fetchall():
        row = dict(r)
        lm = row.get("line_master_id")
        if lm:
            # id-привязка сильнее имени: тёзка чужое обязательство не подберёт
            put(cred, [lm] if lm in known_ids else [], row)
        else:
            put(cred, by_name.get(row["name"], []), row)
    for r in conn.execute(_EXPENSE_SQL).fetchall():
        row = dict(r)
        if row.get("master_id"):
            put(exp, [row["master_id"]] if row["master_id"] in known_ids else [], row)
    for r in conn.execute(_MANUAL_SQL).fetchall():
        row = dict(r)
        put(man, [row["master_id"]] if row["master_id"] in known_ids else [], row)

    from obligations import coverage as _coverage
    cov = _coverage(conn)          # один расчёт на всю сводку, не на каждого мастера
    return {m["id"]: _build_entries(cred.get(m["id"], []), exp.get(m["id"], []),
                                    man.get(m["id"], []), cov)
            for m in masters}


def _build_entries(creditors: list[dict], expenses: list[dict], manual: list[dict],
                   coverage: dict | None = None) -> list[dict]:
    """Сборка ленты из уже загруженных источников — общая для одиночного счёта
    и для сводки сальдо, чтобы правила дедупа не разъезжались между экранами.

    coverage — покрытие обязательств фактом (obligations.coverage): нужно, чтобы
    у ЗАКРЫТЫХ обязательств начислять признанное, а не полный план сметы. Один
    источник на лицевой счёт и на экран «Мы должны» — иначе две цифры долга по
    одному подрядчику разъедутся."""
    out = []

    def add(kind, amount, date, title, **ref):
        out.append({"kind": kind, "kind_label": KIND_LABELS[kind],
                    "sign": KIND_SIGN[kind], "amount": round(amount or 0, 2),
                    "effect": round(KIND_SIGN[kind] * (amount or 0), 2),
                    "date": (date or "")[:10], "title": title, **ref})

    paid_creditors = set()      # обязательства, оплата по которым уже в ленте
    # Проводка лицевого счёта главнее строки сметы (ТЗ 03.09.2026): ручное
    # начисление по обязательству — это сверка с мастером, «прикидка закрыта фактом».
    # Строка с такой проводкой своего начисления не даёт, иначе оборот задваивается.
    manual_accrued = {m["creditor_id"] for m in manual
                      if m["kind"] == "accrual" and m.get("creditor_id")}

    for c in creditors:
        if c["status"] == "cancelled" or not c["total"]:
            continue
        # Постоянные обязательства (аренда) — не расчёт с подрядчиком, а накладные
        # расходы фирмы (orders._overhead_month). Тёзка-мастер тянул бы их в сальдо
        # каждый месяц, и долг рос бы вечно.
        if (c.get("kind") or "") == "fixed":
            continue
        if c["id"] in manual_accrued:
            continue
        live = c["status"] in ("open", "partial")
        recognized = c["total"]
        if not live and c.get("closed_reason") != "recognized":
            # Начисление ЗАКРЫТОГО обязательства = признанная сумма, а не полный план:
            # завершение заказа списывает непокрытый остаток (obligations.close_for_order),
            # и полный total оставил бы у подрядчика фантомный долг на списанное.
            # Исключение — closed_reason='recognized': «работа принята, долг стоит».
            # with_ledger=False: выплата лицевого счёта уже стоит в ленте минусом,
            # поднять ею же начисление — начислить дважды (ORD-017 Спектр-Колор).
            recognized = _recognized(c, (coverage or {}).get(c["id"], {}), with_ledger=False)
            if recognized <= 0:
                continue
        add("accrual", recognized, c.get("due_date") or c.get("created_at"),
            c.get("description") or "Обязательство по смете",
            source="creditor", ref_id=c["id"], order_id=c.get("order_id"),
            order_number=c.get("order_number"), order_title=c.get("order_title"),
            plan=live)

    for e in expenses:
        purpose = e.get("purpose")
        settled = e.get("settled_by")
        if purpose == "contractor_third_party":
            kind = "third_party"        # расход вне заказа: мы заплатили за мастера
        elif purpose == "contractor_pay":
            kind = "payment"            # расход вне заказа: выдали аванс деньгами
        else:
            # Расход по заказу. Двинул ли он деньги — решает settled_by (A1).
            kind = SETTLED_KIND.get(settled, "payment")
        add(kind, e["amount"], e.get("expense_date") or e.get("created_at"),
            e.get("title") or KIND_LABELS[kind],
            source="expense", ref_id=e["id"], order_id=e.get("order_id"),
            order_number=e.get("order_number"), order_title=e.get("order_title"),
            purpose=purpose, supplier=e.get("supplier"),
            settled_by=settled, settled_label=SETTLED_LABELS.get(settled or "cash"),
            finance_tx_id=e.get("finance_tx_id"), zenmoney_tx_id=e.get("zenmoney_tx_id"),
            group_id=e.get("group_id"))

    # creditors.paid без расхода — платёж, отмеченный прямо на обязательстве.
    covered_ids = {e["creditor_id"] for e in expenses if e.get("creditor_id")}
    covered_fin = {e["finance_tx_id"] for e in expenses if e.get("finance_tx_id")}
    covered_zen = {e["zenmoney_tx_id"] for e in expenses if e.get("zenmoney_tx_id")}
    # Расход, закрытый авансом/зачётом/ничем, денег не двигал — он не может гасить
    # и creditors.paid. Иначе зачёт списывал бы долг дважды: строкой offset и
    # «оплатой обязательства», которую он же и подавил.
    settled_ids = {e["creditor_id"] for e in expenses if e.get("creditor_id")
                   and SETTLED_KIND.get(e.get("settled_by"), "payment") == "payment"}
    for c in creditors:
        if not c["paid"] or c["id"] in settled_ids:
            continue
        if c.get("finance_tx_id") and c["finance_tx_id"] in covered_fin:
            continue
        if c.get("zenmoney_tx_id") and c["zenmoney_tx_id"] in covered_zen:
            continue
        paid_creditors.add(c["id"])
        add("payment", c["paid"], c.get("updated_at") or c.get("created_at"),
            f"Оплата обязательства: {c.get('description') or c['name']}",
            source="creditor_paid", ref_id=c["id"], order_id=c.get("order_id"),
            order_number=c.get("order_number"), order_title=c.get("order_title"))

    # Ручные строки. Тот же дедуп: если операцию уже видно расходом или
    # обязательством — не повторяем. Ручное начисление по обязательству главнее
    # строки (см. manual_accrued выше), поэтому здесь оно проходит всегда.
    exp_ids = {e["id"] for e in expenses}
    for m in manual:
        if m.get("expense_id") and m["expense_id"] in exp_ids:
            continue
        if m.get("finance_tx_id") and m["finance_tx_id"] in covered_fin:
            continue
        if m.get("zenmoney_tx_id") and m["zenmoney_tx_id"] in covered_zen:
            continue
        cid = m.get("creditor_id")
        if cid and m["kind"] == "payment" and (cid in paid_creditors or cid in covered_ids):
            continue
        add(m["kind"], m["amount"], m["happened_at"], m.get("note") or KIND_LABELS[m["kind"]],
            source="ledger", ref_id=m["id"], order_id=m.get("order_id"),
            order_number=m.get("order_number"), order_title=m.get("order_title"),
            creditor_id=m.get("creditor_id"))

    out.sort(key=lambda r: (r["date"] or "", r["kind"]), reverse=True)
    return out


def _totals(entries: list[dict]) -> dict:
    def s(*kinds):
        return round(sum(e["amount"] for e in entries if e["kind"] in kinds), 2)
    return {
        "accrued": s("accrual"),
        # Из начисленного — план открытых строк смет (прикидка, не сверенный долг).
        "plan_open": round(sum(e["amount"] for e in entries if e["kind"] == "accrual" and e.get("plan")), 2),
        "paid": s("payment"),
        "third_party": s("third_party"),
        "offset": s("offset"),
        "adjust": round(sum(e["effect"] for e in entries if e["kind"] == "adjust"), 2),
        # Справка, а не оборот: работы приняты, но закрыты авансом/зачётом или ещё
        # не оплачены. В сальдо не входит (sign = 0), видно «за что мы ещё должны».
        "accepted": s("accepted"),
        "balance": round(sum(e["effect"] for e in entries), 2),
    }


@router.get("/masters/{master_id}")
def master_ledger(master_id: str,
                  date_from: Optional[str] = None,
                  date_to: Optional[str] = None):
    """Лицевой счёт: сальдо на дату + лента оборотов.

    balance > 0 — мы должны мастеру; balance < 0 — у него наш аванс.
    date_to даёт «сальдо на дату»: обороты позже отсечки в расчёт не идут.

    date_from режет только ЛЕНТУ и обороты периода: сальдо всё равно считается от
    начала истории (плюс opening_balance на входе в период) — иначе клиент получал
    бы под именем «долг мастеру» оборот за период. Оборот периода — turnover."""
    conn = get_production()
    try:
        master = _master(conn, master_id)
        entries = _entries(conn, master)
    finally:
        conn.close()
    if date_to:
        entries = [e for e in entries if (e["date"] or "") <= date_to]
    balance = round(sum(e["effect"] for e in entries), 2)
    opening = 0.0
    if date_from:
        opening = round(sum(e["effect"] for e in entries if (e["date"] or "") < date_from), 2)
        entries = [e for e in entries if (e["date"] or "") >= date_from]
    totals = _totals(entries)
    totals["turnover"] = totals["balance"]      # обороты отобранного периода
    totals["opening_balance"] = opening
    totals["balance"] = balance                 # сальдо на date_to по всей истории
    return {"master": {"id": master["id"], "name": master["name"],
                       "role": master.get("role"), "status": master.get("status")},
            "date_from": date_from, "date_to": date_to,
            **totals, "entries": entries, "count": len(entries)}


@router.get("/balances")
def balances(date_to: Optional[str] = None,
             nonzero: bool = Query(True, description="только мастера с ненулевым сальдо")):
    """Сальдо по всем подрядчикам одним запросом — «кому и сколько мы должны»."""
    conn = get_production()
    try:
        masters = [dict(r) for r in conn.execute(
            "SELECT id, name, role, status FROM masters ORDER BY name").fetchall()]
        # Источники грузим один раз на весь список: _entries в цикле давал три
        # полных скана creditors/expenses/master_ledger на каждого мастера.
        bulk = _entries_bulk(conn, masters)
        rows = []
        for m in masters:
            entries = bulk.get(m["id"], [])
            if date_to:
                entries = [e for e in entries if (e["date"] or "") <= date_to]
            t = _totals(entries)
            if nonzero and not entries:
                continue
            if nonzero and abs(t["balance"]) < 0.01 and not t["accrued"]:
                continue
            rows.append({**{k: m[k] for k in ("id", "name", "role", "status")},
                         "master_id": m["id"], **t, "entries_count": len(entries)})
    finally:
        conn.close()
    rows.sort(key=lambda r: -abs(r["balance"]))
    return {"items": rows, "count": len(rows), "date_to": date_to,
            "we_owe": round(sum(r["balance"] for r in rows if r["balance"] > 0), 2),
            "they_owe": round(-sum(r["balance"] for r in rows if r["balance"] < 0), 2)}


class EntryIn(BaseModel):
    master_id: str
    kind: str                       # accrual | payment | third_party | offset | adjust
    amount: float
    happened_at: Optional[str] = None
    order_id: Optional[str] = None
    note: Optional[str] = None
    creditor_id: Optional[str] = None
    expense_id: Optional[str] = None
    finance_tx_id: Optional[str] = None
    zenmoney_tx_id: Optional[str] = None
    source: str = "manual"


@router.post("/entries", status_code=201)
def create_entry(body: EntryIn):
    """Ручной оборот: зачёт встречных требований, начисление вне сметы, корректировка.

    Для оборотов, за которыми стоят реальные деньги, это НЕ тот вход — заводи расход
    (POST /api/ledger/contractor-pay либо разноску транзакции), иначе оборот
    задвоится: регистр видит и расход, и ручную строку."""
    if body.kind not in MANUAL_KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {'|'.join(MANUAL_KINDS)}")
    if body.amount is None or (body.amount <= 0 and body.kind != "adjust"):
        raise HTTPException(status_code=400, detail="amount must be > 0 (отрицательная — только у adjust)")
    conn = get_production()
    try:
        _master(conn, body.master_id)
        if body.order_id and not conn.execute(
                "SELECT 1 FROM orders WHERE id = ?", (body.order_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Заказ не найден")
        if body.creditor_id:
            # Обязательство уже само по себе оборот регистра — ручная строка поверх
            # него задваивает. Запрет из докстринга выражаем кодом, а не надеждой.
            c = conn.execute("SELECT status, total, paid FROM creditors WHERE id = ?",
                             (body.creditor_id,)).fetchone()
            if not c:
                raise HTTPException(status_code=404, detail="Обязательство не найдено")
            # Ручное начисление по строке — сверка с мастером, оно вытесняет план
            # строки (ledger._build_entries). Задваивает только ВТОРАЯ ручная проводка.
            if body.kind == "accrual" and conn.execute(
                    "SELECT 1 FROM master_ledger WHERE creditor_id = ? AND kind = 'accrual'",
                    (body.creditor_id,)).fetchone():
                raise HTTPException(
                    status_code=409,
                    detail="Ручное начисление по этому обязательству уже проведено — второе задвоит оборот")
            if body.kind == "payment" and (c["paid"] or 0):
                raise HTTPException(
                    status_code=409,
                    detail="Оплата по этому обязательству уже в регистре — заведи расход, а не ручную строку")
        eid = str(uuid4())
        conn.execute(
            """INSERT INTO master_ledger (id, master_id, kind, amount, happened_at, order_id,
                                          note, creditor_id, expense_id, finance_tx_id,
                                          zenmoney_tx_id, source)
               VALUES (?, ?, ?, ?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?, ?)""",
            (eid, body.master_id, body.kind, body.amount, body.happened_at, body.order_id,
             body.note, body.creditor_id, body.expense_id, body.finance_tx_id,
             body.zenmoney_tx_id, body.source))
        conn.commit()
        row = dict(conn.execute("SELECT * FROM master_ledger WHERE id = ?", (eid,)).fetchone())
    finally:
        conn.close()
    return row


@router.delete("/entries/{entry_id}")
def delete_entry(entry_id: str):
    conn = get_production()
    try:
        cur = conn.execute("DELETE FROM master_ledger WHERE id = ?", (entry_id,))
        conn.commit()
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Оборот не найден")
    finally:
        conn.close()
    return {"ok": True}


def _settle_on_order(conn, *, master: dict, order_id: str, amount: float, settled_by: str,
                     creditor_id: Optional[str] = None, title: Optional[str] = None,
                     category: Optional[str] = None, happened_at: Optional[str] = None) -> dict:
    """Расход по заказу, закрытый НЕ новыми деньгами (A2, ТЗ 24.08.2026).

    Себестоимость заказа растёт (работа принята), а лицевой счёт либо получает
    минус «зачёт», либо не двигается вовсе — решает settled_by (SETTLED_KIND).

    Почему расход, а не строка master_ledger: обязательство гасит покрытие L1
    (obligations.coverage смотрит expenses.creditor_id), и факт заказа берётся из
    expenses — ручная строка регистра не делает ни того, ни другого. Поэтому оба
    входа (форма расхода в карточке заказа и карточка подрядчика) пишут ОДНО и то
    же: один расход. Иначе зачёт по ORD-023 двигал бы сальдо, но 18 800 ₽ по-прежнему
    показывались бы в плане-факте Ильинского нулём."""
    from routers.orders import EXPENSE_CATEGORIES
    o = conn.execute("SELECT id, number, title FROM orders WHERE id = ? OR number = ?",
                     (order_id, order_id)).fetchone()
    if not o:
        raise HTTPException(status_code=404, detail="Заказ не найден")
    oid = o["id"]
    cat, cred_desc = category, None
    if creditor_id:
        # Обязательство обязано принадлежать ЭТОМУ заказу — иначе зачёт погасил бы
        # чужой долг, и обе карточки показали бы одни деньги как свои (тот же
        # контроль, что у extra_id в orders._check_extra).
        c = conn.execute(
            """SELECT c.id, c.description, c.name, c.order_id, el.type AS line_type
                 FROM creditors c LEFT JOIN estimate_lines el ON el.id = c.estimate_line_id
                WHERE c.id = ?""", (creditor_id,)).fetchone()
        if not c:
            raise HTTPException(status_code=404, detail="Обязательство не найдено")
        if c["order_id"] != oid:
            raise HTTPException(status_code=400, detail="Обязательство принадлежит другому заказу")
        cred_desc = c["description"] or c["name"]
        if not cat and c["line_type"] in EXPENSE_CATEGORIES:
            cat = c["line_type"]
    cat = cat if cat in EXPENSE_CATEGORIES else "work"
    label = SETTLED_LABELS.get(settled_by, settled_by)
    eid = str(uuid4())
    conn.execute(
        """INSERT INTO expenses (id, order_id, title, amount, category, supplier, master_id,
                                 expense_date, source, creditor_id, settled_by,
                                 match_status, matched_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, date('now')), 'manual', ?, ?,
                   'manual', 'ledger', datetime('now'))""",
        (eid, oid, title or f"{cred_desc or 'Работы'} — {label} ({master['name']})",
         amount, cat, master["name"], master["id"], happened_at, creditor_id, settled_by))
    audit(conn, "expense", eid, "create",
          f"Расход {amount:g} ₽ по {o['number']}, закрыт {label} ({master['name']})")
    return {"id": eid, "order_id": oid, "order_number": o["number"], "creditor_id": creditor_id}


class OffsetIn(BaseModel):
    master_id: str
    amount: float
    order_id: Optional[str] = None      # есть → расход по заказу, нет → строка регистра
    creditor_id: Optional[str] = None
    happened_at: Optional[str] = None
    title: Optional[str] = None
    category: Optional[str] = None
    note: Optional[str] = None


@router.post("/offset", status_code=201)
def create_offset(body: OffsetIn):
    """Взаимозачёт с подрядчиком.

    С order_id — расход по заказу (settled_by='offset'): гасит обязательство и растёт
    себестоимость заказа, в лицевом счёте минус «Зачёт».
    Без order_id — строка регистра: сальдо двигается, себестоимость ничья не растёт
    (зачёт вне заказов — например, встречная услуга)."""
    if not body.amount or body.amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be > 0")
    conn = get_production()
    try:
        master = _master(conn, body.master_id)
        if body.order_id:
            res = _settle_on_order(
                conn, master=master, order_id=body.order_id, amount=body.amount,
                settled_by="offset", creditor_id=body.creditor_id,
                title=body.title or body.note, category=body.category,
                happened_at=body.happened_at)
            conn.commit()
            return {"kind": "expense", **res,
                    "hint": "обязательство закрыто зачётом, себестоимость заказа выросла"}
        if body.creditor_id:
            raise HTTPException(status_code=400,
                                detail="creditor_id без order_id: укажи заказ, которому принадлежит обязательство")
        eid = str(uuid4())
        conn.execute(
            """INSERT INTO master_ledger (id, master_id, kind, amount, happened_at, note, source)
               VALUES (?, ?, 'offset', ?, COALESCE(?, date('now')), ?, 'manual')""",
            (eid, body.master_id, body.amount, body.happened_at,
             body.note or body.title or "Взаимозачёт"))
        conn.commit()
        return {"kind": "ledger", "id": eid,
                "hint": "зачёт вне заказов: сальдо сдвинулось, себестоимость заказов не менялась"}
    finally:
        conn.close()


class ContractorPayIn(BaseModel):
    """Оплата, относящаяся к лицевому счёту, а не к заказу.

    kind='third_party' — заплатили третьему лицу ПО ПРОСЬБЕ подрядчика (ткань «Весна»
    для его собственного заказа): деньги наши, себестоимость не наша.
    kind='advance'     — деньги самому подрядчику, заказ ещё не определён."""
    master_id: str
    amount: float
    kind: str = "third_party"        # third_party | advance
    title: Optional[str] = None
    supplier: Optional[str] = None
    category: str = "other"
    expense_date: Optional[str] = None
    source: Optional[str] = None     # bank | zen — если платёж есть в банке/ZenMoney
    tx_id: Optional[str] = None
    payment_source: Optional[str] = None          # cash_fund | accountable
    accountable_person_id: Optional[str] = None   # обязателен при accountable
    note: Optional[str] = None
    # A2: чем эта оплата закрывается у нас. Указан order_id — рядом с расходом вне
    # заказа появится парный расход ПО ЗАКАЗУ (settled_by='third_party'|'advance'):
    # он гасит обязательство и растит себестоимость, но лицевой счёт второй раз не
    # двигает (SETTLED_KIND: движение уже дал расход вне заказа).
    order_id: Optional[str] = None
    creditor_id: Optional[str] = None


@router.post("/contractor-pay", status_code=201)
def contractor_pay(body: ContractorPayIn):
    """Завести оплату за подрядчика / аванс ему — расходом БЕЗ заказа.

    Ложится в expenses с purpose='contractor_third_party'|'contractor_pay' и master_id:
    в себестоимость заказов не идёт (order_id IS NULL), в накладные не идёт
    (A8 берёт только purpose='overhead'), а в лицевом счёте встаёт в дебет."""
    from routers.expenses import _allocated_ids
    from routers.general_expenses import GeneralExpenseIn, _sync_cash, _validate

    if body.kind not in ("third_party", "advance"):
        raise HTTPException(status_code=400, detail="kind must be third_party|advance")
    if not body.amount or body.amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be > 0")
    fin_id = zen_id = None
    if body.tx_id:
        if body.source not in ("bank", "zen"):
            raise HTTPException(status_code=400, detail="при tx_id нужен source=bank|zen")
        bank_done, zen_done, degraded = _allocated_ids()
        if degraded:
            raise HTTPException(status_code=503, detail="Список разнесённых транзакций прочитан не полностью — попробуй ещё раз через минуту")
        done = bank_done if body.source == "bank" else zen_done
        if str(body.tx_id) in done:
            raise HTTPException(status_code=409, detail="Транзакция уже разнесена")
        fin_id = body.tx_id if body.source == "bank" else None
        zen_id = body.tx_id if body.source == "zen" else None

    purpose = "contractor_third_party" if body.kind == "third_party" else "contractor_pay"
    conn = get_production()
    try:
        master = _master(conn, body.master_id)
        title = body.title or (
            f"Оплата за {master['name']}" + (f": {body.supplier}" if body.supplier else "")
            if body.kind == "third_party" else f"Аванс: {master['name']}")
        if body.note:
            # У expenses нет колонки note — примечание живёт в названии строки,
            # иначе оно потерялось бы молча.
            title = f"{title} ({body.note})"
        # Валидация — та же, что у основного входа расхода без заказа: свой урезанный
        # набор проверок пропускал любой payment_source и accountable без подотчётного
        # лица, а такая строка не видна ни в кассе, ни в подотчёте (code_rules 05.08.2026).
        _validate(GeneralExpenseIn(
            title=title, amount=body.amount, purpose=purpose, category=body.category,
            supplier=body.supplier, master_id=body.master_id,
            expense_date=body.expense_date, finance_tx_id=fin_id, zenmoney_tx_id=zen_id,
            payment_source=body.payment_source,
            accountable_person_id=body.accountable_person_id))
        eid = str(uuid4())
        conn.execute(
            """INSERT INTO expenses (id, order_id, title, amount, category, supplier, master_id,
                                     expense_date, source, finance_tx_id, zenmoney_tx_id,
                                     payment_source, accountable_person_id, purpose,
                                     match_status, matched_by, created_at)
               VALUES (?, NULL, ?, ?, ?, ?, ?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?,
                       'manual', 'ledger', datetime('now'))""",
            (eid, title, body.amount, body.category, body.supplier, body.master_id,
             body.expense_date, "bank" if body.source == "bank" else ("zenmoney" if body.source == "zen" else "manual"),
             fin_id, zen_id, body.payment_source,
             body.accountable_person_id if body.payment_source == "accountable" else None,
             purpose))
        _sync_cash(conn, eid, body.payment_source, body.amount, title, body.expense_date)
        settled = None
        if body.order_id:
            # Парный расход по заказу: деньги ушли выше, здесь только себестоимость
            # и погашение обязательства. Кейс ORD-023: скань «Верна» за 11 600 ₽ —
            # оплачена за Кебру, а обязательство «подушки» висело непокрытым.
            settled = _settle_on_order(
                conn, master=master, order_id=body.order_id, amount=body.amount,
                settled_by="third_party" if body.kind == "third_party" else "advance",
                creditor_id=body.creditor_id, category=body.category,
                happened_at=body.expense_date)
        elif body.creditor_id:
            raise HTTPException(status_code=400,
                                detail="creditor_id без order_id: укажи заказ, которому принадлежит обязательство")
        conn.commit()
        row = dict(conn.execute("SELECT * FROM expenses WHERE id = ?", (eid,)).fetchone())
    finally:
        conn.close()
    return {"expense": row, "purpose": purpose, "settled_on_order": settled,
            "hint": "оборот виден в GET /api/ledger/masters/{master_id}"}


@router.post("/masters/{master_id}/card")
def master_card(master_id: str,
                date_from: Optional[str] = None,
                date_to: Optional[str] = None):
    """Карточка «Расчёты с подрядчиком» одним PDF.

    Ничего не считает заново — раскладывает по вёрстке ответ master_ledger, чтобы
    выкладка сходилась с экраном до рубля."""
    import cards
    from datetime import date as _date
    from fastapi.responses import FileResponse

    d = master_ledger(master_id, date_from=date_from, date_to=date_to)
    entries = d["entries"]
    # accepted — справочный вид со знаком 0: работы приняты, деньги не двигались.
    # В обороты он не идёт (иначе читался бы как выплата), но «за что ещё должны»
    # показать нужно — отдельным блоком.
    body = [e for e in entries if e["kind"] != "accepted"]
    body.sort(key=lambda e: (e["date"] or ""), reverse=True)

    def row(key, label, cls, hint=None):
        return {"label": label, "value": d.get(key) or 0, "cls": cls, "hint": hint}

    totals = [row("accrued", "Начислено за работы", "")]
    for key, label, hint in (("paid", "Выплачено деньгами", None),
                             ("third_party", "Оплачено за него", "перевод третьему лицу"),
                             ("offset", "Зачёт", "закрыто встречным обязательством")):
        if d.get(key):
            totals.append(row(key, label, "dim", hint))
    if d.get("adjust"):
        totals.append(row("adjust", "Корректировка", "dim"))

    period = None
    if date_from or date_to:
        period = f"Период {date_from or '…'} — {date_to or 'сегодня'}"
        if d.get("opening_balance"):
            period += f" · на входе {cards.signed(d['opening_balance'])} ₽"

    path = cards.render(
        "contractor.html.j2",
        stem=f"contractor-{d['master']['name']}",
        today=_date.today().strftime("%d.%m.%Y"),
        master=d["master"],
        period=period,
        totals=totals,
        balance=d["balance"],
        entries=body,
        accepted=[e for e in entries if e["kind"] == "accepted"],
    )
    # Кириллицу в имени файла Starlette отдаёт через filename*=utf-8'' — браузер
    # сохранит «Расчёты — Игорь Кебра.pdf», а не «master.pdf».
    return FileResponse(path, media_type="application/pdf",
                        filename=f"Расчёты — {d['master']['name']}.pdf")
