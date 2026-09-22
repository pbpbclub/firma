"""Раздел «Заграница»: операции и аналитика трат по картам региона (22.09.2026).

Весь роутер под `require_owner`: счета региона приватные, это личные финансы
владельца. Код региона не хардкодим — страница `/region/:code` параметризована,
Турция добавится строкой в реестре счетов (`zm_account_meta.region`).
"""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import abroad
from audit import audit
from db import get_production
from privacy import require_owner
from zm_scope import scope_for

router = APIRouter()

REGION_TITLES = {"ge": "Грузия", "tr": "Турция"}


def _months_ago(months: int) -> str:
    """Начало окна в N месяцев ВКЛЮЧАЯ текущий: «6 мес» — шесть столбиков,
    а не семь (первый месяц иначе показывался огрызком и портил сравнение)."""
    today = date.today()
    m, y = today.month - (months - 1), today.year
    while m <= 0:
        m, y = m + 12, y - 1
    return f"{y}-{m:02d}-01"


@router.get("")
def list_regions(user=Depends(require_owner)):
    """Регионы — из реестра счетов, а не из захардкоженного списка."""
    scope = scope_for(user)
    out: dict[str, dict] = {}
    for a in scope.accounts(include_cash=True):
        if not a.region:
            continue
        slot = out.setdefault(a.region, {"code": a.region, "title": REGION_TITLES.get(a.region, a.region),
                                         "accounts": 0, "balances": [], "ambiguous": 0})
        slot["accounts"] += 1
        slot["ambiguous"] += 1 if a.ambiguous else 0
        if a.configured:
            slot["balances"].append({"currency": a.currency, "total": a.balance})
    return list(out.values())


@router.get("/{code}/transactions")
def region_transactions(
    code: str,
    months: int = Query(6, le=36),
    date_from: str | None = None,
    date_to: str | None = None,
    search: str | None = None,
    category: str | None = None,
    payee: str | None = None,
    kind: str | None = Query(None, pattern="^(expense|income|transfer)$"),
    amount_min: float | None = None,
    amount_max: float | None = None,
    limit: int = Query(300, le=2000),
    user=Depends(require_owner),
):
    """Лента операций по картам региона.

    `capped` — выборка упёрлась в потолок SQL (`abroad.ROW_CAP`): `total_found`
    тогда считает не весь период, а его хвост. `truncated` — про страницу
    (`limit`), это разные вещи и на экране пишутся по-разному."""
    scope = scope_for(user)
    rows = abroad.fetch_rows(scope, code, date_from=date_from or _months_ago(months),
                             date_to=date_to, search=search, limit=abroad.ROW_CAP)
    capped = abroad.capped(rows)
    items = abroad.decorate(rows, scope, abroad.load_rules(), abroad.region_titles(scope, code))
    if category:
        # Категория есть только у трат: приход и конвертация не «прочее»,
        # у них категории нет вовсе — иначе фильтр «Прочее» собирал бы переводы.
        items = [i for i in items if i["kind"] == "expense" and i["category"] == category]
    if payee:
        items = [i for i in items if payee.lower() in (i["payee"] or "").lower()]
    if kind:
        items = [i for i in items if i["kind"] == kind]
    if amount_min is not None:
        items = [i for i in items if i["amount"] >= amount_min]
    if amount_max is not None:
        items = [i for i in items if i["amount"] <= amount_max]
    truncated = len(items) > limit
    return {"items": items[:limit], "truncated": truncated, "total_found": len(items),
            "capped": capped, "row_cap": abroad.ROW_CAP,
            "titles": abroad.region_titles(scope, code)}


@router.get("/{code}/spending")
def region_spending(code: str, months: int = Query(6, le=36), currency: str | None = None,
                    user=Depends(require_owner)):
    """Аналитика: месяц к месяцу, категории, топ получателей, регулярные списания.

    `currency` — по какой валюте считать (`unknown` — строки без разделённой
    валюты). Не передан и валют несколько → берётся самая крупная, признак
    `currency_auto`: складывать лари с долларами в один итог нельзя."""
    scope = scope_for(user)
    rows = abroad.fetch_rows(scope, code, date_from=_months_ago(months), limit=abroad.ROW_CAP)
    items = abroad.decorate(rows, scope, abroad.load_rules(), abroad.region_titles(scope, code))
    res = abroad.spending(items, currency=currency)
    res["months_requested"] = months
    # Упёрлись в потолок выборки — сводка посчитана по хвосту периода, а не по
    # всему окну: экран обязан это сказать, иначе цифры читаются как полные.
    res["capped"] = abroad.capped(rows)
    res["row_cap"] = abroad.ROW_CAP
    res["ambiguous_accounts"] = sum(1 for a in scope.accounts(include_cash=True)
                                    if a.region == code and a.ambiguous)
    return res


@router.get("/{code}/categories")
def region_categories(code: str, months: int = Query(6, le=36), user=Depends(require_owner)):
    """Справочник + сколько операций в каждой категории за период (чтобы видеть,
    насколько «Прочее» велико и что пора разметить)."""
    scope = scope_for(user)
    rows = abroad.fetch_rows(scope, code, date_from=_months_ago(months), limit=abroad.ROW_CAP)
    items = abroad.decorate(rows, scope, abroad.load_rules(), abroad.region_titles(scope, code))
    used: dict[str, int] = {}
    for i in items:
        if i["kind"] == "expense":
            used[i["category"] or abroad.FALLBACK] = used.get(i["category"] or abroad.FALLBACK, 0) + 1
    return [{**c, "count": used.get(c["code"], 0)} for c in abroad.categories()]


@router.get("/{code}/rules")
def region_rules(code: str, user=Depends(require_owner)):
    """⚠ Справочник правил ОБЩИЙ на все регионы: в `abroad_payee_rules` региона
    нет, `code` в пути — только адрес страницы. Значит, правило, заведённое или
    снятое на странице Турции, перекрашивает и историю Грузии. Пока регион один,
    это не мешает; разделять — только решением Юры (миграция + судьба уже
    заведённых правил: общие или грузинские)."""
    return abroad.load_rules()


class RuleCreate(BaseModel):
    payee: str | None = None        # получатель из ленты — паттерн выводится из него
    pattern: str | None = None      # либо паттерн целиком
    match_type: str = "contains"
    category: str
    note: str | None = None


@router.post("/{code}/rules")
def create_rule(code: str, body: RuleCreate, user=Depends(require_owner)):
    """Назначить категорию получателю — прямо из ленты, одним действием.

    Правило перекрывает все операции этого получателя, включая прошлые: категория
    не хранится в строке, а выводится на чтении. Поэтому «разметил один раз» и есть
    вся разметка — перебирать 1898 операций руками не нужно."""
    pattern = (body.pattern or body.payee or "").strip().lower()
    if not pattern:
        raise HTTPException(status_code=400, detail="Нужен получатель или паттерн")
    if body.match_type not in ("exact", "prefix", "contains"):
        raise HTTPException(status_code=400, detail="match_type: exact | prefix | contains")
    conn = get_production()
    try:
        if not conn.execute("SELECT 1 FROM abroad_categories WHERE code = ? AND active = 1",
                            (body.category,)).fetchone():
            raise HTTPException(status_code=400, detail=f"Нет такой категории: {body.category}")
        row = conn.execute("SELECT * FROM abroad_payee_rules WHERE pattern = ? AND match_type = ?",
                           (pattern, body.match_type)).fetchone()
        if row:
            conn.execute("UPDATE abroad_payee_rules SET category = ?, note = COALESCE(?, note),"
                         " updated_at = datetime('now') WHERE id = ?",
                         (body.category, body.note, row["id"]))
            audit(conn, "abroad_rule", row["id"], "update",
                  f"«{pattern}» → {body.category}", before_row=row)
            rule_id = row["id"]
        else:
            cur = conn.execute(
                "INSERT INTO abroad_payee_rules (pattern, match_type, category, note)"
                " VALUES (?, ?, ?, ?)", (pattern, body.match_type, body.category, body.note))
            rule_id = cur.lastrowid
            audit(conn, "abroad_rule", rule_id, "create", f"«{pattern}» → {body.category}")
        conn.commit()
        return {"id": rule_id, "pattern": pattern, "match_type": body.match_type,
                "category": body.category}
    finally:
        conn.close()


@router.delete("/{code}/rules/{rule_id}")
def delete_rule(code: str, rule_id: int, user=Depends(require_owner)):
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM abroad_payee_rules WHERE id = ?", (rule_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Правило не найдено")
        conn.execute("DELETE FROM abroad_payee_rules WHERE id = ?", (rule_id,))
        audit(conn, "abroad_rule", rule_id, "delete", f"«{row['pattern']}» снято", before_row=row)
        conn.commit()
        return {"deleted": rule_id}
    finally:
        conn.close()
