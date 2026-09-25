"""Срез за месяц одной карточкой — то, что финагент присылает Юре в Telegram.

Ничего своего не считает там, где уже есть источник: заказы берутся из
orders.plan_fact_summary, накладные — из orders._overhead_month, долги — из
finance.get_debtors/get_creditors, сальдо подрядчиков — из ledger.balances.
Свои запросы только к деньгам месяца (payments/expenses по датам и обороты
банка) — их ни один существующий эндпоинт не отдаёт в разрезе месяца.
"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse

import cards
from auth import get_current_user
from db import get_finance, get_production

router = APIRouter()

MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль",
             "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]
# Общие траты вне заказов: purpose расхода → как называть в карточке.
GENERAL_PURPOSES = {"overhead": "Накладные расходы", "stock": "Закупка в запас",
                    "sample": "Образцы и пробы",
                    "contractor_pay": "Выплаты подрядчикам",
                    "contractor_advance": "Авансы подрядчикам",
                    "contractor_third_party": "Оплачено за подрядчиков"}
CAT_LABELS = {"material": "Материалы", "work": "Работы",
              "delivery": "Доставка", "other": "Прочее"}


def _month_label(month: str) -> str:
    y, m = month.split("-")
    return f"{MONTHS_RU[int(m) - 1]} {y}"


def _not_transfer() -> tuple[str, list]:
    """Фильтр «не перевод между своими счетами» — те же правила, что футер ДДС:
    авто-детект по назначению плюс помеченные вручную."""
    from routers.finance import OWN_TRANSFER_SQL, _transfer_tx_ids

    transfers = _transfer_tx_ids()
    where = f" AND NOT {OWN_TRANSFER_SQL}"
    params: list = []
    if transfers:
        where += f" AND CAST(id AS TEXT) NOT IN ({','.join('?' * len(transfers))})"
        params = list(transfers)
    return where, params


def _bank_of_month(month: str) -> dict:
    """Пришло/ушло по банку за месяц — теми же правилами, что футер ДДС.

    Переводы между своими счетами оборотом не считаются: авто-детект по
    назначению плюс помеченные вручную. Иначе месяц раздувается на каждый
    перевод себе."""
    where, tparams = _not_transfer()
    params: list = [month] + tparams
    conn = get_finance()
    try:
        r = conn.execute(
            f"""SELECT COALESCE(SUM(CASE WHEN direction='in'  THEN amount END), 0) income,
                       COALESCE(SUM(CASE WHEN direction='out' THEN amount END), 0) expense
                  FROM transactions
                 WHERE strftime('%Y-%m', date) = ?{where}""", params).fetchone()
        return {"income": round(r["income"] or 0, 2), "expense": round(r["expense"] or 0, 2)}
    except Exception:
        # finance.db читается по сети агента и бывает недоступна — карточка
        # обязана собраться и без банковской шапки.
        return {"income": 0, "expense": 0, "unavailable": True}
    finally:
        conn.close()


def _money_of_month(conn, month: str) -> dict:
    """Деньги месяца по production.db: приход от заказчиков и траты.

    Расходы делим на «по заказам» и «общие»: в себестоимость заказов вторые не
    входят по построению (order_id IS NULL) и складывать их в одну сумму значило бы
    выдать накладные за себестоимость."""
    paid = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE strftime('%Y-%m', paid_at) = ?",
        (month,)).fetchone()["s"]
    on_orders = conn.execute(
        """SELECT COALESCE(SUM(amount), 0) s FROM expenses
            WHERE order_id IS NOT NULL AND strftime('%Y-%m', expense_date) = ?""",
        (month,)).fetchone()["s"]
    by_cat = [{"label": CAT_LABELS.get(r["category"], r["category"] or "Прочее"),
               "value": round(r["s"] or 0, 2)}
              for r in conn.execute(
        """SELECT category, SUM(amount) s FROM expenses
            WHERE order_id IS NOT NULL AND strftime('%Y-%m', expense_date) = ?
            GROUP BY category ORDER BY s DESC""", (month,)).fetchall()]
    general = {r["purpose"] or "other": round(r["s"] or 0, 2) for r in conn.execute(
        """SELECT purpose, SUM(amount) s FROM expenses
            WHERE order_id IS NULL AND strftime('%Y-%m', expense_date) = ?
            GROUP BY purpose""", (month,)).fetchall()}
    return {"paid": round(paid or 0, 2), "on_orders": round(on_orders or 0, 2),
            "by_cat": by_cat, "general": general}


@router.post("/month-card")
def month_card(month: str = Query(None, description="YYYY-MM, по умолчанию текущий")):
    """Карточка «Срез за месяц» одним PDF."""
    from routers import finance, ledger, orders

    month = month or date.today().strftime("%Y-%m")
    try:
        _month_label(month)
    except (ValueError, IndexError):
        raise HTTPException(status_code=400, detail="month должен быть в формате YYYY-MM")

    conn = get_production()
    try:
        money = _money_of_month(conn, month)
        # Накладные — за ЗАПРОШЕННЫЙ месяц.
        overhead = orders._overhead_month(conn, month)
    finally:
        conn.close()
    # Раскладка накладных по заказам существует только для текущего месяца:
    # _overhead_allocation берёт заказы, что в производстве СЕГОДНЯ, — для
    # прошлого месяца она была бы выдумкой.
    is_current = month == date.today().strftime("%Y-%m")
    overhead_orders = sorted(orders.overhead_summary()["orders"],
                             key=lambda o: -(o.get("amount") or 0)) if is_current else []

    active = orders.plan_fact_summary(scope="active")["orders"]
    active.sort(key=lambda o: -(o["price_plan"] or 0))
    in_prod = [o for o in active if o["status"] == "in_production"]
    pipeline = [o for o in active if o["status"] != "in_production"]
    bank = _bank_of_month(month)
    debtors = finance.get_debtors()
    creditors = finance.get_creditors()
    bal = ledger.balances()

    # Личные выводы владельца — не трата дела, а изъятие прибыли: в «потрачено»
    # не входят, но и не прячутся — отдельная строка карточки (ТЗ 03.09.2026).
    owner_draw = round(money["general"].get("owner_draw", 0), 2)
    general_rows = [{"label": GENERAL_PURPOSES.get(k, "Прочее вне заказов"), "value": v}
                    for k, v in sorted(money["general"].items(), key=lambda kv: -kv[1])
                    if v and k != "owner_draw"]
    spent = round(money["on_orders"] + sum(r["value"] for r in general_rows), 2)

    path = cards.render(
        "month.html.j2",
        stem=f"month-{month}",
        today=date.today().strftime("%d.%m.%Y"),
        month_label=_month_label(month),
        bank=bank, bank_delta=round(bank["income"] - bank["expense"], 2),
        paid=money["paid"],
        on_orders=money["on_orders"],
        by_cat=money["by_cat"],
        general_rows=general_rows,
        owner_draw=owner_draw,
        spent=spent,
        left=round(money["paid"] - spent, 2),
        overhead=overhead,
        overhead_orders=overhead_orders,
        # Производство и просчёты — РАЗНЫЕ списки. В одном ведре прогноз черновиков
        # (1,56 млн по августу) поглощал реальные 350 тыс. производства, а итоговая
        # карточка сводила выручку производства с чистой по всем заказам сразу.
        orders=in_prod,
        pipeline=pipeline[:8],
        pipeline_more=max(0, len(pipeline) - 8),
        pipeline_revenue=round(sum(o["price_plan"] or 0 for o in pipeline), 2),
        pipeline_net=round(sum(o["net_forecast"] or 0 for o in pipeline), 2),
        net_forecast=round(sum(o["net_forecast"] or 0 for o in in_prod), 2),
        prod_revenue=round(sum(o["price_plan"] or 0 for o in in_prod), 2),
        prod_paid=round(sum(o["paid_total"] or 0 for o in in_prod), 2),
        prod_cost_fact=round(sum(o["cost_fact"] or 0 for o in in_prod), 2),
        debtors_total=debtors["total"],
        potential=debtors.get("potential_total") or 0,
        creditors_debt=creditors["total_debt"],
        creditors_plan=creditors["plan_total"],
        we_owe=bal["we_owe"],
        they_owe=bal["they_owe"],
    )
    return FileResponse(path, media_type="application/pdf",
                        filename=f"Срез — {_month_label(month)}.pdf")


# ── Неделя на главной: те же блоки и сравнения, что в недельном отчёте фин-агента
# (`/opt/fin-agent/tools/weekly_report.py --news`), но числами Фирмы. ─────────────

ACTIVITY_ORDER = ("production", "transit", "design")


def _week_window(today: date) -> tuple[date, date]:
    """Неделя отчёта — понедельник..сегодня, как у фин-агента."""
    return today - timedelta(days=today.weekday()), today


def _income_week(conn, date_from: str, date_to: str) -> dict:
    """«Пришло» отчёта (`weekly_report.income_block_and_total`): платежи заказчиков
    по дате (р/с, наличные, личная карта) плюс приход из выписки, которому не нашлось
    платежа той же суммы (±1 ₽) — деньги пришли, но по заказу не разнесены.
    Переводы между своими счетами выписки — не приход (правило ДДС)."""
    paid = [float(r["amount"] or 0) for r in conn.execute(
        "SELECT amount FROM payments WHERE date(paid_at) BETWEEN ? AND ?",
        (date_from, date_to)).fetchall()]
    by_orders = round(sum(paid), 2)
    where, tparams = _not_transfer()
    try:
        fconn = get_finance()
        try:
            bank = [float(r["amount"] or 0) for r in fconn.execute(
                f"""SELECT amount FROM transactions
                     WHERE direction = 'in' AND date BETWEEN ? AND ?{where}""",
                [date_from, date_to] + tparams).fetchall()]
        finally:
            fconn.close()
    except Exception:
        return {"total": by_orders, "orders": by_orders, "unallocated": 0.0, "bank_unavailable": True}
    loose = round(sum(b for b in bank if not any(abs(b - a) < 1 for a in paid)), 2)
    return {"total": round(by_orders + loose, 2), "orders": by_orders, "unallocated": loose}


def _spent_projects(conn, date_from: str, date_to: str) -> float:
    """Расходы Фирмы по дате траты, кроме личных выводов владельца
    (owner_draw — изъятие прибыли, не трата дела)."""
    return round(conn.execute(
        """SELECT COALESCE(SUM(amount), 0) s FROM expenses
            WHERE expense_date >= ? AND expense_date <= ?
              AND COALESCE(purpose, '') != 'owner_draw'""",
        (date_from, date_to)).fetchone()["s"] or 0, 2)


def _card_payouts(conn, date_from: str, date_to: str) -> float:
    """Выплаты мастерам с личных карт, которых в расходах нет (`weekly_report.
    personal_cards_flow`, корзина `masters`): проводка лицевого счёта, привязка
    фин-агента `zm_links` или получатель по `payee_rules` (entity_type=master).
    Перевод, уже стоящий расходом (`expenses.zenmoney_tx_id`), второй раз не идёт.
    Только рублёвая нога: иностранные карты — не здесь."""
    from db import get_zenmoney
    from zm_scope import scope_for
    in_expenses = {r[0] for r in conn.execute(
        "SELECT zenmoney_tx_id FROM expenses WHERE zenmoney_tx_id IS NOT NULL")}
    in_ledger = {r[0] for r in conn.execute(
        "SELECT zenmoney_tx_id FROM master_ledger WHERE zenmoney_tx_id IS NOT NULL")}
    rules = [((r["pattern"] or "").lower(), r["match_type"] or "exact") for r in conn.execute(
        "SELECT pattern, match_type FROM payee_rules WHERE entity_type = 'master' AND pattern IS NOT NULL")]
    try:
        zconn = get_zenmoney()
        try:
            rows = zconn.execute(
                """SELECT id, outcome, income, payee, outcome_account, income_account
                     FROM zm_transactions
                    WHERE deleted = 0 AND outcome > 0 AND date BETWEEN ? AND ?""",
                (date_from, date_to)).fetchall()
            try:
                links = {r[0] for r in zconn.execute("SELECT zm_tx_id FROM zm_links")}
            except Exception:
                links = set()
        finally:
            zconn.close()
    except Exception:
        return 0.0
    scope = scope_for(None, owner=True)
    total = 0.0
    for r in rows:
        if (r["income"] or 0) > 0 and r["income_account"] != r["outcome_account"]:
            continue                                   # перевод между своими счетами
        if r["id"] in in_expenses or scope.row_currency(r, "outcome") != "RUB":
            continue
        payee = (r["payee"] or "").lower()
        by_rule = any((kind == "contains" and pat in payee) or pat == payee for pat, kind in rules)
        if r["id"] in in_ledger or r["id"] in links or by_rule:
            total += float(r["outcome"] or 0)
    return round(total, 2)


TBILISI_FILE = "/opt/fin-agent/data/zm_tbilisi.json"


def _tbilisi_patterns() -> list[str] | None:
    """Список фин-агента «куда Юра выводит себе» (получатель/комментарий, подстрока
    без регистра). Способы вывода знает и ведёт фин-агент (решение Юры 25.09.2026:
    «финагент знает, как я вывожу») — своего справочника не заводим."""
    import json
    try:
        with open(TBILISI_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return [p.strip().lower() for p in data.get("payees", []) if p and p.strip()]


def _to_tbilisi_by_day() -> tuple[dict[str, float] | None, str]:
    """«Себе в Тбилиси» по дням, в рублях — корзина `tbilisi` из
    `weekly_report.personal_cards_flow`: рублёвая нога ушла с недолгового счёта,
    это не перевод между своими счетами ZenMoney, получатель или комментарий
    совпадает со списком фин-агента.

    🔒 Раздел «Грузия» считает вывод по МАРШРУТАМ (`abroad_routes`) — это другой
    вопрос («что пришло на карту страны»), и его здесь не трогаем. Прямой перевод
    на BOG с 08.2026 лежит в ZenMoney двумя строками (рубли «IURII N.» и лари
    «shps niu pheiment sistem»), маршрут рублёвую ногу не узнаёт, список — узнаёт.
    Нет списка — фолбэк на маршруты, источник отдаётся в ответе."""
    import abroad_routes
    from db import get_zenmoney
    from zm_scope import scope_for
    patterns = _tbilisi_patterns()
    try:
        conn = get_zenmoney()
    except Exception:
        return None, "unavailable"
    try:
        rows = conn.execute("SELECT * FROM zm_transactions WHERE deleted = 0 AND outcome > 0").fetchall()
        debt = {r[0] for r in conn.execute("SELECT title FROM zm_accounts WHERE type = 'debt'")}
    except Exception:
        return None, "unavailable"
    finally:
        conn.close()
    scope = scope_for(None, owner=True)
    out: dict[str, float] = {}
    if patterns is None:
        for i in abroad_routes.outflows(rows, scope):
            d = str(i["date"])[:10]
            out[d] = out.get(d, 0) + i["amount_rub"]
        return out, "routes"
    for r in rows:
        if (r["income"] or 0) > 0 and r["income_account"] != r["outcome_account"]:
            continue                                   # перевод между своими счетами
        if r["outcome_account"] in debt or scope.row_currency(r, "outcome") != "RUB":
            continue
        text = f"{r['payee'] or ''} | {r['comment'] or ''}".lower()
        if any(p in text for p in patterns):
            d = str(r["date"] or "")[:10]
            out[d] = out.get(d, 0) + float(r["outcome"] or 0)
    return out, "fin_agent"


def _weekly_income(weeks: int, monday: date) -> list[dict]:
    """Приход на р/с по неделям пн–вс, последние `weeks` недель (текущая — неполная)."""
    where, tparams = _not_transfer()
    start = monday - timedelta(weeks=weeks - 1)
    buckets = [{"week_start": (start + timedelta(weeks=i)).isoformat(), "income": 0.0}
               for i in range(weeks)]
    try:
        conn = get_finance()
    except Exception:
        return buckets
    try:
        rows = conn.execute(
            f"""SELECT substr(date, 1, 10) d, SUM(amount) s FROM transactions
                 WHERE direction = 'in' AND date >= ?{where} GROUP BY d""",
            [start.isoformat()] + tparams).fetchall()
    except Exception:
        return buckets
    finally:
        conn.close()
    for r in rows:
        try:
            idx = (date.fromisoformat(r["d"]) - start).days // 7
        except ValueError:
            continue
        if 0 <= idx < weeks:
            buckets[idx]["income"] = round(buckets[idx]["income"] + (r["s"] or 0), 2)
    return buckets


def _quarter_income(year: int) -> list[dict]:
    """Доход по р/с по кварталам года — та же база, что `taxes.tax_summary`
    (все поступления `direction='in'`, как считает УСН)."""
    out = [{"quarter": q, "income": 0.0} for q in (1, 2, 3, 4)]
    try:
        conn = get_finance()
    except Exception:
        return out
    try:
        rows = conn.execute(
            """SELECT (CAST(strftime('%m', date) AS INTEGER) + 2) / 3 q, SUM(amount) s
                 FROM transactions
                WHERE strftime('%Y', date) = ? AND direction = 'in' AND amount > 0
                GROUP BY q""", (str(year),)).fetchall()
    except Exception:
        return out
    finally:
        conn.close()
    for r in rows:
        if r["q"] and 1 <= r["q"] <= 4:
            out[r["q"] - 1]["income"] = round(r["s"] or 0, 2)
    return out


def _week_orders(conn, date_from: str, date_to: str) -> list[dict]:
    """Заказы недели для «Направлений» и «План / факт» — выборка отчёта
    (`weekly_report.plan_fact_rows`): в производстве плюс завершённые на этой неделе.

    Цифры — `orders._plan_fact`, своей арифметики нет. `net`: у закрытого —
    факт (выручка − себестоимость − УСН), у живого — план. У проектных затрат
    нет по решению Юры 11.09.2026: прибыль = выручка − УСН."""
    from routers import orders
    rows = conn.execute(
        """SELECT o.id, o.title, o.status, o.price_plan, o.cost_plan,
                  COALESCE(o.activity, 'production') activity,
                  (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.order_id = o.id) paid_total
             FROM orders o
            WHERE COALESCE(o.archived, 0) = 0
              AND (o.status = 'in_production'
                   OR (o.status = 'completed' AND substr(o.updated_at, 1, 10) BETWEEN ? AND ?))""",
        (date_from, date_to)).fetchall()
    extras = orders._extras_totals(conn)
    out = []
    for r in rows:
        pf = orders._plan_fact(conn, r["id"], r["cost_plan"] or 0, r["paid_total"] or 0,
                               r["price_plan"] or 0, extras=extras)
        done = r["status"] == "completed"
        revenue = float(pf.get("revenue") or r["price_plan"] or 0)
        plan, fact = float(pf.get("cost_plan") or 0), float(pf.get("cost_fact") or 0)
        tax = float(pf.get("tax") or 0)
        net_plan = float(pf.get("net_plan") or 0)
        if r["activity"] == "design":
            plan = fact = 0.0
            net_plan = revenue - tax
        out.append({
            "id": r["id"], "title": r["title"], "activity": r["activity"], "done": done,
            "revenue": round(revenue, 2), "plan": round(plan, 2), "fact": round(fact, 2),
            "tax": round(tax, 2),
            "net": round((revenue - fact - tax) if done else net_plan, 2),
        })
    out.sort(key=lambda o: (o["done"], -o["revenue"]))
    return out


@router.get("/week")
def week_summary():
    """Неделя для главной — блоки недельного отчёта фин-агента:
    деньги недели (с прошлой неделей той же длины), приход по 12 неделям,
    направления с маржой, план/факт себестоимости, доход по кварталам."""
    from zoneinfo import ZoneInfo
    from datetime import datetime

    today = datetime.now(ZoneInfo("Asia/Tbilisi")).date()
    monday, end = _week_window(today)
    prev_from, prev_to = monday - timedelta(weeks=1), end - timedelta(weeks=1)

    conn = get_production()
    try:
        def money_of(a: date, b: date) -> dict:
            lo, hi = a.isoformat(), b.isoformat()
            inc = _income_week(conn, lo, hi)
            exp = _spent_projects(conn, lo, hi)
            cards = _card_payouts(conn, lo, hi)
            return {"income": inc["total"], "income_orders": inc["orders"],
                    "income_unallocated": inc["unallocated"],
                    "spent_projects": round(exp + cards, 2), "spent_cards": cards}
        cur, prev = money_of(monday, end), money_of(prev_from, prev_to)
        week_orders = _week_orders(conn, monday.isoformat(), end.isoformat())
        act_names = {r["code"]: r["name"] for r in conn.execute("SELECT code, name FROM activities")}
    finally:
        conn.close()

    abroad_days, abroad_source = _to_tbilisi_by_day()

    def abroad_sum(a: date, b: date):
        if abroad_days is None:
            return None
        return round(sum(v for d, v in abroad_days.items() if a.isoformat() <= d <= b.isoformat()), 2)

    directions: dict[str, dict] = {}
    for o in week_orders:
        d = directions.setdefault(o["activity"], {
            "code": o["activity"], "title": act_names.get(o["activity"], o["activity"]),
            "revenue": 0.0, "net": 0.0, "tax": 0.0, "orders": 0, "closed": 0})
        d["revenue"] += o["revenue"]
        d["net"] += o["net"]
        d["tax"] += o["tax"]
        d["orders"] += 1
        d["closed"] += int(o["done"])
    dir_list = sorted(directions.values(),
                      key=lambda d: (ACTIVITY_ORDER.index(d["code"]) if d["code"] in ACTIVITY_ORDER else 99))
    for d in dir_list:
        for k in ("revenue", "net", "tax"):
            d[k] = round(d[k], 2)
        d["margin"] = round(d["net"] / d["revenue"], 4) if d["revenue"] > 0 else None

    return {
        "week": {"from": monday.isoformat(), "to": end.isoformat()},
        "prev": {"from": prev_from.isoformat(), "to": prev_to.isoformat()},
        "money": cur | {
            "abroad": abroad_sum(monday, end),
            "balance": round(cur["income"] - cur["spent_projects"], 2),
            "prev": prev | {"abroad": abroad_sum(prev_from, prev_to)},
            "abroad_source": abroad_source,
        },
        "weeks": _weekly_income(12, monday),
        "directions": dir_list,
        "plan_fact": [{k: o[k] for k in ("id", "title", "activity", "done", "plan", "fact")}
                      | {"over": round(max(0.0, o["fact"] - o["plan"]), 2)}
                      for o in week_orders
                      if o["activity"] != "design" and (o["plan"] or o["fact"])],
        "quarters": {"year": today.year, "current": (today.month - 1) // 3 + 1,
                     "items": _quarter_income(today.year)},
    }


# ── Деньги по месяцам: ИП и личные счета одним контуром (решение Юры 25.09.2026) ──

ZM_IGNORE_FILE = "/opt/fin-agent/data/zm_ignore.json"


def _zm_ignore() -> tuple[set[str], set[str]]:
    """Список фин-агента «не бизнес» (`zm_ignore.json`): личные переводы, подарки,
    трейдинг, чужие деньги через карту Юры. Строка — по `tx` (одна операция) либо по
    получателю целиком. Разметку ведёт фин-агент (Юра 25.09.2026: «финагент знает»),
    своего справочника не заводим. Нет файла — пустой список."""
    import json
    try:
        with open(ZM_IGNORE_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return set(), set()
    txs, payees = set(), set()
    for e in data.get("payees", []):
        if e.get("tx"):
            txs.add(str(e["tx"]))
        elif e.get("payee"):
            payees.add(e["payee"].strip().lower())
    return txs, payees


def _self_patterns(conn) -> list[tuple[str, str]]:
    """Признак «перевод себе» — `payee_rules.entity_type='self'` (единственный)."""
    return [((r["pattern"] or "").lower(), r["match_type"] or "exact") for r in conn.execute(
        "SELECT pattern, match_type FROM payee_rules WHERE entity_type = 'self' AND pattern IS NOT NULL")]


@router.get("/money-months")
def money_months(months: int = Query(7, ge=1, le=24), user=Depends(get_current_user)):
    """Поступило / потрачено по месяцам — р/с ИП и личные счета вместе, без Грузии,
    тот же контур, что «Свободные деньги» на главной.

    Между контурами деньги ходят сами к себе, и в сумме это не оборот:
    - р/с ИП: переводы между своими (правило ДДС — `_not_transfer`) не считаются
      ни приходом, ни расходом;
    - личные: двуногие строки (перевод/обмен), чужие деньги (`third_party`),
      получатель «себе» (`payee_rules` self), вывод в Тбилиси (список фин-агента,
      как «Себе в Тбилиси») и вывод по маршрутам (`abroad_routes`, как `/cashflow`)
      не считаются;
    - строки из списка фин-агента «не бизнес» (`zm_ignore.json`: подарки, личные
      переводы, трейдинг, чужие деньги) — ни приходом, ни тратой;
    - приход на личный счёт, которому нашёлся перевод «себе» с р/с ИП той же суммы
      в пределах трёх дней, — второй конец того же перевода («Прочие поступления»
      Сбера без получателя), не доход.
    Валюта — только рублёвые ноги: заграничные счета нерублёвые."""
    import abroad_routes
    import third_party
    from db import get_zenmoney
    from routers.finance import OWN_TRANSFER_SQL
    from zm_scope import scope_for

    today = date.today()
    first = date(today.year, today.month, 1)
    y, m = first.year, first.month - (months - 1)
    while m <= 0:
        m += 12; y -= 1
    start = date(y, m, 1).isoformat()
    keys = []
    for i in range(months):
        mm = m + i; yy = y + (mm - 1) // 12; mm = (mm - 1) % 12 + 1
        keys.append(f"{yy}-{mm:02d}")
    agg = {k: {"month": k, "ip_income": 0.0, "ip_expense": 0.0, "cards_income": 0.0, "cards_expense": 0.0}
           for k in keys}

    # р/с ИП — правила ДДС; отдельно переводы себе, чтобы погасить их второй конец
    where, tparams = _not_transfer()
    own_out: list[tuple[date, float]] = []
    bank_ok = True
    try:
        fconn = get_finance()
        try:
            for r in fconn.execute(
                    f"""SELECT substr(date, 1, 7) m, direction, SUM(amount) s FROM transactions
                         WHERE date >= ?{where} GROUP BY m, direction""", [start] + tparams):
                if r["m"] in agg:
                    agg[r["m"]]["ip_income" if r["direction"] == "in" else "ip_expense"] += r["s"] or 0
            for r in fconn.execute(
                    f"""SELECT substr(date, 1, 10) d, amount FROM transactions
                         WHERE direction = 'out' AND date >= date(?, '-5 days') AND {OWN_TRANSFER_SQL}""", [start]):
                try:
                    own_out.append((date.fromisoformat(r["d"]), float(r["amount"] or 0)))
                except ValueError:
                    pass
        finally:
            fconn.close()
    except Exception:
        bank_ok = False

    conn = get_production()
    try:
        selfp = _self_patterns(conn)
    finally:
        conn.close()
    tbilisi = _tbilisi_patterns() or []
    ign_tx, ign_payee = _zm_ignore()
    ignored = 0.0
    scope = scope_for(user)
    service = scope_for(None, owner=True)
    cards_ok = True
    matched = 0
    try:
        zconn = get_zenmoney()
        try:
            frag, fparams = scope.tx_sql()
            rows = zconn.execute(
                "SELECT id, date, income, outcome, income_account, outcome_account, payee, comment"
                " FROM zm_transactions WHERE deleted = 0 AND date >= ?" + frag, [start] + list(fparams)).fetchall()
        finally:
            zconn.close()
    except Exception:
        rows, cards_ok = [], False
    marks = third_party.load_marks()
    used = [False] * len(own_out)
    for r in sorted(rows, key=lambda r: r["date"] or ""):
        k = (r["date"] or "")[:7]
        if k not in agg:
            continue
        if (r["income"] or 0) > 0 and (r["outcome"] or 0) > 0:
            continue                                   # перевод/обмен между счетами
        inc, out = third_party.own_legs(r, marks)
        if not inc and not out:
            continue
        payee = (r["payee"] or "").lower()
        text = f"{payee} | {(r['comment'] or '').lower()}"
        if str(r["id"]) in ign_tx or payee.strip() in ign_payee:
            if k == keys[-1]:
                ignored += (inc or 0) + (out or 0)
            continue                                   # не бизнес — по разметке фин-агента
        if any((mt == "exact" and payee == p) or (mt == "prefix" and payee.startswith(p))
               or (mt == "contains" and p in payee) for p, mt in selfp) or "некрасов юрий" in payee:
            continue                                   # себе
        if out > 0 and scope.row_currency(r, "outcome") == "RUB":
            if any(p in text for p in tbilisi) or abroad_routes.route_of(r, service):
                continue                               # вывод за границу — не трата
            agg[k]["cards_expense"] += out
        elif inc > 0 and scope.row_currency(r, "income") == "RUB":
            try:
                d = date.fromisoformat(str(r["date"])[:10])
            except ValueError:
                d = None
            hit = next((i for i, (od, oa) in enumerate(own_out)
                        if not used[i] and d and abs(oa - inc) < 1 and 0 <= (d - od).days <= 3), None)
            if hit is not None:
                used[hit] = True; matched += 1
                continue                               # второй конец перевода с р/с ИП
            agg[k]["cards_income"] += inc

    out_rows = []
    for k in keys:
        a = agg[k]
        a = {kk: (round(v, 2) if isinstance(v, float) else v) for kk, v in a.items()}
        a["income"] = round(a["ip_income"] + a["cards_income"], 2)
        a["expense"] = round(a["ip_expense"] + a["cards_expense"], 2)
        out_rows.append(a)
    return {"months": out_rows, "bank_ok": bank_ok, "cards_ok": cards_ok, "matched_ip_transfers": matched,
            "ignored_current": round(ignored, 2)}
