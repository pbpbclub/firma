"""Траты по заграничным картам: отбор, категории, аналитика (22.09.2026).

Единственная точка правды для раздела «Грузия». Почему отдельный модуль, а не
ветка в `zenmoney.py`: тот экран рублёвый и живёт на тегах ZenMoney, а здесь
категория выводится из получателя по своему справочнику.

🔒 Строки отбираются по НАЗВАНИЯМ счетов региона, а не по валюте ноги. Три счёта
BOG называются одинаково, поэтому `Scope.row_currency()` для них `unknown`, и
фильтр по валюте вернул бы пусто. Название при этом принадлежит только счетам
региона — отбор точен, неизвестна лишь валюта конкретной строки.

🔒 Пока валюта не разделена, суммы отдаются БЕЗ валюты (`currency: None`) и с
флагом `currency_known: False`. Подставить ₾ по умолчанию нельзя: доллары
(APPLE.COM/BILL, ANTHROPIC) лежат вперемешку с лари, и такая «аккуратность»
занизила бы их в 2,6 раза.
"""

import json
from collections import defaultdict

from db import get_production, get_zenmoney

CASH_COMMENT = "cash withdrawal"


class _NoAccount:
    id = None


Account0 = _NoAccount()
FALLBACK = "other"

# Потолок выборки из zm_transactions на один запрос. LIMIT режет строки ДО
# python-фильтров ленты, поэтому упёршийся потолок обязан доезжать до экрана
# признаком (`capped`), а не читаться как полная история периода.
ROW_CAP = 20000


# ── справочник ───────────────────────────────────────────────────────────────

def categories(conn=None) -> list[dict]:
    own = conn is None
    conn = conn or get_production()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT code, title, sort_order, active FROM abroad_categories"
            " WHERE active = 1 ORDER BY sort_order, title").fetchall()]
    finally:
        if own:
            conn.close()


def load_rules(conn=None) -> list[dict]:
    """Правила «получатель → категория».

    Порядок применения задаётся здесь, а не в SQL: сначала точное совпадение,
    потом префикс, потом вхождение; внутри каждого вида — САМЫЙ ДЛИННЫЙ паттерн
    первым. Иначе общее правило («llc ») перебивало бы частное («lampionebi»).
    """
    own = conn is None
    conn = conn or get_production()
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT id, pattern, match_type, category, note FROM abroad_payee_rules").fetchall()]
    finally:
        if own:
            conn.close()
    order = {"exact": 0, "prefix": 1, "contains": 2}
    rows.sort(key=lambda r: (order.get(r["match_type"], 9), -len(r["pattern"] or "")))
    return rows


def categorize(payee: str | None, comment: str | None, rules: list[dict]) -> str:
    """Категория операции. Не угадываем — либо правило, либо «прочее»."""
    text = (payee or "").strip().lower()
    note = (comment or "").strip().lower()
    # Снятие наличных опознаём по назначению платежа: в выписке BOG получателем
    # стоит сам банк, и по имени это неотличимо от покупки в его отделении.
    if CASH_COMMENT in note:
        return "cash"
    if not text:
        return FALLBACK
    for r in rules:
        p = (r["pattern"] or "").lower()
        if not p:
            continue
        mt = r["match_type"]
        if (mt == "exact" and text == p) or (mt == "prefix" and text.startswith(p)) \
                or (mt == "contains" and p in text):
            return r["category"]
    return FALLBACK


# ── отбор строк ──────────────────────────────────────────────────────────────

def region_titles(scope, code: str) -> list[str]:
    """Названия счетов региона (включая архивные и cash — трата есть трата)."""
    return sorted({a.title for a in scope.accounts(include_cash=True) if a.region == code})


def fetch_rows(scope, code: str, date_from: str | None = None, date_to: str | None = None,
               search: str | None = None, limit: int = 2000) -> list[dict]:
    titles = region_titles(scope, code)
    if not titles:
        return []
    marks = ",".join("?" * len(titles))
    sql = (f"SELECT * FROM zm_transactions WHERE deleted = 0"
           f" AND (outcome_account IN ({marks}) OR income_account IN ({marks}))")
    params: list = titles + titles
    if date_from:
        sql += " AND date >= ?"; params.append(date_from)
    if date_to:
        sql += " AND date <= ?"; params.append(date_to)
    if search:
        sql += " AND (payee LIKE ? OR comment LIKE ?)"; params += [f"%{search}%"] * 2
    sql += " ORDER BY date DESC, id DESC LIMIT ?"
    params.append(limit)
    conn = get_zenmoney()
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def first_date(scope, code: str) -> str | None:
    """С какой даты у карт региона вообще есть история (для честного сравнения)."""
    titles = region_titles(scope, code)
    if not titles:
        return None
    marks = ",".join("?" * len(titles))
    conn = get_zenmoney()
    try:
        r = conn.execute(f"SELECT MIN(date) FROM zm_transactions WHERE deleted = 0"
                         f" AND (outcome_account IN ({marks}) OR income_account IN ({marks}))",
                         titles + titles).fetchone()
        return (r[0] or "")[:10] or None
    finally:
        conn.close()


def capped(rows: list[dict]) -> bool:
    """Упёрлась ли выборка в потолок SQL. Ровно ROW_CAP строк считаем обрезанием
    (лучше лишняя плашка, чем молча укороченный период)."""
    return len(rows) >= ROW_CAP


def decorate(rows: list[dict], scope, rules: list[dict], titles: list[str] | None = None) -> list[dict]:
    """Строка → вид для ленты: направление, сумма, валюта (если известна), категория.

    🔒 У двуногой строки нога выбирается по ПРИНАДЛЕЖНОСТИ счёта региону, а не по
    знаку сумм. Пополнение грузинской карты с рублёвого счёта — одна строка
    (`ушло 9 511,50 ₽ с Райффайзена, пришло 300 ₾`): фиксированный `side='outcome'`
    подставлял бы в ленту региона рублёвую сумму, рублёвую валюту и чужой счёт.
    `titles` — названия счетов региона (`region_titles`); без них поведение прежнее.
    """
    cats = {c["code"]: c["title"] for c in categories()}
    own = set(titles or [])
    out = []
    for r in rows:
        inc, out_ = r.get("income") or 0, r.get("outcome") or 0
        out_acc, in_acc = r.get("outcome_account"), r.get("income_account")
        if inc > 0 and out_ > 0:
            # Обе ноги свои (обмен внутри региона) либо региона не знаем — прежняя
            # нога расхода; иначе берём ту, что принадлежит региону.
            if own and in_acc in own and out_acc not in own:
                kind, amount, side = "transfer", inc, "income"
            else:
                kind, amount, side = "transfer", out_, "outcome"
        elif out_ > 0:
            kind, amount, side = "expense", out_, "outcome"
        else:
            kind, amount, side = "income", inc, "income"
        cur = scope.row_currency(r, side)
        known = cur != "unknown"
        cat = categorize(r.get("payee"), r.get("comment"), rules) if kind == "expense" else None
        try:
            tags = json.loads(r.get("tags") or "[]")
        except Exception:
            tags = []
        out.append({
            "id": str(r.get("id")), "date": r.get("date"), "kind": kind,
            "amount": round(amount, 2),
            "currency": cur if known else None, "currency_known": known,
            "payee": r.get("payee"), "comment": r.get("comment"),
            "category": cat, "category_title": cats.get(cat) if cat else None,
            "zen_tag": tags[0] if tags else None,
            "account": out_acc if side == "outcome" else in_acc,
            # Счёт, с которого операция: пока три счёта BOG делят одно название,
            # он неоднозначен — экран пишет «валюта?», а не выбирает наугад.
            "account_id": (scope.account_of(out_acc if side == "outcome" else in_acc) or Account0).id,
            "account_ambiguous": scope.account_of(out_acc if side == "outcome" else in_acc) is None,
        })
    return out


# ── аналитика ────────────────────────────────────────────────────────────────

def payee_key(payee: str | None) -> str:
    """Ключ склейки получателя. В выписке одно и то же место пишется по-разному
    («SPAR» и «Spar», «Bank of Georgia» и «Bank Of Georgia»), и без склейки топ
    получателей делится пополам, а регулярный платёж перестаёт быть регулярным."""
    return (payee or "—").strip().casefold()


def _bucket(agg: dict, key, amount: float, currency, date: str | None, label: str | None = None):
    slot = agg.setdefault(key, {"total": 0.0, "count": 0, "currencies": set(), "last": None,
                                "labels": {}})
    if label:
        slot["labels"][label] = slot["labels"].get(label, 0) + 1
    slot["total"] = round(slot["total"] + amount, 2)
    slot["count"] += 1
    slot["currencies"].add(currency)
    if date and (slot["last"] is None or date > slot["last"]):
        slot["last"] = date


def _flat(agg: dict, name_key: str, titles: dict | None = None) -> list[dict]:
    out = []
    for key, s in agg.items():
        known = {c for c in s["currencies"] if c}
        # Подпись — самое частое написание получателя, ключ — приведённый.
        labels = s.get("labels") or {}
        label = max(labels, key=labels.get) if labels else (titles or {}).get(key, key)
        out.append({
            name_key: key,
            "title": (titles or {}).get(key) or label,
            "total": round(s["total"], 2),
            "count": s["count"],
            "avg": round(s["total"] / s["count"], 2) if s["count"] else 0,
            # Валюта у группы одна и известна — печатаем со знаком; иначе честно None.
            "currency": next(iter(known)) if len(known) == 1 and not any(c is None for c in s["currencies"]) else None,
            "mixed": len(s["currencies"]) > 1,
            "last": s["last"],
        })
    return sorted(out, key=lambda x: -x["total"])


def recurring(items: list[dict], min_months: int = 3) -> list[dict]:
    """Регулярные списания: получатель с оплатами в ≥3 РАЗНЫХ месяцах.

    Свой детектор, а не `finance.zen_recurring_category`: тот знает русские
    подписки по именам («Яндекс.Плюс», «МегаФон»), здесь же латиница и заранее
    неизвестный список — признаком служит сама регулярность."""
    by_payee: dict[str, dict] = {}
    for i in items:
        if i["kind"] != "expense" or not (i["payee"] or "").strip():
            continue
        slot = by_payee.setdefault(payee_key(i["payee"]), {"months": set(), "total": 0.0, "count": 0,
                                                          "last": None, "currencies": set(),
                                                          "labels": {},
                                                          "category": i["category"],
                                                          "category_title": i["category_title"]})
        label = i["payee"].strip()
        slot["labels"][label] = slot["labels"].get(label, 0) + 1
        slot["months"].add((i["date"] or "")[:7])
        slot["total"] = round(slot["total"] + i["amount"], 2)
        slot["count"] += 1
        slot["currencies"].add(i["currency"])
        if i["date"] and (slot["last"] is None or i["date"] > slot["last"]):
            slot["last"] = i["date"]
    out = []
    for payee, s in by_payee.items():
        if len(s["months"]) < min_months:
            continue
        known = {c for c in s["currencies"] if c}
        out.append({
            "payee": max(s["labels"], key=s["labels"].get) if s["labels"] else payee,
            "months": len(s["months"]), "count": s["count"],
            "total": round(s["total"], 2),
            "avg": round(s["total"] / s["count"], 2),
            "per_month": round(s["total"] / len(s["months"]), 2),
            "last": s["last"], "category": s["category"], "category_title": s["category_title"],
            "currency": next(iter(known)) if len(known) == 1 and not any(c is None for c in s["currencies"]) else None,
        })
    return sorted(out, key=lambda x: -x["per_month"])


UNKNOWN = "unknown"


def currency_groups(items: list[dict]) -> list[dict]:
    """Траты по валютам ноги. Ключ `unknown` — валюта ещё не разделена."""
    agg: dict[str, dict] = {}
    for i in items:
        if i["kind"] != "expense":
            continue
        key = i["currency"] or UNKNOWN
        slot = agg.setdefault(key, {"key": key, "currency": None if key == UNKNOWN else key,
                                    "total": 0.0, "count": 0})
        slot["total"] = round(slot["total"] + i["amount"], 2)
        slot["count"] += 1
    return sorted(agg.values(), key=lambda s: -s["total"])


def spending(items: list[dict], currency: str | None = None) -> dict:
    """Сводка: месяц к месяцу, категории, топ получателей, регулярные списания.

    🔒 Суммы разных валют не складываются. Если в наборе больше одной валюты,
    сводка считается ПО ОДНОЙ из них (самой крупной, `currency_auto`), а остальные
    перечислены в `by_currency` — переключатель на экране. Иначе доллары
    (APPLE.COM/BILL, ANTHROPIC) и лари (SPAR) давали бы один бессмысленный итог,
    и столбики месяцев с топом получателей оставались бы смешанными навсегда.
    """
    cats = {c["code"]: c["title"] for c in categories()}
    groups = currency_groups(items)
    auto = False
    if currency is None and len(groups) > 1:
        currency, auto = groups[0]["key"], True
    if currency:
        items = [i for i in items if (i["currency"] or UNKNOWN) == currency]
    by_month, by_cat, by_payee = {}, {}, {}
    income_by_month: dict[str, float] = defaultdict(float)
    spent = 0.0
    currencies: set = set()

    for i in items:
        if i["kind"] == "income":
            income_by_month[(i["date"] or "")[:7]] += i["amount"]
            continue
        if i["kind"] != "expense":
            continue        # конвертации и переводы внутри карты — не траты
        spent += i["amount"]
        currencies.add(i["currency"])
        _bucket(by_month, (i["date"] or "")[:7], i["amount"], i["currency"], i["date"])
        _bucket(by_cat, i["category"] or FALLBACK, i["amount"], i["currency"], i["date"])
        _bucket(by_payee, payee_key(i["payee"]), i["amount"], i["currency"], i["date"],
                label=(i["payee"] or "—").strip())

    months = sorted(_flat(by_month, "period"), key=lambda m: m["period"])
    for m in months:
        m["incomes"] = round(income_by_month.get(m["period"], 0), 2)
    known = {c for c in currencies if c}
    return {
        "months": months,
        "categories": _flat(by_cat, "category", cats),
        "top_payees": _flat(by_payee, "payee")[:20],
        "recurring": recurring(items),
        **shape(items),
        "spent": round(spent, 2),
        "count": sum(1 for i in items if i["kind"] == "expense"),
        # Одна валюта на все траты — печатаем со знаком; иначе экран обязан
        # сказать, что суммы смешаны, а не рисовать ₾.
        "currency": next(iter(known)) if len(known) == 1 and not any(c is None for c in currencies) else None,
        "currency_split": bool(known) and not any(c is None for c in currencies),
        # Какие валюты вообще есть в периоде и по какой посчитана эта сводка.
        "by_currency": groups,
        "currency_filter": currency,
        "currency_auto": auto,
    }


# ── Форма трат для инфографики (23.09.2026) ─────────────────────────────────

WEEKDAYS_RU = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]


def shape(items: list[dict]) -> dict:
    """Показатели для инфографики аналитики: дни недели, средний чек, день-рекорд,
    среднее в день. Считается по уже отфильтрованным (одна валюта) тратам —
    вызывающий `spending` фильтрует до вызова."""
    from datetime import date as _d
    exp = [i for i in items if i["kind"] == "expense" and i.get("date")]
    by_dow = [{"dow": d, "label": WEEKDAYS_RU[d], "total": 0.0, "count": 0} for d in range(7)]
    by_day: dict[str, float] = {}
    for i in exp:
        d = _d.fromisoformat(i["date"][:10])
        slot = by_dow[d.weekday()]
        slot["total"] = round(slot["total"] + i["amount"], 2)
        slot["count"] += 1
        by_day[d.isoformat()] = round(by_day.get(d.isoformat(), 0.0) + i["amount"], 2)
    total = sum(i["amount"] for i in exp)
    # Среднее в день — по календарным дням от первой до последней траты, а не по
    # дням с тратами: иначе тихие дни не учитываются и «в день» завышено.
    if by_day:
        first, last = min(by_day), max(by_day)
        span = (_d.fromisoformat(last) - _d.fromisoformat(first)).days + 1
    else:
        span = 0
    top_day = max(by_day.items(), key=lambda kv: kv[1]) if by_day else None
    return {
        "by_weekday": by_dow,
        "avg_check": round(total / len(exp), 2) if exp else 0.0,
        "daily_avg": round(total / span, 2) if span else 0.0,
        "active_days": len(by_day),
        "span_days": span,
        "max_day": {"date": top_day[0], "total": top_day[1]} if top_day else None,
    }


# ── Период: столбики по масштабу и дельта к предыдущему окну (23.09.2026) ────

def window_buckets(items: list[dict], date_from: str, date_to: str) -> dict:
    """Столбики по масштабу окна: ≤ 31 дня — по дням, ≤ 120 — по неделям (с
    понедельника), дальше — по месяцам. Неделю по месяцам не покажешь (один
    столбик), а год по дням — частокол из 365 палочек."""
    from datetime import date as _d, timedelta as _td
    d0, d1 = _d.fromisoformat(date_from), _d.fromisoformat(date_to)
    days = (d1 - d0).days + 1
    kind = "day" if days <= 31 else "week" if days <= 120 else "month"

    def key_of(ds: str) -> str:
        d = _d.fromisoformat(ds[:10])
        if kind == "day":
            return d.isoformat()
        if kind == "week":
            return (d - _td(days=d.weekday())).isoformat()
        return d.strftime("%Y-%m")

    agg: dict[str, dict] = {}
    # Пустые корзины тоже нужны — иначе тихая неделя выпадает из ряда
    cur = d0
    while cur <= d1:
        agg.setdefault(key_of(cur.isoformat()), {"period": key_of(cur.isoformat()), "total": 0.0, "count": 0})
        cur += _td(days=1)
    for i in items:
        if i["kind"] != "expense" or not i.get("date"):
            continue
        # Строки вне окна в корзины не идут — иначе к недельному ряду
        # прирастут чужие месяцы.
        if not (date_from <= i["date"][:10] <= date_to):
            continue
        k = key_of(i["date"])
        slot = agg.setdefault(k, {"period": k, "total": 0.0, "count": 0})
        slot["total"] = round(slot["total"] + i["amount"], 2)
        slot["count"] += 1
    return {"bucket_kind": kind, "buckets": sorted(agg.values(), key=lambda b: b["period"]),
            "days": days}


def compare(current: dict, previous: dict) -> dict:
    """Дельта текущей сводки к предыдущему окну той же длины: итог и категории.
    Обе сводки должны быть посчитаны по одной валюте — иначе дельта бессмысленна."""
    def pct(now: float, was: float):
        if not was:
            return None
        return round((now - was) / was * 100)

    prev_cats = {c["category"]: c for c in previous.get("categories", [])}
    for c in current.get("categories", []):
        was = prev_cats.get(c["category"], {}).get("total", 0.0)
        c["prev_total"] = round(was, 2)
        c["delta_pct"] = pct(c["total"], was)
    current["prev"] = {
        "spent": previous.get("spent", 0.0), "count": previous.get("count", 0),
        "categories": {k: v["total"] for k, v in prev_cats.items()},
        "avg_check": previous.get("avg_check", 0.0),
        "daily_avg": previous.get("daily_avg", 0.0),
    }
    current["spent_delta_pct"] = pct(current.get("spent", 0.0), previous.get("spent", 0.0))
    current["count_delta_pct"] = pct(current.get("count", 0), previous.get("count", 0))
    current["avg_check_delta_pct"] = pct(current.get("avg_check", 0.0), previous.get("avg_check", 0.0))
    current["daily_avg_delta_pct"] = pct(current.get("daily_avg", 0.0), previous.get("daily_avg", 0.0))
    return current


def month_summary(items: list[dict], today=None) -> dict:
    """Для панели: потрачено с начала месяца против среднего полного месяца.
    Средний месяц — по шести ПОЛНЫМ месяцам до текущего: текущий неполный
    занизил бы «норму», и любой день читался бы как перерасход."""
    from datetime import date as _d
    import calendar
    today = today or _d.today()
    cur = today.strftime("%Y-%m")
    by_month: dict[str, float] = {}
    for i in items:
        if i["kind"] != "expense" or not i.get("date"):
            continue
        m = i["date"][:7]
        by_month[m] = round(by_month.get(m, 0.0) + i["amount"], 2)
    full = sorted(k for k in by_month if k < cur)[-6:]
    avg = round(sum(by_month[k] for k in full) / len(full), 2) if full else 0.0
    dim = calendar.monthrange(today.year, today.month)[1]
    return {
        "spent_mtd": by_month.get(cur, 0.0),
        "avg_month": avg,
        "full_months": len(full),
        "month_pct": round(by_month.get(cur, 0.0) / avg, 3) if avg else None,
        "day_of_month": today.day, "days_in_month": dim,
        "pace_pct": round(today.day / dim, 3),
    }
