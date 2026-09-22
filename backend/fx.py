"""Курсы Нацбанка Грузии и сигнал «сегодня менять или подождать» (22.09.2026).

Зачем внешний источник. Свои сделки отвечают на вопрос «по какому курсу я menял»,
но не на «стоит ли менять сегодня»: в дни без обмена данных нет вовсе. Поэтому
официальный курс NBG (бесплатный, без ключа, с историей по дням) — опорная линия,
а разница между ним и тем, что реально дал банк, считается по СВОИМ обменам и
показывается отдельно как спред. Смешивать их в одно число нельзя: официальный
курс — не тот, по которому меняют.

🔒 Сеть не должна ронять экран. Любой сбой загрузки — это «данные на вчера»,
а не ошибка страницы: `refresh()` возвращает результат, а не бросает.
"""

import json
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta

from db import get_production

NBG_URL = "https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/"
PAIRS = ("USD", "EUR", "RUB")
QUOTE = "GEL"
TIMEOUT = 20


def _fetch(day: str | None = None, currencies=PAIRS) -> list[dict]:
    """[{date, base, quote, rate}] за одну дату. `day=None` — свежайший курс."""
    q = "&".join(f"currencies={c}" for c in currencies)
    url = f"{NBG_URL}?{q}" + (f"&date={day}" if day else "")
    req = urllib.request.Request(url, headers={"User-Agent": "firma/1.0"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        payload = json.loads(r.read().decode("utf-8"))
    out = []
    for block in payload or []:
        for c in block.get("currencies") or []:
            qty = c.get("quantity") or 1
            rate = c.get("rate")
            if not rate:
                continue
            # NBG отдаёт рубли за 100 единиц — приводим к одной, иначе в базе
            # поселится «3,1 лари за рубль».
            valid = (c.get("validFromDate") or block.get("date") or "")[:10]
            out.append({"date": valid, "base": c.get("code"), "quote": QUOTE,
                        "rate": round(rate / qty, 6)})
    return out


def _store(conn, rows) -> int:
    n = 0
    for r in rows:
        if not r["date"] or not r["base"]:
            continue
        conn.execute(
            "INSERT OR REPLACE INTO fx_rates (date, base, quote, rate, source, fetched_at)"
            " VALUES (?, ?, ?, ?, 'nbg', datetime('now'))",
            (r["date"], r["base"], r["quote"], r["rate"]))
        n += 1
    conn.commit()
    return n


def latest_stored(conn, base: str = "USD", quote: str = QUOTE):
    return conn.execute(
        "SELECT date, rate FROM fx_rates WHERE base = ? AND quote = ? ORDER BY date DESC LIMIT 1",
        (base, quote)).fetchone()


def refresh(force: bool = False) -> dict:
    """Подтянуть свежий курс, но не чаще раза в сутки.

    Вызывается лениво из ручек: отдельного крона под root у нас нет, а ходить
    в сеть на каждый запрос страницы — лишнее."""
    conn = get_production()
    try:
        row = conn.execute(
            "SELECT MAX(fetched_at) f FROM fx_rates WHERE source = 'nbg'").fetchone()
        last = (row["f"] or "") if row else ""
        if not force and last and last[:10] == datetime.utcnow().strftime("%Y-%m-%d"):
            return {"ok": True, "skipped": "уже загружали сегодня", "stored": 0}
        try:
            rows = _fetch()
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
            # Сеть — не повод ронять экран: отдаём, что есть в базе.
            return {"ok": False, "error": str(e), "stored": 0}
        return {"ok": True, "stored": _store(conn, rows),
                "date": rows[0]["date"] if rows else None}
    finally:
        conn.close()


def backfill(days: int = 180, currencies=PAIRS, sleep: float = 0.2) -> dict:
    """История по дням: у NBG нет запроса диапазоном, только одна дата за раз.
    Запускать скриптом, не из ручки."""
    import time
    conn = get_production()
    try:
        have = {r["date"] for r in conn.execute(
            "SELECT DISTINCT date FROM fx_rates WHERE source = 'nbg'").fetchall()}
        today = date.today()
        got = miss = 0
        for i in range(days):
            d = (today - timedelta(days=i)).isoformat()
            if d in have:
                continue
            try:
                rows = _fetch(d, currencies)
                got += _store(conn, rows)
            except Exception:
                miss += 1
            time.sleep(sleep)
        return {"stored": got, "failed": miss}
    finally:
        conn.close()


def series(base: str = "USD", quote: str = QUOTE, days: int = 90) -> list[dict]:
    conn = get_production()
    try:
        since = (date.today() - timedelta(days=days)).isoformat()
        return [dict(r) for r in conn.execute(
            "SELECT date, rate FROM fx_rates WHERE base = ? AND quote = ? AND date >= ?"
            " ORDER BY date", (base, quote, since)).fetchall()]
    finally:
        conn.close()


def _percentile(values: list[float], value: float) -> float:
    """Доля дней, когда курс был ХУЖЕ сегодняшнего (для продавца base)."""
    if not values:
        return 0.0
    return round(sum(1 for v in values if v < value) / len(values), 3)


def signal(base: str = "USD", quote: str = QUOTE) -> dict:
    """«Сегодня менять или подождать» — относительно СВОЕГО обычного разброса.

    Никаких прогнозов: только факт «сегодня курс лучше, чем в N% дней периода».
    Меньше 10 дней истории — вердикт не выносим, честно пишем «мало данных»."""
    rows = series(base, quote, 90)
    if not rows:
        return {"base": base, "quote": quote, "verdict": "no_data",
                "note": "курсов ещё нет — загрузить историю"}
    today = rows[-1]
    vals90 = [r["rate"] for r in rows]
    since30 = (date.today() - timedelta(days=30)).isoformat()
    vals30 = [r["rate"] for r in rows if r["date"] >= since30]
    p30, p90 = _percentile(vals30, today["rate"]), _percentile(vals90, today["rate"])

    if len(vals30) < 10:
        verdict, note = "unknown", "мало данных для сравнения (меньше 10 дней)"
    elif p30 >= 0.8:
        verdict, note = "good", f"курс лучше, чем в {int(p30 * 100)}% дней месяца"
    elif p30 >= 0.5:
        verdict, note = "normal", f"середина месячного разброса ({int(p30 * 100)}%)"
    else:
        verdict, note = "wait", f"курс хуже, чем в {int((1 - p30) * 100)}% дней месяца"

    return {
        "base": base, "quote": quote,
        "date": today["date"], "rate": today["rate"],
        "verdict": verdict, "note": note,
        "pct_month": p30, "pct_quarter": p90,
        "best_30": max(vals30) if vals30 else None,
        "worst_30": min(vals30) if vals30 else None,
        "median_30": sorted(vals30)[len(vals30) // 2] if vals30 else None,
        "days_30": len(vals30), "days_90": len(vals90),
    }
