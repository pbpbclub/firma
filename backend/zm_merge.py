"""Склейки ZenMoney: две посторонние операции под видом перевода (28.09.2026).

ZenMoney сам «находит» переводы между своими счетами: расход на одном счёте и
приход на другом в один день, суммы совпадают по курсу — и две операции сливаются
в одну строку с двумя ногами. На заграничной карте это даёт ложные переводы:
  - покупка в Турции 20,02 ₾ + кэшбэк 638 ₽ на Black (26.09);
  - Anthropic $118 + постороннее поступление 10 000 ₽ на Black (20.08);
  - снятие наличных 625 ₾ + приход 20 000 ₽ на MasterCard Mass (27.07);
  - приход Avosend $219,31 + трата 589,05 ₾ (27.09) — «обмен» внутри карты.
Такая строка не трата и не приход — и в разделе страны пропадает покупка, а в
«Личных» — рублёвое поступление.

🔒 Направление «страна → домашний счёт» расклеивается ВСЕГДА (решение Юры
28.09.2026: с грузинской карты на русские деньги не ходят). Признак — реестр
счетов (`zm_account_meta.region`), не суммы и не курс.

🔒 Склейку внутри карты по форме строки от настоящего обмена не отличить (курс
банка ≈ курс ZenMoney ± спред), поэтому её расклеивает Юра — пометкой по tx_id
в `zm_unmerged`. Угадывать по курсу не пытаемся.

Расклеенная строка читается как ДВЕ ноги (`legs`): расход на счёте ухода и приход
на счёте прихода, каждая в своей валюте. Классифицировать — всегда служебной
линзой (`scope_for(None, owner=True)`): от доступа читателя это не зависит.
"""

from db import get_production

AUTO = "auto"
MANUAL = "manual"


def _get(row, key):
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return None


def load_marks(conn=None) -> dict[str, dict]:
    """Ручные пометки {tx_id: row}. Нет таблицы (миграция не доехала) — пусто."""
    own = conn is None
    conn = conn or get_production()
    try:
        if not conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='zm_unmerged'").fetchone():
            return {}
        return {str(r["tx_id"]): dict(r) for r in conn.execute("SELECT * FROM zm_unmerged").fetchall()}
    finally:
        if own:
            conn.close()


def two_legged(row) -> bool:
    return float(_get(row, "income") or 0) > 0 and float(_get(row, "outcome") or 0) > 0


def is_auto_split(row, scope) -> bool:
    """Ушло со счёта страны, пришло на домашний — склейка, перевода так не бывает.

    Fail-closed: неизвестный или неоднозначный счёт (`account_of` → None) и счёт
    без назначенной валюты правилу не подпадают — строка остаётся как есть."""
    if not two_legged(row):
        return False
    out_acc = scope.account_of(_get(row, "outcome_account"))
    in_acc = scope.account_of(_get(row, "income_account"))
    if not out_acc or not in_acc:
        return False
    return out_acc.region is not None and in_acc.region is None and in_acc.configured


def split_reason(row, scope, marks: dict) -> str | None:
    """`auto` | `manual` | None — почему строку читаем двумя операциями."""
    if not two_legged(row):
        return None
    if is_auto_split(row, scope):
        return AUTO
    if str(_get(row, "id")) in marks:
        return MANUAL
    return None


def is_split(row, scope, marks: dict) -> bool:
    return split_reason(row, scope, marks) is not None


def legs(row) -> tuple[dict, dict]:
    """(расход, приход) — две виртуальные строки с тем же id.

    Счёт второй ноги подставляется тем же, что у первой: `outcome > 0, income = 0`
    с одинаковыми счетами — признак расхода во всём проекте, и расклеенная нога
    должна читаться ровно так же, как обычная трата."""
    d = dict(row)
    out_leg = {**d, "income": 0.0, "income_account": d.get("outcome_account")}
    in_leg = {**d, "outcome": 0.0, "outcome_account": d.get("income_account")}
    if "outcome_account_id" in d:
        out_leg["income_account_id"] = d.get("outcome_account_id")
        in_leg["outcome_account_id"] = d.get("income_account_id")
    return out_leg, in_leg
