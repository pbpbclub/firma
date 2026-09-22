from fastapi import APIRouter, Query, HTTPException, Depends
from typing import Optional
from auth import get_current_user
from audit import audit
from pydantic import BaseModel
from db import get_zenmoney, get_analytics, get_production
from privacy import require_owner
from zm_scope import CURRENCY_SIGNS, scope_for
import json
import re
import subprocess
from datetime import datetime, timedelta

router = APIRouter()

_CATEGORY_RU: dict[str, str] = {
    "Entertainment":       "Развлечения",
    "Food & Drink":        "Еда",
    "Food and Drink":      "Еда",
    "Transport":           "Транспорт",
    "Shopping":            "Покупки",
    "Health & Fitness":    "Здоровье",
    "Health and Fitness":  "Здоровье",
    "Travel":              "Путешествия",
    "Home":                "Дом",
    "Education":           "Образование",
    "Personal Care":       "Личный уход",
    "Bills & Utilities":   "Коммунальные",
    "Bills and Utilities": "Коммунальные",
    "Clothing":            "Одежда",
    "Groceries":           "Продукты",
    "Auto & Transport":    "Авто/транспорт",
    "Business Services":   "Услуги",
    "Transfers":           "Переводы",
    "Income":              "Доходы",
    "Delivery":            "Доставка",
    "Taxi":                "Такси",
    "Restaurants":         "Рестораны",
    "Coffee Shops":        "Кофе",
    "Gas & Fuel":          "Топливо",
    "Parking":             "Парковка",
    "Gym":                 "Спортзал",
    "Pharmacy":            "Аптека",
    "Electronics":         "Электроника",
    "Supermarkets":        "Супермаркеты",
    "General":             "Разное",
    "Cash & ATM":          "Наличные",
    "Fees & Charges":      "Комиссии",
    "Insurance":           "Страхование",
    "Investments":         "Инвестиции",
    "Loans":               "Кредиты",
    "Salary":              "Зарплата",
    "Freelance":           "Фриланс",
}


@router.post("/sync")
def sync_zenmoney(user=Depends(require_owner)):
    """Принудительная синхронизация с ZenMoney API."""
    try:
        result = subprocess.run(
            ["python3", "/opt/fin-agent/tools/zenmoney.py", "sync"],
            capture_output=True, text=True, timeout=60
        )
        if result.returncode != 0:
            return {"ok": False, "error": result.stderr.strip() or "sync failed"}
        return {"ok": True, "output": result.stdout.strip()}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout (60s)"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/accounts")
def get_accounts(user=Depends(get_current_user)):
    """Счета, видимые пользователю, КАЖДЫЙ со своей валютой.

    Форма ответа прежняя (id/title/type/balance) плюс `currency` — фронт не ломается.
    type='cash' по-прежнему исключён: отрицательный «кэш» — артефакт трекинга
    ZenMoney. Приватные и ненастроенные счета в ответ не попадают."""
    return [a.as_dict() for a in scope_for(user).accounts()]


@router.get("/accounts-summary")
def get_accounts_summary(user=Depends(get_current_user)):
    """Итоги ПО ВАЛЮТАМ вместо одного числа: сложить лари с рублями нельзя.
    `pending_count` — счета без настроенной валюты (плашка владельцу)."""
    s = scope_for(user)
    return {"totals": s.totals(), "pending_count": s.pending_count() if s.is_owner else 0,
            "is_owner": s.is_owner}


class AccountMetaUpdate(BaseModel):
    currency: Optional[str] = None
    region: Optional[str] = None
    visibility: Optional[str] = None
    note: Optional[str] = None


@router.get("/account-meta")
def get_account_meta(user=Depends(require_owner)):
    """Реестр счетов: валюта, регион, видимость, «не настроено». Только владельцу —
    это карта личного контура, а не справочник."""
    s = scope_for(user)
    return {
        "accounts": [a.as_dict() for a in s.accounts(include_cash=True)],
        "currencies": list(CURRENCY_SIGNS.keys()),
        "pending_count": s.pending_count(),
    }


@router.patch("/account-meta/{account_id}")
def set_account_meta(account_id: str, body: AccountMetaUpdate, user=Depends(require_owner)):
    """Назначить счёту валюту / регион / видимость.

    Неоднозначное название («Universal Account» у трёх счетов BOG) валюту не
    оживит: линза всё равно держит такой счёт как pending, потому что в
    zm_transactions ноги хранятся НАЗВАНИЕМ. Сначала переименование в ZenMoney
    и полный пересинк, потом уже назначение."""
    fields = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="Нечего менять")
    if "currency" in fields and fields["currency"] not in CURRENCY_SIGNS and fields["currency"] != "unknown":
        raise HTTPException(status_code=400, detail=f"Валюта должна быть из списка: {', '.join(CURRENCY_SIGNS)}")
    if "visibility" in fields and fields["visibility"] not in ("public", "private", "pending"):
        raise HTTPException(status_code=400, detail="visibility: public | private | pending")

    zconn = get_zenmoney()
    try:
        acc = zconn.execute("SELECT id, title FROM zm_accounts WHERE id = ?", (account_id,)).fetchone()
    finally:
        zconn.close()
    if not acc:
        raise HTTPException(status_code=404, detail="Счёт не найден в ZenMoney")

    conn = get_production()
    try:
        before = conn.execute("SELECT * FROM zm_account_meta WHERE account_id = ?", (account_id,)).fetchone()
        if not before:
            conn.execute("INSERT INTO zm_account_meta (account_id, title) VALUES (?, ?)", (account_id, acc["title"]))
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE zm_account_meta SET {sets}, title = ?, updated_at = datetime('now') WHERE account_id = ?",
                     list(fields.values()) + [acc["title"], account_id])
        audit(conn, "zm_account", account_id, "update",
              f"Счёт «{acc['title']}»: {', '.join(f'{k}={v}' for k, v in fields.items())}", before_row=before)
        conn.commit()
        row = conn.execute("SELECT * FROM zm_account_meta WHERE account_id = ?", (account_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@router.get("/balance-at-date")
def get_balance_at_date(date: str, user=Depends(get_current_user)):
    """Остаток на дату D (включительно) = текущий баланс − движения ПОСЛЕ D (истории баланса нет)."""
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="date должна быть в формате YYYY-MM-DD")
    scope = scope_for(user)
    conn = get_zenmoney()
    try:
        # Счета берём из линзы: приватные и ненастроенные сюда не попадают,
        # а у каждого известна валюта (type='cash' линза отсекает сама).
        rows = [a for a in scope.accounts() if a.configured]
        accounts = []
        for r in rows:
            # В zm_transactions income_account/outcome_account хранят НАЗВАНИЕ счёта (title), не id.
            inflow = conn.execute(
                "SELECT COALESCE(SUM(income),0) s FROM zm_transactions WHERE income_account=? AND date>? AND deleted=0",
                (r.title, date),
            ).fetchone()["s"]
            outflow = conn.execute(
                "SELECT COALESCE(SUM(outcome),0) s FROM zm_transactions WHERE outcome_account=? AND date>? AND deleted=0",
                (r.title, date),
            ).fetchone()["s"]
            accounts.append({
                "id": r.id, "title": r.title, "currency": r.currency,
                "balance": round(r.balance - (inflow - outflow), 2),
            })
        # `total` остаётся, но считается ТОЛЬКО по рублям: экран остатка на дату
        # рублёвый, а складывать ₾ с ₽ нельзя. Полная раскладка — в `totals`.
        totals = {}
        for a in accounts:
            totals[a["currency"]] = round(totals.get(a["currency"], 0) + a["balance"], 2)
        return {"accounts": accounts, "total": totals.get("RUB", 0.0), "date": date,
                "totals": [{"currency": c, "total": t, "sign": CURRENCY_SIGNS.get(c, "")}
                           for c, t in sorted(totals.items())]}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"zenmoney.db недоступна: {e}")
    finally:
        conn.close()


@router.get("/transactions")
def get_transactions(
    month: Optional[str] = None,
    account: Optional[str] = None,
    search: Optional[str] = None,
    currency: Optional[str] = None,
    limit: int = Query(200, le=1000),
    user=Depends(get_current_user),
):
    """Лента личных транзакций.

    `currency` — валютный контур (по умолчанию рублёвый): строка попадает в ленту,
    если хотя бы одна её нога в этой валюте. Без фильтра лента смешивала бы
    рублёвые покупки с лари, а суммы внизу экрана считались бы по разным деньгам.
    """
    scope = scope_for(user)
    currency = (currency or "RUB").upper()
    conn = get_zenmoney()
    try:
        frag, fparams = scope.tx_sql()
        sql = "SELECT * FROM zm_transactions WHERE deleted=0" + frag
        params = list(fparams)

        if month:
            y, m = int(month[:4]), int(month[5:7])
            m2, y2 = (m + 1, y) if m < 12 else (1, y + 1)
            sql += " AND date >= ? AND date < ?"
            params += [f"{month}-01", f"{y2}-{m2:02d}-01"]

        if account:
            # Фильтр проверяем линзой: LIKE по чужому названию иначе работал бы
            # как «прощупать» приватный счёт по ответу (пусто/не пусто).
            if not scope.title_visible(account):
                return []
            sql += " AND (outcome_account LIKE ? OR income_account LIKE ?)"
            params += [f"%{account}%", f"%{account}%"]

        if search:
            sql += " AND (payee LIKE ? OR comment LIKE ? OR tags LIKE ?)"
            params += [f"%{search}%"] * 3

        # Лимит применяем ПОСЛЕ валютного отбора: иначе 200 строк выбирались бы
        # по всем контурам сразу и рублёвая лента редела бы на глазах.
        sql += " ORDER BY date DESC LIMIT ?"
        params.append(limit * 5)

        rows = conn.execute(sql, params).fetchall()
        rules = _load_payee_rules()
        result = []
        for r in rows:
            if not scope.row_in_currency(r, currency):
                continue
            d = dict(r)
            d["currency"] = currency
            d["outcome_currency"] = scope.row_currency(r, "outcome")
            d["income_currency"] = scope.row_currency(r, "income")
            d["tags"] = json.loads(d.get("tags") or "[]")
            resolved = _resolve_payee((d.get("payee") or "").strip(), rules, [])
            zen_cat = d["tags"][0] if d["tags"] else ""
            d["display_category"] = resolved.get("category") or _CATEGORY_RU.get(zen_cat) or (zen_cat or None)
            result.append(d)
            if len(result) >= limit:
                break
        return result
    finally:
        conn.close()


@router.get("/report")
def get_report(month: Optional[str] = None, currency: Optional[str] = None,
               user=Depends(get_current_user)):
    """Расходы по категориям за месяц — в ОДНОЙ валюте (по умолчанию рубли).

    Категории считаются по ноге расхода: «Еда» из лари и «Еда» из рублей — разные
    деньги, и складывать их в одну строку нельзя."""
    scope = scope_for(user)
    currency = (currency or "RUB").upper()
    conn = get_zenmoney()
    try:
        from datetime import datetime
        month = month or datetime.now().strftime("%Y-%m")
        y, m = int(month[:4]), int(month[5:7])
        m2, y2 = (m + 1, y) if m < 12 else (1, y + 1)
        date_from, date_to = f"{month}-01", f"{y2}-{m2:02d}-01"

        frag, fparams = scope.tx_sql()
        rows = conn.execute(
            "SELECT * FROM zm_transactions WHERE date >= ? AND date < ? AND deleted=0" + frag,
            [date_from, date_to] + list(fparams)).fetchall()

        by_cat: dict[str, dict] = {}
        expenses = incomes = transfers = 0.0
        for r in rows:
            out_cur, in_cur = scope.row_currency(r, "outcome"), scope.row_currency(r, "income")
            inc, out = r["income"] or 0, r["outcome"] or 0
            if inc > 0 and out > 0:
                if out_cur == currency:
                    transfers += out
                continue
            if out > 0 and out_cur == currency:
                expenses += out
                tags = json.loads(r["tags"] or "[]")
                raw = tags[0] if tags else ""
                name = _CATEGORY_RU.get(raw, raw) if raw else "Без категории"
                slot = by_cat.setdefault(name, {"category": name, "total": 0.0, "count": 0})
                slot["total"] += out
                slot["count"] += 1
            elif inc > 0 and in_cur == currency:
                incomes += inc

        categories = sorted(({**c, "total": round(c["total"], 2)} for c in by_cat.values()),
                            key=lambda c: -c["total"])
        return {
            "month": month,
            "currency": currency,
            "sign": CURRENCY_SIGNS.get(currency, ""),
            "expenses": round(expenses, 2),
            "incomes": round(incomes, 2),
            "transfers": round(transfers, 2),
            "categories": categories,
        }
    finally:
        conn.close()


@router.get("/cashflow")
def get_cashflow(months: int = Query(6, le=24), currency: Optional[str] = None,
                 user=Depends(get_current_user)):
    """ДДС по месяцам — для графика, в одной валюте (по умолчанию рубли)."""
    scope = scope_for(user)
    currency = (currency or "RUB").upper()
    conn = get_zenmoney()
    try:
        frag, fparams = scope.tx_sql()
        rows = conn.execute(
            "SELECT date, income, outcome, income_account, outcome_account"
            " FROM zm_transactions WHERE deleted=0" + frag, list(fparams)).fetchall()
        agg: dict[str, dict] = {}
        for r in rows:
            inc, out = r["income"] or 0, r["outcome"] or 0
            if inc > 0 and out > 0:
                continue
            month = (r["date"] or "")[:7]
            if not month:
                continue
            if out > 0 and scope.row_currency(r, "outcome") == currency:
                agg.setdefault(month, {"month": month, "expenses": 0.0, "incomes": 0.0})["expenses"] += out
            elif inc > 0 and scope.row_currency(r, "income") == currency:
                agg.setdefault(month, {"month": month, "expenses": 0.0, "incomes": 0.0})["incomes"] += inc
        out_rows = [{**v, "expenses": round(v["expenses"], 2), "incomes": round(v["incomes"], 2)}
                    for v in agg.values()]
        out_rows.sort(key=lambda v: v["month"])
        return out_rows[-months:]
    finally:
        conn.close()


_OWNER_TOKENS = {"некрасов", "некрасова", "юрий"}
_NAME_ALIASES: dict[str, list[str]] = {
    "саша": ["александр"], "александр": ["саша"],
    "миша": ["михаил"],    "михаил":    ["миша"],
    "юра":  ["юрий"],      "юрий":      ["юра"],
    "настя": ["анастасия"],"анастасия": ["настя"],
    "серёжа": ["сергей"],  "сергей":    ["серёжа"],
}
_EXPLICIT_INITIALS: dict[tuple[str, str], str] = {
    ("александр", "ш"): "Александр ЛДСП",
    ("александр", "м"): "Александр Нержавейщик (Мельник)",
    ("александр", "с"): "Самсонов Саша",
}

_CONTRACTOR_SKIP_TOKENS = {"ооо", "ип", "ао", "нкп", "зао", "пао"}

def contractor_tokens(name: str) -> list[str]:
    """Токены имени подрядчика для матчинга похожести (кириллица ≥3, без юр-форм)."""
    return [t.lower() for t in re.findall(r"[А-Яа-яЁё]{3,}", name or "")
            if t.lower() not in _CONTRACTOR_SKIP_TOKENS]


def _match_payee_zm(payee: str, contractors: list) -> str | None:
    """Матчинг по целым словам (не подстрокам), с алиасами и явными инициалами."""
    if not payee:
        return None
    pl = payee.lower()
    words = set(re.findall(r"[а-яёa-z]{2,}", pl))
    # пропустить транзакции владельца
    if words & _OWNER_TOKENS:
        return None
    initials = re.findall(r"[а-яё](?=\.)", pl)
    # явное разрешение однофамильцев
    for (name_tok, init), cname in _EXPLICIT_INITIALS.items():
        if name_tok in words and init in initials:
            return cname
    # расширить алиасами
    expanded = set(words)
    for w in words:
        expanded.update(_NAME_ALIASES.get(w, []))
    scores: list[tuple[int, str]] = []
    for c in contractors:
        score = 0
        matched_inits: set[str] = set()
        for tok in c["tokens"]:
            variants = {tok} | set(_NAME_ALIASES.get(tok, []))
            # полное совпадение слова (не подстрока)
            if variants & expanded:
                score += 2
            else:
                for init in initials:
                    if tok.startswith(init) and init not in matched_inits:
                        score += 1
                        matched_inits.add(init)
                        break
        if score >= 2:
            scores.append((score, c["name"]))
    if not scores:
        return None
    scores.sort(key=lambda x: -x[0])
    if len(scores) >= 2 and scores[0][0] == scores[1][0]:
        return None
    return scores[0][1]


def _load_payee_rules() -> list[dict]:
    """Загрузить все правила сопоставления из production.db."""
    try:
        conn = get_production()
        try:
            rows = conn.execute("SELECT * FROM payee_rules").fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
    except Exception:
        return []


def _resolve_payee(payee: str, rules: list[dict], contractors: list[dict]) -> dict:
    """
    Разрешить payee: сначала по явным правилам, потом алгоритмически.
    Возвращает dict с полями: display_name, matched_contractor, rule_id, matched_via.
    """
    if not payee:
        return {"display_name": None, "matched_contractor": None, "rule_id": None, "matched_via": None}

    pl = payee.lower()

    # Слой 1: явные правила (exact → prefix → contains)
    for mtype in ("exact", "prefix", "contains"):
        for rule in rules:
            if rule["match_type"] != mtype:
                continue
            pat = rule["pattern"]
            if mtype == "exact" and pl == pat:
                pass
            elif mtype == "prefix" and pl.startswith(pat):
                pass
            elif mtype == "contains" and pat in pl:
                pass
            else:
                continue
            # Правило найдено
            if rule["entity_type"] == "skip":
                return {"display_name": None, "matched_contractor": None, "rule_id": rule["id"], "matched_via": "rule", "skip": True}
            name = rule["display_name"] or rule["entity_name"] or payee
            return {
                "display_name": name,
                "matched_contractor": name,
                "rule_id": rule["id"],
                "matched_via": "rule",
                "entity_type": rule["entity_type"],
                "entity_id": rule["entity_id"],
                "entity_name": rule["entity_name"],
                "category": rule.get("category") or None,
            }

    # Слой 2: алгоритм
    algo = _match_payee_zm(payee, contractors)
    if algo:
        return {"display_name": algo, "matched_contractor": algo, "rule_id": None, "matched_via": "algorithm"}

    return {"display_name": None, "matched_contractor": None, "rule_id": None, "matched_via": None}


@router.get("/business")
def get_business_transactions(months: int = Query(3, le=12), user=Depends(get_current_user)):
    """Транзакции с личных карт, связанные с бизнесом (подрядчики + ИП).

    Только рублёвый публичный контур: траты в Грузии бизнесу не принадлежат
    и в разноску попадать не должны."""
    SKIP = {"ооо", "ип", "ао", "нкп", "зао", "пао"}

    rules = _load_payee_rules()

    contractors: list[dict] = []

    def _add(name: str):
        toks = [t.lower() for t in re.findall(r"[А-Яа-яЁё]{3,}", name)
                if t.lower() not in SKIP]
        if toks:
            contractors.append({"name": name, "tokens": toks})

    try:
        prod = get_production()
        try:
            for row in prod.execute("SELECT name FROM creditors").fetchall():
                _add(row["name"])
        finally:
            prod.close()
    except Exception:
        pass

    try:
        aconn = get_analytics()
        try:
            for row in aconn.execute(
                "SELECT name FROM contractors WHERE status != 'blocked'"
            ).fetchall():
                _add(row["name"])
        finally:
            aconn.close()
    except Exception:
        pass

    scope = scope_for(user)
    conn = get_zenmoney()
    try:
        date_from = (datetime.now() - timedelta(days=30 * months)).strftime("%Y-%m-%d")
        frag, fparams = scope.tx_sql()
        rows = conn.execute(
            "SELECT * FROM zm_transactions WHERE deleted=0 AND date >= ?" + frag + " ORDER BY date DESC",
            [date_from] + list(fparams),
        ).fetchall()

        result = []
        for r in rows:
            if not scope.row_in_currency(r, "RUB"):
                continue
            d = dict(r)
            if d.get("income", 0) > 0 and d.get("outcome", 0) > 0:
                continue  # skip transfers
            payee = (d.get("payee") or "").strip()
            resolved = _resolve_payee(payee, rules, contractors)

            if resolved.get("skip"):
                continue

            is_biz_income = any(
                kw in ((payee + " " + (d.get("comment") or "")).lower())
                for kw in ["некрасов", "pbpb", "пбпб"]
            )
            if resolved["matched_contractor"] or is_biz_income:
                d["tags"] = json.loads(d.get("tags") or "[]")
                d["matched_contractor"] = resolved["matched_contractor"]
                d["matched_via"] = resolved["matched_via"]
                d["rule_id"] = resolved["rule_id"]
                d["entity_type"] = resolved.get("entity_type")
                d["entity_id"] = resolved.get("entity_id")
                d["is_business_income"] = is_biz_income
                zen_cat = d["tags"][0] if d["tags"] else ""
                d["display_category"] = resolved.get("category") or _CATEGORY_RU.get(zen_cat) or (zen_cat or None)
                result.append(d)

        return result
    finally:
        conn.close()


@router.get("/suggest")
def suggest_for_creditor(name: str = "", amount: float = 0, limit: int = Query(10, le=50),
                         user=Depends(get_current_user)):
    """Suggest ZenMoney expense transactions for linking to a creditor."""
    def _name_score(a: str, b: str) -> float:
        if not a or not b:
            return 0.0
        a_words = set(a.lower().split())
        b_words = set(b.lower().split())
        union = a_words | b_words
        return len(a_words & b_words) / len(union) if union else 0.0

    def _amount_score(a: float, b: float) -> float:
        denom = max(a, b)
        return max(0.0, 1.0 - abs(a - b) / denom) if denom else 0.0

    scope = scope_for(user)
    conn = get_zenmoney()
    try:
        frag, fparams = scope.tx_sql()
        rows = conn.execute(
            "SELECT * FROM zm_transactions WHERE deleted=0 AND outcome > 0 AND income = 0" + frag
            + " ORDER BY date DESC LIMIT 500", list(fparams)
        ).fetchall()
        scored = []
        for r in rows:
            if not scope.row_in_currency(r, "RUB"):
                continue
            tx = dict(r)
            label = (tx.get("payee") or "") + " " + (tx.get("comment") or "")
            ns = _name_score(name, label)
            as_ = _amount_score(amount, tx.get("outcome") or 0)
            score = 0.6 * ns + 0.4 * as_
            tx["score"] = round(score, 3)
            tx["amount"] = tx.get("outcome") or 0
            tx["direction"] = "out"
            try:
                tx["tags"] = json.loads(tx.get("tags") or "[]")
            except Exception:
                tx["tags"] = []
            scored.append(tx)
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:limit]
    finally:
        conn.close()
