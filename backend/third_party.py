"""«Чужие деньги» — транзит третьим лицам через личные карты (ТЗ Юры 23.09.2026).

Юра проводит через свои карты деньги других людей: получает рубли за человека
и выдаёт их ему в Грузии (переводом или наличными). Пометка `zm_third_party`
(по tx_id ZenMoney) выводит такую ногу из доходов и трат Юры — и в разделе
«Грузия» (`abroad.decorate`), и в сводках «Личных» (`zenmoney.report/cashflow`).

🔒 Опознавать по tx_id, а не по получателю: у того же получателя бывают и свои
переводы. Это не категория трат — это вообще не трата (как `owner_draw` у фирмы).

🔒 Помеченная нога вычитается ЧАСТЬЮ (`amount`) либо целиком (NULL). Нога
выбирается по направлению: received → приход, given → расход. Остаток по
человеку — по валютам ноги; сводится в рубли, только если у каждой валютной
выдачи есть `amount_rub` (кросс-валютность — по реестру счетов, не по суммам).
"""

from db import get_production, get_zenmoney

DIRECTIONS = ("received", "given")
SIDE = {"received": "income", "given": "outcome"}
EPS = 0.005


def load_marks(conn=None) -> dict[str, dict]:
    own = conn is None
    conn = conn or get_production()
    try:
        if not conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='zm_third_party'").fetchone():
            return {}
        return {str(r["tx_id"]): dict(r) for r in conn.execute("SELECT * FROM zm_third_party").fetchall()}
    finally:
        if own:
            conn.close()


def _get(row, key):
    try:
        return row[key]
    except (KeyError, IndexError):
        return None


def leg_amount(row, direction: str) -> float:
    return float(_get(row, SIDE[direction]) or 0)


def part(row, mark: dict | None) -> float:
    """Сколько из ноги — чужие деньги."""
    if not mark:
        return 0.0
    leg = leg_amount(row, mark["direction"])
    return round(min(mark["amount"] or leg, leg), 2)


def own_legs(row, marks: dict) -> tuple[float, float]:
    """(income, outcome) строки за вычетом чужих денег — то, что принадлежит Юре."""
    inc, out = float(_get(row, "income") or 0), float(_get(row, "outcome") or 0)
    mark = marks.get(str(_get(row, "id")))
    if mark:
        p = part(row, mark)
        if mark["direction"] == "received":
            inc = max(inc - p, 0.0)
        else:
            out = max(out - p, 0.0)
    return (0.0 if inc < EPS else inc), (0.0 if out < EPS else out)


def fetch_rows(ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    conn = get_zenmoney()
    try:
        marks = ",".join("?" * len(ids))
        rows = conn.execute(f"SELECT * FROM zm_transactions WHERE id IN ({marks})", ids).fetchall()
        return {str(r["id"]): dict(r) for r in rows}
    finally:
        conn.close()


def entries(scope, person: str | None = None) -> list[dict]:
    """Помеченные ноги с суммой, валютой и счётом — лента блока «Чужие деньги»."""
    marks = load_marks()
    if person:
        marks = {k: v for k, v in marks.items() if v["person"] == person}
    rows = fetch_rows(list(marks))
    out = []
    for tx_id, m in marks.items():
        r = rows.get(tx_id)
        side = SIDE[m["direction"]]
        cur = scope.row_currency(r, side) if r else "unknown"
        out.append({
            "tx_id": tx_id, "person": m["person"], "direction": m["direction"],
            "amount": part(r, m) if r else m["amount"],
            "partial": bool(m["amount"]) and r is not None and m["amount"] < leg_amount(r, m["direction"]),
            "currency": None if cur == "unknown" else cur,
            "amount_rub": m["amount_rub"] if cur != "RUB" else (part(r, m) if r else m["amount"]),
            "date": r.get("date") if r else None,
            "account": r.get(f"{side}_account") if r else None,
            "payee": r.get("payee") if r else None, "comment": r.get("comment") if r else None,
            "note": m["note"], "missing": r is None or bool(r.get("deleted")),
        })
    return sorted(out, key=lambda e: (e["date"] or "", e["tx_id"]), reverse=True)


def people(scope) -> list[dict]:
    """По человеку: получено за него / выдано ему / остаток к выдаче.

    `balance > 0` — Юра ещё должен отдать; `< 0` — отдал лишнего. Остаток по
    валютам (`by_currency`); в рублях (`balance_rub`) — только когда каждую
    нерублёвую ногу сопроводили `amount_rub`, иначе `rub_complete=false`."""
    agg: dict[str, dict] = {}
    for e in entries(scope):
        p = agg.setdefault(e["person"], {"person": e["person"], "received_rub": 0.0, "given_rub": 0.0,
                                         "rub_complete": True, "count": 0, "by_currency": {},
                                         "last_date": None})
        p["count"] += 1
        p["last_date"] = max(p["last_date"] or "", e["date"] or "") or None
        cur = e["currency"] or "unknown"
        c = p["by_currency"].setdefault(cur, {"currency": e["currency"], "received": 0.0, "given": 0.0})
        c["received" if e["direction"] == "received" else "given"] += e["amount"] or 0
        if e["amount_rub"] is None:
            p["rub_complete"] = False
        else:
            p["received_rub" if e["direction"] == "received" else "given_rub"] += e["amount_rub"]
    res = []
    for p in agg.values():
        p["by_currency"] = [{**c, "received": round(c["received"], 2), "given": round(c["given"], 2),
                             "balance": round(c["received"] - c["given"], 2)}
                            for c in p["by_currency"].values()]
        p["received_rub"], p["given_rub"] = round(p["received_rub"], 2), round(p["given_rub"], 2)
        p["balance_rub"] = round(p["received_rub"] - p["given_rub"], 2) if p["rub_complete"] else None
        res.append(p)
    return sorted(res, key=lambda p: p["last_date"] or "", reverse=True)
