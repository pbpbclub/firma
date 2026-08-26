"""Обязательства: покрытие фактом и закрытие расчётов по заказу.

Единый источник на весь проект — его читают экран «Мы должны» (finance.py),
карточка заказа (orders.py) и лицевой счёт подрядчика (ledger.py). Лежит рядом
с money.py/audit.py, а не в routers/: это расчёт, а не эндпоинт.

ЗАЧЕМ. Обязательство рождается из строки сметы при её утверждении — это ПЛАН
закупок. Деньги подрядчику уходят расходами (expenses), а `creditors.paid`
двигается только при разноске транзакции с тем же tx_id: на 04.08.2026 из
830 512 ₽ обязательств отмечено оплаченными 18 400 (2%). Поэтому экран показывал
полный план как долг — 812 112 ₽ при реальных 139 553.

Покрытие считается НА ЛЕТУ и ничего не пишет в базу: `creditors.paid` остаётся
как был. Правится только `status` — и только явным действием человека
(завершение заказа, кнопка «закрыть»), см. close_for_order.

🔒 ЖЁСТКОЕ ПРАВИЛО. Уровень L3 (сопоставление по имени подрядчика) НИКОГДА не
попадает в `NOT EXISTS`-дедуп факта (orders.py::_plan_fact и пять его собратьев).
L1/L2 отвечают на вопрос «это один и тот же платёж» — у них есть общий ключ.
L3 отвечает «похоже, тот же» — этого достаточно, чтобы не пугать Юру фантомным
долгом на экране, и категорически недостаточно, чтобы вычитать деньги из факта
заказа: добавь L3 в _plan_fact — и `creditors.paid` перестанет попадать в факт,
себестоимость просядет, маржа вырастет на пустом месте.
"""
from typing import Optional

from routers.masters import _norm_name
from routers.orders import _bucket

# Расходы, которые к сметным обязательствам отношения не имеют:
# contractor_pay/third_party — контур лицевого счёта (ledger.py),
# overhead/stock/sample — траты «мимо заказа» (ТЗ stock_and_samples).
_ALIEN_PURPOSES = ("overhead", "contractor_pay", "contractor_third_party", "stock", "sample")

_EPS = 0.01   # деньги в REAL: сравнение только через порог (правило Б3, code_rules 04.08)

# Почему обязательство закрыто. По причине откат переоткрывает ровно своё:
# вернул заказ из архива — открылось закрытое архивацией, закрытое вручную
# и погашенное полностью осталось закрытым.
CLOSE_REASONS = ("order_completed", "order_cancelled", "order_archived", "manual", "paid_in_full")


def _payee(row) -> str:
    """Кому ушёл расход: точная связь важнее текста (supplier — свободное поле)."""
    return _norm_name(row["master_name"] or row["supplier"])


# Ярлык плановой строки, а не контрагент: _gen_obligations называет обязательство
# без исполнителя как «{Материал|Работа|Услуга|Доставка|Прочее}: {название строки}»
# (estimates.py:1124). Живьём таких 60 из 76 — принять их за подрядчика значит
# искать расход поставщику «Материал: Отводы».
_PLAN_LABELS = ("материал:", "работа:", "услуга:", "доставка:", "прочее:")


def _payees_of(cred) -> set:
    """Кому адресовано обязательство. Плановый исполнитель строки сметы надёжнее
    имени обязательства: у «Работа: Сварка» имя подрядчика вообще не содержит."""
    names = {_norm_name(cred["line_master_name"]), _norm_name(cred["line_contractor"])}
    raw = (cred["name"] or "").strip().lower()
    if not raw.startswith(_PLAN_LABELS):
        names.add(_norm_name(cred["name"]))
    return {n for n in names if n}


def coverage(conn, order_ids: Optional[list] = None) -> dict:
    """Сколько по каждому обязательству уже закрыто фактом.

    Возвращает {creditor_id: {covered, covered_exact, covered_by_name, level,
    sources, bucket_hint, ambiguous}}. Два запроса на весь экран — никакого N+1
    (code_rules 17.07), считается пакетно даже для одного заказа. В набор входят
    и ЗАКРЫТЫЕ обязательства: их покрытие нужно лицевому счёту, чтобы начислять
    признанное вместо полного плана.

    Уровни, строго по убыванию доверия:
      L1 creditor_id — явная связь, её ставит разноска и форма расхода;
      L2 tx_id       — тот же перевод банка/ZenMoney в границах ЭТОГО заказа;
      L3 подрядчик   — расход тому, кому адресовано обязательство (в границах заказа);
      L4 категория   — только подсказка (bucket_hint), из долга НЕ вычитается.

    Каждый расход — кошелёк: потратив рубль на одно обязательство, он не может
    потратить его на второе. Порядок обхода фиксирован, поэтому пересчёт на тех
    же данных даёт тот же ответ.
    """
    where_c, where_e, params_c, params_e = "", "", [], []
    if order_ids is not None:
        if not order_ids:
            return {}
        holes = ",".join("?" * len(order_ids))
        where_c = f" AND c.order_id IN ({holes})"
        where_e = f" AND e.order_id IN ({holes})"
        params_c, params_e = list(order_ids), list(order_ids)

    creds = [dict(r) for r in conn.execute(f"""
        SELECT c.id, c.order_id, c.name, c.total, c.paid, c.status, c.due_date, c.created_at,
               c.finance_tx_id, c.zenmoney_tx_id,
               el.master_id       AS line_master_id,
               el.contractor_name AS line_contractor,
               lm.name            AS line_master_name,
               COALESCE(el.type, ei.category, 'other') AS line_type
          FROM creditors c
          LEFT JOIN estimate_lines el ON el.id = c.estimate_line_id
          LEFT JOIN estimate_items ei ON ei.id = c.estimate_item_id
          LEFT JOIN masters        lm ON lm.id = el.master_id
         WHERE c.order_id IS NOT NULL
           AND (c.kind IS NULL OR c.kind != 'fixed')
           AND c.status IN ('open', 'partial', 'closed')
           {where_c}""", params_c).fetchall()]
    if not creds:
        return {}

    exps = [dict(r) for r in conn.execute(f"""
        SELECT e.id, e.order_id, e.amount, e.category, e.supplier, e.master_id,
               e.creditor_id, e.finance_tx_id, e.zenmoney_tx_id, e.settled_by,
               e.expense_date, e.created_at, e.title,
               m.name AS master_name
          FROM expenses e
          LEFT JOIN masters m ON m.id = e.master_id
         WHERE e.order_id IS NOT NULL
           AND e.extra_id IS NULL
           AND (e.purpose IS NULL OR e.purpose NOT IN ({','.join('?' * len(_ALIEN_PURPOSES))}))
           {where_e}""", list(_ALIEN_PURPOSES) + params_e).fetchall()]

    # Детерминированный порядок. Живые обязательства разбирают факт ПЕРВЫМИ:
    # они видны на экране и требуют решения, а закрытые нужны только лицевому
    # счёту — чтобы у списанного обязательства начисление равнялось признанному
    # и подрядчик не оказался в фантомном «авансе» (ledger._build_entries).
    creds.sort(key=lambda c: (c["status"] == "closed",
                              c["due_date"] or "9999", c["created_at"] or "", c["id"]))
    exps.sort(key=lambda e: (e["expense_date"] or "", e["created_at"] or "", e["id"]))

    wallet = {e["id"]: round(e["amount"] or 0, 2) for e in exps}   # свободный остаток расхода
    by_order = {}
    for e in exps:
        by_order.setdefault(e["order_id"], []).append(e)

    out = {c["id"]: {"covered": 0.0, "covered_exact": 0.0, "covered_by_name": 0.0,
                     "level": None, "sources": [], "bucket_hint": 0.0, "ambiguous": False}
           for c in creds}

    def take(cred, exp, limit: float, level: str) -> float:
        """Списать с кошелька расхода не больше limit; вернуть списанное."""
        amount = min(wallet[exp["id"]], limit)
        if amount <= _EPS:
            return 0.0
        wallet[exp["id"]] = round(wallet[exp["id"]] - amount, 2)
        res = out[cred["id"]]
        # settled_by — «чем закрыто» (A1): карточка обязательства показывает не только
        # сколько покрыто, но и деньгами это было, зачётом, авансом или оплатой за него.
        res["sources"].append({"expense_id": exp["id"], "title": exp["title"],
                               "amount": round(amount, 2), "level": level,
                               "settled_by": exp.get("settled_by") or "cash",
                               "date": exp["expense_date"]})
        if res["level"] is None:
            res["level"] = level
        return round(amount, 2)

    # ── L1/L2: явные связи. Это те же ключи, что в инварианте «одна оплата = один факт».
    for c in creds:
        res = out[c["id"]]
        for e in by_order.get(c["order_id"], []):
            same_creditor = e["creditor_id"] and e["creditor_id"] == c["id"]
            same_tx = ((e["finance_tx_id"] and e["finance_tx_id"] == c["finance_tx_id"])
                       or (e["zenmoney_tx_id"] and e["zenmoney_tx_id"] == c["zenmoney_tx_id"]))
            if not (same_creditor or same_tx):
                continue
            level = "creditor_id" if same_creditor else "tx_id"
            rest = max(0.0, (c["total"] or 0) - res["covered_exact"])
            res["covered_exact"] = round(res["covered_exact"] + take(c, e, rest, level), 2)

    # ── L3: по подрядчику. Расход, уже потраченный на L1/L2, сюда не попадёт —
    # у его кошелька нулевой остаток.
    for c in creds:
        res = out[c["id"]]
        # признано после L1/L2: max, а не сумма — from-tx поднимает paid И создаёт
        # расход с creditor_id, это одни деньги (ORD-020 покраска: 12 000, не 24 000).
        recognized = max(c["paid"] or 0, res["covered_exact"])
        rest = round(max(0.0, (c["total"] or 0) - recognized), 2)
        if rest <= _EPS:
            continue
        targets = _payees_of(c)
        if not targets:
            continue
        for e in by_order.get(c["order_id"], []):
            if wallet[e["id"]] <= _EPS or _payee(e) not in targets:
                continue
            got = take(c, e, rest, "contractor")
            res["covered_by_name"] = round(res["covered_by_name"] + got, 2)
            rest = round(rest - got, 2)
            if rest <= _EPS:
                break

    # ── L4: подсказка по категории для обязательств без подрядчика. НЕ вычитается.
    for c in creds:
        res = out[c["id"]]
        res["covered"] = round(res["covered_exact"] + res["covered_by_name"], 2)
        if res["covered"] > _EPS or _payees_of(c):
            continue
        want = _bucket(c["line_type"])
        hint = sum(wallet[e["id"]] for e in by_order.get(c["order_id"], [])
                   if _bucket(e["category"]) == want and wallet[e["id"]] > _EPS)
        if hint > _EPS:
            res["bucket_hint"] = round(hint, 2)
            res["ambiguous"] = True
    return out


def unpaid_for_order(conn, oid: str) -> list:
    """Живые обязательства заказа с остатком после учёта факта — то, что Юра
    увидит в окне подтверждения при завершении заказа."""
    cov = coverage(conn, [oid])
    rows = conn.execute(
        """SELECT * FROM creditors
            WHERE order_id = ? AND status IN ('open','partial')
              AND (kind IS NULL OR kind != 'fixed')
            ORDER BY total DESC""", (oid,)).fetchall()
    out = []
    for r in rows:
        c = cov.get(r["id"], {})
        out.append({
            "id": r["id"], "name": r["name"], "description": r["description"],
            "plan": round(r["total"] or 0, 2),
            "fact": round(max(r["paid"] or 0, c.get("covered_exact", 0.0)) + c.get("covered_by_name", 0.0), 2),
            "debt": effective_debt(r, c),
            "cover_level": c.get("level"),
            "ambiguous": c.get("ambiguous", False),
        })
    return out


def _close_rows(conn, ids: list, reason: str) -> dict:
    """Закрыть строки по id с причиной; вернуть снимки ДО изменения.
    paid/total не трогаются — факт себестоимости (_plan_fact) от закрытия не меняется."""
    assert reason in CLOSE_REASONS, reason
    if not ids:
        return {}
    holes = ",".join("?" * len(ids))
    # Снимки строк собираем ДО UPDATE: журнал должен помнить состояние «до»,
    # иначе восстановить закрытое по ошибке будет нечем.
    before_rows = {r["id"]: dict(r) for r in conn.execute(
        f"SELECT * FROM creditors WHERE id IN ({holes})", ids).fetchall()}
    conn.execute(
        f"""UPDATE creditors SET status = 'closed', closed_at = datetime('now'), closed_reason = ?
             WHERE id IN ({holes})""", [reason, *ids])
    return before_rows


def close_for_order(conn, oid: str, *, force: bool = False, only_ids: Optional[list] = None,
                    reason: str = "order_completed") -> dict:
    """Закрыть расчёты по заказу (завершение заказа или кнопка «закрыть»).

    Единственное место, где статус обязательства меняется автоматически. Без
    force и при наличии остатка возвращает needs_confirm — решение «списать или
    оставить долгом» принимает Юра построчно: план сметы и факт расходятся
    законно (ORD-020: «Работа: Сварка» 30 000 против 17 000 Малафееву).

    closed_reason='order_completed' — не украшение: по нему откат «завершил по
    ошибке» переоткроет ровно эти строки и не тронет закрытые вручную.
    """
    items = unpaid_for_order(conn, oid)
    if only_ids is not None:
        keep = set(only_ids)
        items = [i for i in items if i["id"] in keep]
    unpaid = [i for i in items if i["debt"] > _EPS]
    if unpaid and not force:
        return {"needs_confirm": True, "items": items,
                "unpaid_total": round(sum(i["debt"] for i in unpaid), 2)}
    if not items:
        return {"closed": 0, "written_off": 0.0, "items": [], "before_rows": {}}
    ids = [i["id"] for i in items]
    before_rows = _close_rows(conn, ids, reason)
    return {"closed": len(items),
            "written_off": round(sum(i["debt"] for i in items), 2),
            "items": items, "before_rows": before_rows, "reason": reason}


def reopen_for_order(conn, oid: str, reason="order_completed") -> dict:
    """Заказ вернули из терминального состояния (завершён/отменён/архив) —
    переоткрыть то, что закрылось ИМЕННО этими переходами. Закрытые вручную и
    погашенные полностью (paid_in_full) не трогаем.

    `reason` — строка или список причин: терминал → терминал причину закрытых не
    переписывает (completed → cancelled оставляет строки с order_completed),
    поэтому возврат в работу обязан переоткрывать ВСЮ цепочку статусных причин,
    а не только последнюю — иначе закрытое завершением не вернётся никогда
    (orders.TERMINAL_REASONS)."""
    reasons = [reason] if isinstance(reason, str) else list(dict.fromkeys(reason))
    assert reasons and all(r in CLOSE_REASONS for r in reasons), reason
    holes = ",".join("?" * len(reasons))
    cur = conn.execute(
        f"""UPDATE creditors SET status = 'open', closed_at = NULL, closed_reason = NULL
             WHERE order_id = ? AND status = 'closed' AND closed_reason IN ({holes})""",
        (oid, *reasons))
    return {"reopened": cur.rowcount}


def close_manual(conn, ids: list) -> dict:
    """Кнопка «Закрыть выбранные»: всё или ничего. Любой id, которого нет, который
    уже закрыт или который постоянный (kind='fixed'), — ValueError со списком:
    частичное закрытие оставило бы Юру гадать, что именно прошло."""
    # Повтор id в теле запроса — не второе закрытие: без дедупа строка попадала
    # дважды в closed/written_off и дважды в журнал об одном и том же закрытии.
    ids = list(dict.fromkeys(ids or []))
    if not ids:
        return {"closed": 0, "written_off": 0.0, "items": [], "before_rows": {}}
    holes = ",".join("?" * len(ids))
    rows = {r["id"]: dict(r) for r in conn.execute(
        f"SELECT * FROM creditors WHERE id IN ({holes})", ids).fetchall()}
    bad = []
    for cid in ids:
        r = rows.get(cid)
        if not r:
            bad.append({"id": cid, "name": None, "why": "не найдено"})
        elif r["status"] not in ("open", "partial"):
            bad.append({"id": cid, "name": r["name"], "why": "уже закрыто"})
        elif r.get("kind") == "fixed":
            bad.append({"id": cid, "name": r["name"], "why": "постоянное — своя вкладка"})
    if bad:
        raise ValueError(bad)
    oids = sorted({r["order_id"] for r in rows.values() if r["order_id"]})
    cov = coverage(conn, oids) if oids else {}
    items = []
    for cid in ids:
        r = rows[cid]; c = cov.get(cid, {})
        items.append({"id": cid, "name": r["name"], "plan": round(r["total"] or 0, 2),
                      "fact": round(max(r["paid"] or 0, c.get("covered_exact", 0.0)) + c.get("covered_by_name", 0.0), 2),
                      "debt": effective_debt(r, c)})
    before_rows = _close_rows(conn, ids, "manual")
    return {"closed": len(ids), "written_off": round(sum(i["debt"] for i in items), 2),
            "items": items, "before_rows": before_rows}


def effective_debt(cred_row, cov: Optional[dict] = None) -> float:
    """Остаток обязательства с учётом факта: план − признанное, не меньше нуля.

    Признанное = max(paid, L1+L2) + L3. max — потому что paid и расход с
    creditor_id по одной разноске это один платёж, а не два.
    """
    cov = cov or {}
    total = (cred_row["total"] if not isinstance(cred_row, dict) else cred_row.get("total")) or 0
    paid = (cred_row["paid"] if not isinstance(cred_row, dict) else cred_row.get("paid")) or 0
    recognized = max(paid, cov.get("covered_exact", 0.0)) + cov.get("covered_by_name", 0.0)
    return round(max(0.0, total - recognized), 2)
