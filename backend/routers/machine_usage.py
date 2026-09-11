"""Машинное время агентов — учёт сессий (токены, часы, деньги) по заказам.

Направление «Проектные работы» (чертежи и модели с Профи.ру, бренд pbpb, с 09.09.2026)
устроено не как производство: материалов и мастеров нет, себестоимость — сессии
конструктора (агент Claude на маке Юры), позже — других людей, агентов и площадок.

Правила (решения Юры 09.09 и 11.09.2026):
- **деньги считает токен**: тариф модели (model_prices, $ за 1M по четырём видам) ×
  курс (app_settings.usd_rate) — снимок на момент записи, правка справочника прошлое
  не пересчитывает; неизвестная модель — 400, а не «примерно как соседняя»
  (расход fable-5-1 впятеро дороже sonnet, тихое занижение хуже отсутствия);
- **часы — вторая координата**, ставки часа нет: показатель «токены на час» копится,
  ставку Юра выставит потом отдельным решением;
- **единая таблица Фирмы, приём через API** от любого источника (мак, фин-агент,
  другие площадки); выгрузки мака в /opt/fin-agent/data/uploads Фирме не читаются;
- себестоимость заказа — обычный расход (expenses) через orders._insert_expense:
  _plan_fact и лицевые счета про машинное время не знают, expense_id — связь;
- часы Юры пока не вносятся — только сессии агентов.

Заказ строки: явный order → папка проекта (order_project_dirs, ТЗ Mac 11.09.2026) →
без заказа (order_id NULL, видно на странице «Без заказа», назначается PATCH).
Дедуп — ext_key (ключ строки мака `mac-<дата>-<папка>-<модель>` либо sha1 содержимого):
повторная выгрузка того же дня расход не задваивает.
"""
import hashlib
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from audit import audit
from db import get_production
from routers.orders import _insert_expense, ExpenseIn, _margin, _transit_facts, _discounts, _extras_totals

router = APIRouter()

SUPPLIER = "Конструктор (сессии Claude)"
AGENT_LABELS = {"constructor": "Конструктор", "fin": "Фин-агент", "yos": "YOS", "firma": "Фирма",
                "mac": "Менеджер Mac", "blender": "Конструктор"}
AGENT_GEN = {"constructor": "конструктора", "blender": "конструктора", "fin": "фин-агента", "yos": "YOS",
             "firma": "Фирмы", "mac": "менеджера Mac"}


class UsageIn(BaseModel):
    order: Optional[str] = None          # ORD-054 | uuid
    project_dir: Optional[str] = None    # папка конструктора — фолбэк, если order не дан
    date: Optional[str] = None           # YYYY-MM-DD, по умолчанию сегодня
    agent: str = "constructor"
    platform: Optional[str] = None       # mac | server | profi | …
    model: Optional[str] = None          # без модели — только время (токены 0, денег 0)
    sessions: int = 0
    hours: float = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cache_write: int = 0
    cache_read: int = 0
    key: Optional[str] = None            # ключ идемпотентности от источника
    note: Optional[str] = None
    expense_id: Optional[str] = None     # расход уже заведён (перенос старых записей) — новый не создавать
    no_expense: bool = False             # записать только учёт, без расхода по заказу
    source: Optional[str] = None         # mac | fin | manual | …
    # Синонимы из формата мака/фин-агента: {"in":…, "out":…}
    model_config = {"populate_by_name": True, "extra": "allow"}


class ImportIn(BaseModel):
    entries: list[UsageIn]
    source: Optional[str] = "mac"


class UsagePatch(BaseModel):
    order_id: Optional[str] = None
    hours: Optional[float] = None
    note: Optional[str] = None
    agent: Optional[str] = None


class ModelPriceIn(BaseModel):
    model: str
    price_in: float
    price_out: float
    price_cache_write: float
    price_cache_read: float
    note: Optional[str] = None


class SettingsIn(BaseModel):
    usd_rate: float


# ── расчёт ───────────────────────────────────────────────────────────────────

def _price(conn, model: str) -> dict:
    r = conn.execute("SELECT * FROM model_prices WHERE model = ?", (model,)).fetchone()
    if not r:
        known = [x["model"] for x in conn.execute("SELECT model FROM model_prices ORDER BY model")]
        raise HTTPException(status_code=400, detail={
            "error": "unknown_model", "model": model, "known": known,
            "message": f"Нет тарифа для модели «{model}» — добавь в PUT /machine-usage/models, "
                       f"по похожей не считаем"})
    return dict(r)


def _usd(price: dict, tin: int, tout: int, cw: int, cr: int) -> float:
    return round(tin / 1e6 * price["price_in"] + tout / 1e6 * price["price_out"]
                 + cw / 1e6 * price["price_cache_write"] + cr / 1e6 * price["price_cache_read"], 4)


def _usd_rate(conn) -> float:
    r = conn.execute("SELECT value FROM app_settings WHERE key = 'usd_rate'").fetchone()
    return float(r["value"]) if r and r["value"] else 100.0


def _ext_key(u: UsageIn, order_ref: str) -> str:
    if u.key:
        return str(u.key)
    raw = "|".join(str(x) for x in (order_ref, u.date, u.model, u.sessions, u.tokens_in, u.tokens_out,
                                    u.cache_write, u.cache_read, u.project_dir, u.agent))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _normalize(u: UsageIn) -> UsageIn:
    """Формат мака/фин-агента зовёт токены in/out — принимаем оба написания."""
    extra = u.model_extra or {}
    if not u.tokens_in and extra.get("in"):
        u.tokens_in = int(extra["in"])
    if not u.tokens_out and extra.get("out"):
        u.tokens_out = int(extra["out"])
    if not u.project_dir and (u.note or "").startswith("папка "):
        u.project_dir = u.note[len("папка "):].strip()
    return u


def _resolve_order(conn, u: UsageIn) -> Optional[str]:
    if u.order:
        r = conn.execute("SELECT id FROM orders WHERE id = ? OR number = ?", (u.order, u.order.upper())).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail=f"Заказ {u.order} не найден")
        return r["id"]
    if u.project_dir:
        r = conn.execute("SELECT order_id FROM order_project_dirs WHERE dir = ?", (u.project_dir,)).fetchone()
        if r:
            return r["order_id"]
    return None


def _expense_title(u: UsageIn, usd: float) -> str:
    parts = [f"Сессии {AGENT_GEN.get(u.agent, u.agent)}: {u.model or 'без модели'}"]
    if u.sessions:
        parts.append(f"{u.sessions} сес.")
    if u.hours:
        parts.append(f"{u.hours:g} ч")
    parts.append(f"${usd:.2f}")
    return ", ".join(parts)


def _record(conn, u: UsageIn, source: str) -> dict:
    """Одна строка учёта (+ расход по заказу). Без commit — import собирает пачку."""
    u = _normalize(u)
    order_id = _resolve_order(conn, u)
    key = _ext_key(u, u.order or u.project_dir or "")
    seen = conn.execute("SELECT id, order_id, expense_id FROM machine_usage WHERE ext_key = ?", (key,)).fetchone()
    if seen:
        return {"status": "exists", "id": seen["id"], "order_id": seen["order_id"],
                "expense_id": seen["expense_id"], "key": key}
    price = _price(conn, u.model) if u.model else None
    usd = _usd(price, u.tokens_in, u.tokens_out, u.cache_write, u.cache_read) if price else 0.0
    rate = _usd_rate(conn)
    amount = round(usd * rate, 2)
    date = u.date or conn.execute("SELECT date('now')").fetchone()[0]
    expense_id = u.expense_id
    if expense_id:
        e = conn.execute("SELECT id, order_id, amount FROM expenses WHERE id = ?", (expense_id,)).fetchone()
        if not e:
            raise HTTPException(status_code=404, detail=f"expense_id {expense_id} не найден")
        order_id = order_id or e["order_id"]
        # Расход уже есть (перенос записей фин-агента): рубли — его, курс — производный,
        # иначе страница и себестоимость заказа показали бы две разные суммы.
        if (e["amount"] or 0) > 0:
            amount = round(e["amount"], 2)
            rate = round(amount / usd, 4) if usd else rate
    elif order_id and amount > 0 and not u.no_expense:
        expense_id = _insert_expense(conn, order_id, ExpenseIn(
            title=_expense_title(u, usd), amount=amount, category="work", supplier=SUPPLIER,
            expense_date=date, settled_by="cash"), matched_by="machine-usage")
    uid = str(uuid4())
    conn.execute("""INSERT INTO machine_usage
        (id, order_id, work_date, agent, platform, model, sessions, hours, tokens_in, tokens_out,
         cache_write, cache_read, usd, fx_rate, amount, expense_id, project_dir, ext_key, source, note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (uid, order_id, date, u.agent, u.platform, u.model, u.sessions or 0, u.hours or 0,
         u.tokens_in or 0, u.tokens_out or 0, u.cache_write or 0, u.cache_read or 0,
         usd, rate, amount, expense_id, u.project_dir, key, u.source or source, u.note))
    audit(conn, "machine_usage", uid, "create",
          f"Сессии {u.agent}: {u.hours:g} ч, {(u.tokens_in + u.tokens_out + u.cache_write + u.cache_read) / 1e6:.2f} млн токенов, "
          f"${usd:.2f} = {amount:g} ₽" + ("" if order_id else " (без заказа)"))
    return {"status": "recorded" if order_id else "unassigned", "id": uid, "order_id": order_id,
            "expense_id": expense_id, "usd": usd, "amount": amount, "fx_rate": rate, "key": key,
            "unassigned": order_id is None}


# ── запись ───────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def create_usage(body: UsageIn):
    conn = get_production()
    try:
        res = _record(conn, body, body.source or "manual")
        conn.commit()
        return res
    finally:
        conn.close()


@router.post("/import")
def import_usage(body: ImportIn):
    """Пачка в формате суточной выгрузки мака. Каждая строка отвечает за себя:
    ошибка тарифа одной не роняет остальные — они записываются, а строка с ошибкой
    возвращается со status=error."""
    conn = get_production()
    out = []
    try:
        for e in body.entries:
            try:
                out.append(_record(conn, e, body.source or "mac"))
            except HTTPException as ex:
                out.append({"status": "error", "key": e.key, "detail": ex.detail})
        conn.commit()
        return {"results": out,
                "recorded": sum(1 for r in out if r["status"] == "recorded"),
                "unassigned": sum(1 for r in out if r["status"] == "unassigned"),
                "exists": sum(1 for r in out if r["status"] == "exists"),
                "errors": sum(1 for r in out if r["status"] == "error")}
    finally:
        conn.close()


@router.patch("/{usage_id}")
def patch_usage(usage_id: str, body: UsagePatch):
    """Назначить заказ строке без заказа (тогда заводится и расход), поправить часы/заметку."""
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM machine_usage WHERE id = ?", (usage_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        fields, params = [], []
        if body.order_id is not None:
            o = conn.execute("SELECT id FROM orders WHERE id = ? OR number = ?", (body.order_id, body.order_id.upper())).fetchone()
            if not o:
                raise HTTPException(status_code=404, detail="Заказ не найден")
            if row["order_id"] and row["order_id"] != o["id"] and row["expense_id"]:
                # расход живёт у прежнего заказа — переносим и его
                conn.execute("UPDATE expenses SET order_id = ? WHERE id = ?", (o["id"], row["expense_id"]))
            fields.append("order_id = ?"); params.append(o["id"])
            if not row["expense_id"] and (row["amount"] or 0) > 0:
                u = UsageIn(agent=row["agent"], model=row["model"], sessions=row["sessions"], hours=row["hours"])
                eid = _insert_expense(conn, o["id"], ExpenseIn(
                    title=_expense_title(u, row["usd"] or 0), amount=row["amount"], category="work",
                    supplier=SUPPLIER, expense_date=row["work_date"], settled_by="cash"), matched_by="machine-usage")
                fields.append("expense_id = ?"); params.append(eid)
        for k in ("hours", "note", "agent"):
            v = getattr(body, k)
            if v is not None:
                fields.append(f"{k} = ?"); params.append(v)
        if fields:
            params.append(usage_id)
            conn.execute(f"UPDATE machine_usage SET {', '.join(fields)} WHERE id = ?", params)
            audit(conn, "machine_usage", usage_id, "update", "Правка строки машинного времени", before_row=row)
            conn.commit()
        return dict(conn.execute("SELECT * FROM machine_usage WHERE id = ?", (usage_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/{usage_id}")
def delete_usage(usage_id: str):
    """Удалить строку вместе с её расходом. Расход, уже покрывший обязательство, —
    409: сначала снять привязку (то же правило, что у DELETE /creditors)."""
    from obligations import coverage
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM machine_usage WHERE id = ?", (usage_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        if row["expense_id"]:
            e = conn.execute("SELECT * FROM expenses WHERE id = ?", (row["expense_id"],)).fetchone()
            if e:
                cov = coverage(conn, [e["order_id"]]) if e["order_id"] else {}
                if e["creditor_id"] or any(
                        s.get("expense_id") == e["id"] for c in cov.values() for s in c.get("sources", [])):
                    raise HTTPException(status_code=409, detail={
                        "error": "expense_covers_obligation", "expense_id": e["id"],
                        "message": "Расход уже закрывает обязательство сметы — сначала сними привязку"})
                audit(conn, "expense", e["id"], "delete", "Удалён вместе со строкой машинного времени", before_row=e)
                conn.execute("DELETE FROM expenses WHERE id = ?", (e["id"],))
        audit(conn, "machine_usage", usage_id, "delete", "Строка машинного времени удалена", before_row=row)
        conn.execute("DELETE FROM machine_usage WHERE id = ?", (usage_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── чтение ───────────────────────────────────────────────────────────────────

_ROW_SQL = """SELECT u.*, o.number AS order_number, o.title AS order_title, o.status AS order_status
                FROM machine_usage u LEFT JOIN orders o ON o.id = u.order_id"""


def _tokens(r: dict) -> int:
    return (r.get("tokens_in") or 0) + (r.get("tokens_out") or 0) + (r.get("cache_write") or 0) + (r.get("cache_read") or 0)


@router.get("")
def list_usage(order_id: Optional[str] = None, month: Optional[str] = None,
               agent: Optional[str] = None, unassigned: bool = False,
               date_from: Optional[str] = None, date_to: Optional[str] = None):
    conn = get_production()
    try:
        sql, params = _ROW_SQL + " WHERE 1=1", []
        if order_id:
            sql += " AND (u.order_id = ? OR o.number = ?)"; params += [order_id, order_id.upper()]
        if month:
            sql += " AND substr(u.work_date, 1, 7) = ?"; params.append(month)
        if date_from:
            sql += " AND u.work_date >= ?"; params.append(date_from)
        if date_to:
            sql += " AND u.work_date <= ?"; params.append(date_to)
        if agent:
            sql += " AND u.agent = ?"; params.append(agent)
        if unassigned:
            sql += " AND u.order_id IS NULL"
        sql += " ORDER BY u.work_date DESC, u.created_at DESC"
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
        for r in rows:
            r["tokens_total"] = _tokens(r)
            r["agent_label"] = AGENT_LABELS.get(r["agent"], r["agent"])
        return {"items": rows, "count": len(rows)}
    finally:
        conn.close()


@router.get("/summary")
def summary(date_from: Optional[str] = None, date_to: Optional[str] = None,
            activity: Optional[str] = "design"):
    """Сводка направления по заказам: цена (выручка из _margin), оплачено, машинные
    затраты, оплачено исполнителю (расходы work/other без строки machine_usage),
    часы, токены — и показатели: ₽/час, ₽/1 млн токенов, доля себестоимости,
    токены/час. В выборку идут заказы activity=design ЛИБО с записями машинного
    времени в периоде (производственный заказ с сессиями тоже виден).
    Период фильтрует записи machine_usage по work_date; цена и оплаты заказа —
    целиком, они периоду не принадлежат."""
    conn = get_production()
    try:
        where, params = "", []
        if date_from:
            where += " AND u.work_date >= ?"; params.append(date_from)
        if date_to:
            where += " AND u.work_date <= ?"; params.append(date_to)
        usage = [dict(r) for r in conn.execute(_ROW_SQL + " WHERE 1=1" + where, params).fetchall()]
        by_order: dict = {}
        unassigned = []
        for r in usage:
            r["tokens_total"] = _tokens(r)
            r["agent_label"] = AGENT_LABELS.get(r["agent"], r["agent"])
            (by_order.setdefault(r["order_id"], []) if r["order_id"] else unassigned).append(r)
        order_ids = set(by_order)
        if activity:
            order_ids |= {r["id"] for r in conn.execute(
                "SELECT id FROM orders WHERE activity = ? AND COALESCE(archived, 0) = 0", (activity,)).fetchall()}
        if not order_ids:
            orders = []
        else:
            holes = ",".join("?" * len(order_ids))
            orders = [dict(r) for r in conn.execute(f"""
                SELECT o.id, o.number, o.title, o.status, o.activity, o.price_plan, o.cost_plan, o.created_at,
                       o.deadline, c.name AS customer_name, c.id AS customer_id,
                       COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id), 0) AS paid_total
                  FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
                 WHERE o.id IN ({holes}) ORDER BY o.created_at DESC""", list(order_ids)).fetchall()]
        tfacts, discounts, extras = _transit_facts(conn), _discounts(conn), _extras_totals(conn)
        machine_exp = {r["expense_id"] for r in conn.execute(
            "SELECT expense_id FROM machine_usage WHERE expense_id IS NOT NULL").fetchall()}
        items = []
        for o in orders:
            m = _margin(conn, o["id"], o["price_plan"], o["cost_plan"],
                        transit_facts=tfacts, discounts=discounts, extras=extras)
            rows = by_order.get(o["id"], [])
            hours = round(sum(r["hours"] or 0 for r in rows), 2)
            tokens = sum(r["tokens_total"] for r in rows)
            machine = round(sum(r["amount"] or 0 for r in rows), 2)
            # Исполнителю — живые расходы заказа на работу, кроме машинных строк
            executor = round(sum((e["amount"] or 0) for e in conn.execute(
                """SELECT id, amount FROM expenses WHERE order_id = ? AND category IN ('work', 'other')
                   AND COALESCE(purpose, '') NOT IN ('owner_draw', 'overhead')""", (o["id"],)).fetchall()
                if e["id"] not in machine_exp), 2)
            revenue = m["revenue"] or 0
            cost_total = round(machine + executor, 2)
            items.append({
                **o, "revenue": revenue, "cost_fact": m.get("cost_fact"),
                "machine_cost": machine, "executor_paid": executor, "cost_total": cost_total,
                "hours": hours, "sessions": sum(r["sessions"] or 0 for r in rows), "tokens_total": tokens,
                "tokens_by_kind": {k: sum(r[k] or 0 for r in rows) for k in ("tokens_in", "tokens_out", "cache_write", "cache_read")},
                "usd": round(sum(r["usd"] or 0 for r in rows), 2),
                "rub_per_hour": round(revenue / hours, 2) if hours else None,
                "rub_per_mtok": round(revenue / (tokens / 1e6), 2) if tokens else None,
                "cost_share": round(cost_total / revenue * 100, 1) if revenue else None,
                "tok_per_hour": round(tokens / hours) if hours else None,
                "usage": rows,
            })

        def tot(key):
            return round(sum(i[key] or 0 for i in items), 2)
        hours_t, tokens_t, rev_t = tot("hours"), tot("tokens_total"), tot("revenue")
        cost_t = tot("cost_total")
        by_agent: dict = {}
        for r in usage:
            a = by_agent.setdefault(r["agent"], {"agent": r["agent"], "label": r["agent_label"], "hours": 0.0,
                                                 "tokens_total": 0, "amount": 0.0, "sessions": 0, "rows": 0})
            a["hours"] = round(a["hours"] + (r["hours"] or 0), 2); a["tokens_total"] += r["tokens_total"]
            a["amount"] = round(a["amount"] + (r["amount"] or 0), 2); a["sessions"] += r["sessions"] or 0; a["rows"] += 1
        return {
            "items": items,
            "totals": {
                "orders": len(items), "revenue": rev_t, "paid_total": tot("paid_total"),
                "machine_cost": tot("machine_cost"), "executor_paid": tot("executor_paid"), "cost_total": cost_t,
                "hours": hours_t, "sessions": tot("sessions"), "tokens_total": tokens_t, "usd": tot("usd"),
                "rub_per_hour": round(rev_t / hours_t, 2) if hours_t else None,
                "rub_per_mtok": round(rev_t / (tokens_t / 1e6), 2) if tokens_t else None,
                "cost_share": round(cost_t / rev_t * 100, 1) if rev_t else None,
                "tok_per_hour": round(tokens_t / hours_t) if hours_t else None,
            },
            "by_agent": sorted(by_agent.values(), key=lambda a: -a["amount"]),
            "unassigned": {"items": unassigned, "hours": round(sum(r["hours"] or 0 for r in unassigned), 2),
                           "tokens_total": sum(r["tokens_total"] for r in unassigned),
                           "amount": round(sum(r["amount"] or 0 for r in unassigned), 2)},
            "usd_rate": _usd_rate(conn),
        }
    finally:
        conn.close()


# ── справочники ──────────────────────────────────────────────────────────────

@router.get("/models")
def list_models():
    conn = get_production()
    try:
        return {"items": [dict(r) for r in conn.execute("SELECT * FROM model_prices ORDER BY model")],
                "usd_rate": _usd_rate(conn)}
    finally:
        conn.close()


@router.put("/models")
def put_model(body: ModelPriceIn):
    if any(v < 0 for v in (body.price_in, body.price_out, body.price_cache_write, body.price_cache_read)):
        raise HTTPException(status_code=400, detail="цены не могут быть отрицательными")
    conn = get_production()
    try:
        conn.execute("""INSERT INTO model_prices (model, price_in, price_out, price_cache_write, price_cache_read, note, updated_at)
                        VALUES (?,?,?,?,?,?, datetime('now'))
                        ON CONFLICT(model) DO UPDATE SET price_in=excluded.price_in, price_out=excluded.price_out,
                          price_cache_write=excluded.price_cache_write, price_cache_read=excluded.price_cache_read,
                          note=excluded.note, updated_at=datetime('now')""",
                     (body.model.strip(), body.price_in, body.price_out, body.price_cache_write, body.price_cache_read, body.note))
        audit(conn, "model_prices", body.model.strip(), "update",
              f"Тариф {body.model}: {body.price_in}/{body.price_out}/{body.price_cache_write}/{body.price_cache_read} $ за 1M")
        conn.commit()
        return dict(conn.execute("SELECT * FROM model_prices WHERE model = ?", (body.model.strip(),)).fetchone())
    finally:
        conn.close()


@router.delete("/models/{model}")
def delete_model(model: str):
    conn = get_production()
    try:
        used = conn.execute("SELECT COUNT(*) FROM machine_usage WHERE model = ?", (model,)).fetchone()[0]
        if used:
            raise HTTPException(status_code=409, detail=f"По модели {model} есть {used} записей — тариф не удаляется")
        conn.execute("DELETE FROM model_prices WHERE model = ?", (model,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.get("/settings")
def get_settings():
    conn = get_production()
    try:
        return {"usd_rate": _usd_rate(conn)}
    finally:
        conn.close()


@router.put("/settings")
def put_settings(body: SettingsIn):
    """Курс ₽/$ для новых записей. Прошлые не пересчитываются — у каждой свой снимок."""
    if body.usd_rate <= 0:
        raise HTTPException(status_code=400, detail="usd_rate must be > 0")
    conn = get_production()
    try:
        conn.execute("""INSERT INTO app_settings (key, value, updated_at) VALUES ('usd_rate', ?, datetime('now'))
                        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')""",
                     (str(body.usd_rate),))
        audit(conn, "app_settings", "usd_rate", "update", f"Курс ₽/$: {body.usd_rate:g}")
        conn.commit()
        return {"usd_rate": body.usd_rate}
    finally:
        conn.close()
