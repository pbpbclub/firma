"""Срез за месяц одной карточкой — то, что финагент присылает Юре в Telegram.

Ничего своего не считает там, где уже есть источник: заказы берутся из
orders.plan_fact_summary, накладные — из orders._overhead_month, долги — из
finance.get_debtors/get_creditors, сальдо подрядчиков — из ledger.balances.
Свои запросы только к деньгам месяца (payments/expenses по датам и обороты
банка) — их ни один существующий эндпоинт не отдаёт в разрезе месяца.
"""
from datetime import date

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

import cards
from db import get_finance, get_production

router = APIRouter()

MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль",
             "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]
# Общие траты вне заказов: purpose расхода → как называть в карточке.
GENERAL_PURPOSES = {"overhead": "Накладные расходы", "stock": "Закупка в запас",
                    "sample": "Образцы и пробы",
                    "contractor_pay": "Авансы подрядчикам",
                    "contractor_third_party": "Оплачено за подрядчиков"}
CAT_LABELS = {"material": "Материалы", "work": "Работы",
              "delivery": "Доставка", "other": "Прочее"}


def _month_label(month: str) -> str:
    y, m = month.split("-")
    return f"{MONTHS_RU[int(m) - 1]} {y}"


def _bank_of_month(month: str) -> dict:
    """Пришло/ушло по банку за месяц — теми же правилами, что футер ДДС.

    Переводы между своими счетами оборотом не считаются: авто-детект по
    назначению плюс помеченные вручную. Иначе месяц раздувается на каждый
    перевод себе."""
    from routers.finance import OWN_TRANSFER_SQL, _transfer_tx_ids

    transfers = _transfer_tx_ids()
    where = f" AND NOT {OWN_TRANSFER_SQL}"
    params: list = [month]
    if transfers:
        where += f" AND CAST(id AS TEXT) NOT IN ({','.join('?' * len(transfers))})"
        params += list(transfers)
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

    general_rows = [{"label": GENERAL_PURPOSES.get(k, "Прочее вне заказов"), "value": v}
                    for k, v in sorted(money["general"].items(), key=lambda kv: -kv[1]) if v]
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
