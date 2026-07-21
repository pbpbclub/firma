from fastapi import APIRouter, Query, HTTPException
from typing import Optional
from db import get_zenmoney, get_analytics, get_production
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
def sync_zenmoney():
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
def get_accounts():
    conn = get_zenmoney()
    try:
        # type='cash' исключаем: отрицательный «кэш» — артефакт трекинга ZenMoney,
        # это не реальные деньги на счетах и ломает сумму остатков.
        rows = conn.execute(
            "SELECT id, title, type, balance FROM zm_accounts WHERE archive=0 AND type != 'cash' ORDER BY balance DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/balance-at-date")
def get_balance_at_date(date: str):
    """Остаток на дату D (включительно) = текущий баланс − движения ПОСЛЕ D (истории баланса нет)."""
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="date должна быть в формате YYYY-MM-DD")
    conn = get_zenmoney()
    try:
        # type='cash' исключаем (артефакт ZenMoney — см. /accounts).
        rows = conn.execute(
            "SELECT id, title, balance FROM zm_accounts WHERE archive=0 AND type != 'cash' ORDER BY balance DESC"
        ).fetchall()
        accounts = []
        for r in rows:
            # В zm_transactions income_account/outcome_account хранят НАЗВАНИЕ счёта (title), не id.
            inflow = conn.execute(
                "SELECT COALESCE(SUM(income),0) s FROM zm_transactions WHERE income_account=? AND date>? AND deleted=0",
                (r["title"], date),
            ).fetchone()["s"]
            outflow = conn.execute(
                "SELECT COALESCE(SUM(outcome),0) s FROM zm_transactions WHERE outcome_account=? AND date>? AND deleted=0",
                (r["title"], date),
            ).fetchone()["s"]
            accounts.append({
                "id": r["id"], "title": r["title"],
                "balance": round(r["balance"] - (inflow - outflow), 2),
            })
        total = round(sum(a["balance"] for a in accounts), 2)
        return {"accounts": accounts, "total": total, "date": date}
    except HTTPException:
        raise
    except Exception as e:
        return {"error": str(e), "accounts": [], "total": 0}
    finally:
        conn.close()


@router.get("/transactions")
def get_transactions(
    month: Optional[str] = None,
    account: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(200, le=1000),
):
    conn = get_zenmoney()
    try:
        sql = "SELECT * FROM zm_transactions WHERE deleted=0"
        params = []

        if month:
            y, m = int(month[:4]), int(month[5:7])
            m2, y2 = (m + 1, y) if m < 12 else (1, y + 1)
            sql += " AND date >= ? AND date < ?"
            params += [f"{month}-01", f"{y2}-{m2:02d}-01"]

        if account:
            sql += " AND (outcome_account LIKE ? OR income_account LIKE ?)"
            params += [f"%{account}%", f"%{account}%"]

        if search:
            sql += " AND (payee LIKE ? OR comment LIKE ? OR tags LIKE ?)"
            params += [f"%{search}%"] * 3

        sql += " ORDER BY date DESC LIMIT ?"
        params.append(limit)

        rows = conn.execute(sql, params).fetchall()
        rules = _load_payee_rules()
        result = []
        for r in rows:
            d = dict(r)
            d["tags"] = json.loads(d.get("tags") or "[]")
            resolved = _resolve_payee((d.get("payee") or "").strip(), rules, [])
            zen_cat = d["tags"][0] if d["tags"] else ""
            d["display_category"] = resolved.get("category") or _CATEGORY_RU.get(zen_cat) or (zen_cat or None)
            result.append(d)
        return result
    finally:
        conn.close()


@router.get("/report")
def get_report(month: Optional[str] = None):
    """Расходы по категориям за месяц."""
    conn = get_zenmoney()
    try:
        from datetime import datetime
        month = month or datetime.now().strftime("%Y-%m")
        y, m = int(month[:4]), int(month[5:7])
        m2, y2 = (m + 1, y) if m < 12 else (1, y + 1)
        date_from, date_to = f"{month}-01", f"{y2}-{m2:02d}-01"

        # Расходы по категориям
        expense_rows = conn.execute("""
            SELECT tags, SUM(outcome) as total, COUNT(*) as cnt
            FROM zm_transactions
            WHERE date >= ? AND date < ? AND deleted=0 AND outcome > 0 AND income=0
            GROUP BY tags ORDER BY total DESC
        """, (date_from, date_to)).fetchall()

        # Итоги
        totals = conn.execute("""
            SELECT
                SUM(CASE WHEN outcome > 0 AND income=0 THEN outcome ELSE 0 END) as expenses,
                SUM(CASE WHEN income > 0 AND outcome=0 THEN income ELSE 0 END) as incomes,
                SUM(CASE WHEN income > 0 AND outcome > 0 THEN outcome ELSE 0 END) as transfers
            FROM zm_transactions
            WHERE date >= ? AND date < ? AND deleted=0
        """, (date_from, date_to)).fetchone()

        categories = []
        for r in expense_rows:
            tags = json.loads(r["tags"] or "[]")
            raw = tags[0] if tags else ""
            categories.append({
                "category": _CATEGORY_RU.get(raw, raw) if raw else "Без категории",
                "total": round(r["total"], 2),
                "count": r["cnt"],
            })

        return {
            "month": month,
            "expenses": round(totals["expenses"] or 0, 2),
            "incomes": round(totals["incomes"] or 0, 2),
            "transfers": round(totals["transfers"] or 0, 2),
            "categories": categories,
        }
    finally:
        conn.close()


@router.get("/cashflow")
def get_cashflow(months: int = Query(6, le=24)):
    """ДДС по месяцам — для графика."""
    conn = get_zenmoney()
    try:
        rows = conn.execute("""
            SELECT
                strftime('%Y-%m', date) as month,
                SUM(CASE WHEN outcome > 0 AND income=0 THEN outcome ELSE 0 END) as expenses,
                SUM(CASE WHEN income > 0 AND outcome=0 THEN income ELSE 0 END) as incomes
            FROM zm_transactions
            WHERE deleted=0
            GROUP BY month
            ORDER BY month DESC
            LIMIT ?
        """, (months,)).fetchall()
        return list(reversed([dict(r) for r in rows]))
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
def get_business_transactions(months: int = Query(3, le=12)):
    """Транзакции с личных карт, связанные с бизнесом (подрядчики + ИП)."""
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

    conn = get_zenmoney()
    try:
        date_from = (datetime.now() - timedelta(days=30 * months)).strftime("%Y-%m-%d")
        rows = conn.execute(
            "SELECT * FROM zm_transactions WHERE deleted=0 AND date >= ? ORDER BY date DESC",
            (date_from,),
        ).fetchall()

        result = []
        for r in rows:
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
def suggest_for_creditor(name: str = "", amount: float = 0, limit: int = Query(10, le=50)):
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

    conn = get_zenmoney()
    try:
        rows = conn.execute(
            "SELECT * FROM zm_transactions WHERE deleted=0 AND outcome > 0 AND income = 0 ORDER BY date DESC LIMIT 500"
        ).fetchall()
        scored = []
        for r in rows:
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
