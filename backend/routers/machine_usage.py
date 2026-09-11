"""Машинное время агентов — учёт сессий (токены, часы, модели) по заказам.

Направление «Проектные работы» (чертежи и модели с Профи.ру, бренд pbpb, с 09.09.2026)
делает конструктор — агент Claude на маке Юры; позже — другие люди, агенты и
площадки. Юра «называет цену просто так» и копит показатели, чтобы найти корреляцию
и вывести ценник.

Правила (брейнсторм с Юрой 11.09.2026):
- **машинное время — у.е. (токены) и часы, по моделям.** Рублей за токены нет: никто
  их не платил. Расходов по заказу учёт НЕ рождает, себестоимость заказа — только из
  реальных денег (приходы, выплаты людям). Условные расходы фин-агента (951 и
  13 663 ₽) по этому решению удалены;
- `usd` — **справочная оценка** «если бы платили за токены по тарифу API»
  (model_prices), заголовком величины не идёт. Неизвестная модель — 400, а не расчёт
  «по похожей»: оценка честная либо отсутствует;
- **единая таблица Фирмы, приём через API** от любого источника (мак, фин-агент,
  другие площадки); выгрузки мака в /opt/fin-agent/data/uploads Фирме не читаются;
- часы Юры пока не вносятся — только сессии агентов.

Заказ строки: явный order → папка проекта (order_project_dirs, ТЗ Mac 11.09.2026) →
без заказа (order_id NULL, блок «Без заказа» на странице, назначается PATCH).
Дедуп — ext_key (ключ мака `mac-<дата>-<папка>-<модель>` либо sha1 содержимого).
Колонки amount/fx_rate/expense_id в таблице остались от первой версии и не пишутся.
"""
import hashlib
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from audit import audit
from db import get_production
from routers.orders import _margin, _transit_facts, _discounts, _extras_totals

router = APIRouter()

AGENT_LABELS = {"constructor": "Конструктор", "fin": "Фин-агент", "yos": "YOS", "firma": "Фирма",
                "mac": "Менеджер Mac", "blender": "Конструктор"}
TOKEN_KINDS = ("tokens_in", "tokens_out", "cache_write", "cache_read")


class UsageIn(BaseModel):
    order: Optional[str] = None          # ORD-054 | uuid
    project_dir: Optional[str] = None    # папка конструктора — фолбэк, если order не дан
    date: Optional[str] = None           # YYYY-MM-DD, по умолчанию сегодня
    agent: str = "constructor"
    platform: Optional[str] = None       # mac | server | profi | …
    model: Optional[str] = None          # без модели — только время
    sessions: int = 0
    hours: float = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cache_write: int = 0
    cache_read: int = 0
    key: Optional[str] = None            # ключ идемпотентности от источника
    note: Optional[str] = None
    source: Optional[str] = None         # mac | fin | manual | …
    # Синонимы из формата мака/фин-агента: {"in": …, "out": …}
    model_config = {"populate_by_name": True, "extra": "allow"}


class ImportIn(BaseModel):
    entries: list[UsageIn]
    source: Optional[str] = "mac"


class UsagePatch(BaseModel):
    order_id: Optional[str] = None
    hidden: Optional[bool] = None        # скрыть с экрана, не удаляя (ключ остаётся — дубль не придёт)
    hours: Optional[float] = None
    sessions: Optional[int] = None
    note: Optional[str] = None
    agent: Optional[str] = None
    platform: Optional[str] = None
    model: Optional[str] = None
    tokens_in: Optional[int] = None
    tokens_out: Optional[int] = None
    cache_write: Optional[int] = None
    cache_read: Optional[int] = None


class ModelPriceIn(BaseModel):
    model: str
    price_in: float
    price_out: float
    price_cache_write: float
    price_cache_read: float
    note: Optional[str] = None


# ── оценка ───────────────────────────────────────────────────────────────────

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


def _record(conn, u: UsageIn, source: str) -> dict:
    """Одна строка учёта. Без commit — import собирает пачку."""
    u = _normalize(u)
    order_id = _resolve_order(conn, u)
    key = _ext_key(u, u.order or u.project_dir or "")
    seen = conn.execute("SELECT id, order_id FROM machine_usage WHERE ext_key = ?", (key,)).fetchone()
    if seen:
        return {"status": "exists", "id": seen["id"], "order_id": seen["order_id"], "key": key}
    usd = _usd(_price(conn, u.model), u.tokens_in, u.tokens_out, u.cache_write, u.cache_read) if u.model else None
    date = u.date or conn.execute("SELECT date('now')").fetchone()[0]
    uid = str(uuid4())
    conn.execute("""INSERT INTO machine_usage
        (id, order_id, work_date, agent, platform, model, sessions, hours, tokens_in, tokens_out,
         cache_write, cache_read, usd, project_dir, ext_key, source, note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (uid, order_id, date, u.agent, u.platform, u.model, u.sessions or 0, u.hours or 0,
         u.tokens_in or 0, u.tokens_out or 0, u.cache_write or 0, u.cache_read or 0,
         usd, u.project_dir, key, u.source or source, u.note))
    tokens = (u.tokens_in or 0) + (u.tokens_out or 0) + (u.cache_write or 0) + (u.cache_read or 0)
    audit(conn, "machine_usage", uid, "create",
          f"Сессии {u.agent}: {u.hours:g} ч, {tokens / 1e6:.2f} млн токенов, {u.model or 'без модели'}"
          + ("" if order_id else " (без заказа)"))
    return {"status": "recorded" if order_id else "unassigned", "id": uid, "order_id": order_id,
            "usd_est": usd, "key": key, "unassigned": order_id is None}


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
    """Назначить заказ строке без заказа; поправить часы, модель, токены (точная
    разбивка от фин-агента приходит сюда) — оценка $ пересчитывается."""
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM machine_usage WHERE id = ?", (usage_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        fields = body.model_dump(exclude_unset=True)
        if "order_id" in fields:
            oid = fields.pop("order_id")
            if oid:
                o = conn.execute("SELECT id FROM orders WHERE id = ? OR number = ?", (oid, oid.upper())).fetchone()
                if not o:
                    raise HTTPException(status_code=404, detail="Заказ не найден")
                fields["order_id"] = o["id"]
            else:
                fields["order_id"] = None
        if "hidden" in fields:
            fields["hidden"] = int(bool(fields["hidden"]))
        merged = {**dict(row), **fields}
        if any(k in fields for k in ("model",) + TOKEN_KINDS):
            fields["usd"] = (_usd(_price(conn, merged["model"]), merged["tokens_in"] or 0, merged["tokens_out"] or 0,
                                  merged["cache_write"] or 0, merged["cache_read"] or 0)
                             if merged.get("model") else None)
        if fields:
            sets = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(f"UPDATE machine_usage SET {sets} WHERE id = ?", list(fields.values()) + [usage_id])
            audit(conn, "machine_usage", usage_id, "update", f"Правка строки машинного времени: {', '.join(fields)}", before_row=row)
            conn.commit()
        return dict(conn.execute("SELECT * FROM machine_usage WHERE id = ?", (usage_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/{usage_id}")
def delete_usage(usage_id: str):
    conn = get_production()
    try:
        row = conn.execute("SELECT * FROM machine_usage WHERE id = ?", (usage_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        audit(conn, "machine_usage", usage_id, "delete", "Строка машинного времени удалена", before_row=row)
        conn.execute("DELETE FROM machine_usage WHERE id = ?", (usage_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── чтение ───────────────────────────────────────────────────────────────────

_ROW_SQL = """SELECT u.*, o.number AS order_number, o.title AS order_title, o.status AS order_status,
                     o.activity AS order_activity, act.name AS activity_name, act.color AS activity_color
                FROM machine_usage u LEFT JOIN orders o ON o.id = u.order_id
                LEFT JOIN activities act ON act.code = o.activity"""


def _tokens(r: dict) -> int:
    return sum(r.get(k) or 0 for k in TOKEN_KINDS)


def _decorate(r: dict) -> dict:
    r["tokens_total"] = _tokens(r)
    r["agent_label"] = AGENT_LABELS.get(r["agent"], r["agent"])
    r["usd_est"] = r.pop("usd", None)
    for k in ("amount", "fx_rate", "expense_id"):   # наследие первой версии, наружу не отдаём
        r.pop(k, None)
    return r


def _by_model(rows: list) -> list:
    acc: dict = {}
    for r in rows:
        m = acc.setdefault(r["model"] or "без модели", {"model": r["model"] or "без модели", "sessions": 0,
                                                       "hours": 0.0, "tokens_total": 0, "usd_est": 0.0, "rows": 0})
        m["sessions"] += r["sessions"] or 0; m["hours"] = round(m["hours"] + (r["hours"] or 0), 2)
        m["tokens_total"] += r["tokens_total"]; m["usd_est"] = round(m["usd_est"] + (r["usd_est"] or 0), 2); m["rows"] += 1
    return sorted(acc.values(), key=lambda m: -m["tokens_total"])


class HideIn(BaseModel):
    ids: Optional[list[str]] = None      # конкретные строки
    unassigned: bool = False             # все без заказа
    hidden: bool = True                  # False — вернуть на экран


@router.post("/hide")
def hide_usage(body: HideIn):
    """Скрыть/показать пачкой: выбранные строки либо все без заказа."""
    conn = get_production()
    try:
        n = 0
        if body.ids:
            holes = ",".join("?" * len(body.ids))
            n += conn.execute(f"UPDATE machine_usage SET hidden = ? WHERE id IN ({holes})",
                              [int(body.hidden)] + list(body.ids)).rowcount
        if body.unassigned:
            n += conn.execute("UPDATE machine_usage SET hidden = ? WHERE order_id IS NULL", (int(body.hidden),)).rowcount
        audit(conn, "machine_usage", "bulk", "update", f"{'Скрыто' if body.hidden else 'Показано'} строк машинного времени: {n}")
        conn.commit()
        return {"ok": True, "count": n}
    finally:
        conn.close()


@router.get("")
def list_usage(order_id: Optional[str] = None, month: Optional[str] = None,
               agent: Optional[str] = None, unassigned: bool = False,
               date_from: Optional[str] = None, date_to: Optional[str] = None,
               hidden: Optional[bool] = None):
    """hidden: None — только видимые (дефолт), True — только скрытые, False — все."""
    conn = get_production()
    try:
        sql, params = _ROW_SQL + " WHERE 1=1", []
        if hidden is None:
            sql += " AND COALESCE(u.hidden, 0) = 0"
        elif hidden:
            sql += " AND COALESCE(u.hidden, 0) = 1"
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
        rows = [_decorate(dict(r)) for r in conn.execute(sql, params).fetchall()]
        return {"items": rows, "count": len(rows)}
    finally:
        conn.close()


@router.get("/summary")
def summary(date_from: Optional[str] = None, date_to: Optional[str] = None,
            activity: Optional[str] = None, paid_only: bool = False):
    """Сводка по заказам с сессиями: реальные деньги (цена из _margin, оплачено,
    выплаты людям — расходы work/other), у.е. (часы, токены по видам и моделям) и
    показатели: ₽ выручки на час, ₽ на 1 млн токенов, токенов на час, доля выплат
    людям в цене. $ — справочная оценка по тарифу. Заказы — с записями в периоде;
    `activity` задан — плюс заказы этого вида без записей (чтобы видеть, где сессий
    ещё нет). Период фильтрует записи по work_date; цена и оплаты заказа — целиком."""
    conn = get_production()
    try:
        where, params = "", []
        if date_from:
            where += " AND u.work_date >= ?"; params.append(date_from)
        if date_to:
            where += " AND u.work_date <= ?"; params.append(date_to)
        usage = [_decorate(dict(r)) for r in conn.execute(_ROW_SQL + " WHERE COALESCE(u.hidden, 0) = 0" + where, params).fetchall()]
        hidden_count = conn.execute("SELECT COUNT(*) FROM machine_usage WHERE COALESCE(hidden, 0) = 1").fetchone()[0]
        by_order: dict = {}
        unassigned = []
        for r in usage:
            (by_order.setdefault(r["order_id"], []) if r["order_id"] else unassigned).append(r)
        order_ids = set(by_order)
        if activity:
            order_ids |= {r["id"] for r in conn.execute(
                "SELECT id FROM orders WHERE activity = ? AND COALESCE(archived, 0) = 0", (activity,)).fetchall()}
        orders = []
        if order_ids:
            holes = ",".join("?" * len(order_ids))
            orders = [dict(r) for r in conn.execute(f"""
                SELECT o.id, o.number, o.title, o.status, o.activity, o.price_plan, o.cost_plan, o.created_at,
                       o.deadline, c.name AS customer_name, c.id AS customer_id,
                       act.name AS activity_name, act.color AS activity_color,
                       COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id), 0) AS paid_total
                  FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
                  LEFT JOIN activities act ON act.code = o.activity
                 WHERE o.id IN ({holes}) ORDER BY o.created_at DESC""", list(order_ids)).fetchall()]
            if activity:
                orders = [o for o in orders if o["activity"] == activity]
                keep = {o["id"] for o in orders}
                # разрезы по агентам/моделям — только по строкам выбранного вида
                usage = [r for r in usage if r["order_id"] in keep or not r["order_id"]]
        tfacts, discounts, extras = _transit_facts(conn), _discounts(conn), _extras_totals(conn)
        items = []
        skipped_unpaid = 0
        for o in orders:
            m = _margin(conn, o["id"], o["price_plan"], o["cost_plan"],
                        transit_facts=tfacts, discounts=discounts, extras=extras)
            # Замеряем только сделанное и оплаченное (Юра 11.09.2026): цена есть и
            # получена целиком. Неоплаченный заказ в ₽/час дал бы выручку, которой нет.
            if paid_only and not ((m["revenue"] or 0) > 0 and (o["paid_total"] or 0) >= (m["revenue"] or 0) - 0.01):
                skipped_unpaid += 1
                continue
            rows = by_order.get(o["id"], [])
            hours = round(sum(r["hours"] or 0 for r in rows), 2)
            tokens = sum(r["tokens_total"] for r in rows)
            # Людям — реальные расходы заказа на работу (машинное время расходов не рождает)
            people = round(conn.execute(
                """SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE order_id = ? AND category IN ('work', 'other')
                   AND COALESCE(purpose, '') NOT IN ('owner_draw', 'overhead')""", (o["id"],)).fetchone()[0], 2)
            revenue = m["revenue"] or 0
            items.append({
                **o, "revenue": revenue, "cost_fact": m.get("cost_fact"),
                "people_paid": people,
                "hours": hours, "sessions": sum(r["sessions"] or 0 for r in rows), "tokens_total": tokens,
                "tokens_by_kind": {k: sum(r[k] or 0 for r in rows) for k in TOKEN_KINDS},
                "usd_est": round(sum(r["usd_est"] or 0 for r in rows), 2),
                "models": _by_model(rows),
                "rub_per_hour": round(revenue / hours, 2) if hours else None,
                "rub_per_mtok": round(revenue / (tokens / 1e6), 2) if tokens else None,
                "tok_per_hour": round(tokens / hours) if hours else None,
                "people_share": round(people / revenue * 100, 1) if revenue and people else None,
                "usage": rows,
            })

        if paid_only:
            # разрезы по агентам/моделям — ровно по тем заказам, что в таблице
            kept = {i["id"] for i in items}
            usage = [r for r in usage if r["order_id"] in kept]

        def tot(key):
            return round(sum(i[key] or 0 for i in items), 2)
        hours_t, tokens_t, rev_t, people_t = tot("hours"), tot("tokens_total"), tot("revenue"), tot("people_paid")
        by_agent: dict = {}
        for r in usage:
            a = by_agent.setdefault(r["agent"], {"agent": r["agent"], "label": r["agent_label"], "hours": 0.0,
                                                 "tokens_total": 0, "usd_est": 0.0, "sessions": 0, "rows": 0})
            a["hours"] = round(a["hours"] + (r["hours"] or 0), 2); a["tokens_total"] += r["tokens_total"]
            a["usd_est"] = round(a["usd_est"] + (r["usd_est"] or 0), 2); a["sessions"] += r["sessions"] or 0; a["rows"] += 1
        return {
            "items": items,
            "totals": {
                "orders": len(items), "revenue": rev_t, "paid_total": tot("paid_total"), "people_paid": people_t,
                "hours": hours_t, "sessions": tot("sessions"), "tokens_total": tokens_t, "usd_est": tot("usd_est"),
                "rub_per_hour": round(rev_t / hours_t, 2) if hours_t else None,
                "rub_per_mtok": round(rev_t / (tokens_t / 1e6), 2) if tokens_t else None,
                "tok_per_hour": round(tokens_t / hours_t) if hours_t else None,
                "people_share": round(people_t / rev_t * 100, 1) if rev_t and people_t else None,
            },
            "skipped_unpaid": skipped_unpaid,
            "hidden_count": hidden_count,
            "by_agent": sorted(by_agent.values(), key=lambda a: -a["tokens_total"]),
            "by_model": _by_model(usage),
            "unassigned": {"items": unassigned, "hours": round(sum(r["hours"] or 0 for r in unassigned), 2),
                           "tokens_total": sum(r["tokens_total"] for r in unassigned),
                           "usd_est": round(sum(r["usd_est"] or 0 for r in unassigned), 2)},
        }
    finally:
        conn.close()


# ── справочник тарифов ───────────────────────────────────────────────────────

@router.get("/models")
def list_models():
    conn = get_production()
    try:
        return {"items": [dict(r) for r in conn.execute("SELECT * FROM model_prices ORDER BY model")]}
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
