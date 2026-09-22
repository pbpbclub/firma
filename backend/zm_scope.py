"""Линза ZenMoney: валюта счёта + видимость (22.09.2026).

Единственная точка, через которую читаются данные `zenmoney.db`. Два независимых
измерения, и ни одно не выводится из другого:

  ВАЛЮТА     — `zm_account_meta.currency`. В самой zenmoney.db валюты нет вообще,
               поэтому итог «одним числом» невозможен в принципе: любой итог —
               список по валютам (`Scope.totals()`).
  ВИДИМОСТЬ  — `zm_account_meta.visibility` (public | private | pending).
               Кто владелец — решает `privacy.py`, вне интерфейса.

🔒 Валюта — свойство НОГИ, а не строки. Одна строка ZenMoney легко бывает
кросс-валютной: `2026-07-22 — ушло 9 511,50 ₽ с Mir Cashback, пришло 300 ₾`.
Поэтому суммировать `outcome` поверх смешанного набора строк нельзя нигде.

🔒 Кросс-валютность определяется РЕЕСТРОМ, а не суммами: в базе есть рублёвые
строки с разными ногами (снятие 6500/6650 с комиссией), и признак «ноги не равны»
родил бы ложные «переводы за границу».

🔒 Fail-closed. Счёт вне реестра, неизвестное название и НЕОДНОЗНАЧНОЕ название
(три счёта Bank of Georgia называются «Universal Account») → pending: не
суммируется нигде и не показывается никому, кроме владельца.
"""

from dataclasses import dataclass

from db import get_production, get_zenmoney
from privacy import is_owner

PENDING = "pending"
PUBLIC = "public"
PRIVATE = "private"
UNKNOWN_CURRENCY = "unknown"

# Символы валют для интерфейса; неизвестная валюта символа не получает
# (иначе «unknown» нарисовался бы рублями — ровно то, от чего уходим).
CURRENCY_SIGNS = {"RUB": "₽", "GEL": "₾", "USD": "$", "EUR": "€", "TRY": "₺"}

# Единственные подписи заграничного перевода — и в маске, и в карте разноски.
# Направление важно: «ушло» и «вернулось» — разные события, и бухгалтер по
# подписи должна понимать, куда смотреть в остатке.
ABROAD_LABEL = "Себе за границу"
ABROAD_LABEL_IN = "Себе из-за границы"


@dataclass(frozen=True)
class Account:
    id: str
    title: str
    type: str
    balance: float
    currency: str
    region: str | None
    visibility: str
    role: str | None
    ambiguous: bool          # название делят несколько счетов → ноги неразличимы

    @property
    def configured(self) -> bool:
        return self.visibility != PENDING and self.currency != UNKNOWN_CURRENCY

    def as_dict(self) -> dict:
        return {
            "id": self.id, "title": self.title, "type": self.type,
            "balance": self.balance, "currency": self.currency,
            "region": self.region, "visibility": self.visibility,
            "role": self.role, "ambiguous": self.ambiguous,
        }


def _load_meta() -> tuple[dict, dict]:
    """Реестр и алиасы из production.db. Отсутствие таблиц (старая база в тестах)
    не должно ронять чтение — тогда реестр пуст, и всё считается pending."""
    conn = get_production()
    try:
        meta, aliases = {}, {}
        try:
            for r in conn.execute("SELECT * FROM zm_account_meta").fetchall():
                meta[r["account_id"]] = dict(r)
            for r in conn.execute("SELECT title, account_id FROM zm_account_aliases").fetchall():
                aliases[r["title"]] = r["account_id"]
        except Exception:
            pass
        return meta, aliases
    finally:
        conn.close()


def _load_accounts(meta: dict, aliases: dict) -> list[Account]:
    conn = get_zenmoney()
    try:
        rows = conn.execute("SELECT id, title, type, balance, archive FROM zm_accounts").fetchall()
    finally:
        conn.close()

    by_title: dict[str, int] = {}
    for r in rows:
        by_title[r["title"]] = by_title.get(r["title"], 0) + 1
    # Алиас на счёт, которого уже нет под этим именем, тоже занимает название.
    for title, aid in aliases.items():
        if title not in by_title:
            by_title[title] = 1

    out = []
    for r in rows:
        m = meta.get(r["id"]) or {}
        ambiguous = by_title.get(r["title"], 0) > 1
        visibility = m.get("visibility") or PENDING
        currency = m.get("currency") or UNKNOWN_CURRENCY
        if ambiguous:
            # Название делят несколько счетов: в zm_transactions ноги хранятся
            # названием, значит валюту и принадлежность строки установить нечем.
            visibility, currency = PENDING, UNKNOWN_CURRENCY
        out.append(Account(
            id=r["id"], title=r["title"], type=r["type"], balance=r["balance"] or 0.0,
            currency=currency, region=m.get("region"), visibility=visibility,
            role=m.get("role"), ambiguous=ambiguous,
        ))
    return out


class Scope:
    """Линза конкретного пользователя. Живёт на один запрос."""

    def __init__(self, user=None, accounts: list[Account] | None = None, owner: bool | None = None):
        self.is_owner = is_owner(user) if owner is None else bool(owner)
        if accounts is None:
            meta, aliases = _load_meta()
            accounts = _load_accounts(meta, aliases)
            self._aliases = aliases
        else:
            self._aliases = {}
        self._accounts = accounts
        self._by_title: dict[str, list[Account]] = {}
        for a in accounts:
            self._by_title.setdefault(a.title, []).append(a)
        for title, aid in self._aliases.items():
            src = next((a for a in accounts if a.id == aid), None)
            if src and title not in self._by_title:
                self._by_title[title] = [src]

    # ── счета ────────────────────────────────────────────────────────────────
    def accounts(self, include_cash: bool = False, include_archived: bool = False) -> list[Account]:
        """Видимые пользователю счета. type='cash' исключается по умолчанию:
        отрицательный «кэш» — артефакт трекинга ZenMoney (правило /accounts)."""
        out = [a for a in self._accounts if self.sees(a)]
        if not include_cash:
            out = [a for a in out if a.type != "cash"]
        return sorted(out, key=lambda a: -a.balance)

    def sees(self, account: Account) -> bool:
        if self.is_owner:
            return True
        return account.visibility == PUBLIC

    def pending_count(self) -> int:
        """Сколько счетов ждут настройки — плашка владельцу."""
        return sum(1 for a in self._accounts if not a.configured)

    def totals(self, include_cash: bool = False) -> list[dict]:
        """Итоги ПО ВАЛЮТАМ. Одного числа здесь нет и быть не может.
        Ненастроенные счета в итог не идут — молча сложить их «в рубли» и есть
        тот баг, ради которого реестр заводился."""
        agg: dict[str, dict] = {}
        for a in self.accounts(include_cash=include_cash):
            if not a.configured:
                continue
            slot = agg.setdefault(a.currency, {"currency": a.currency, "total": 0.0, "count": 0,
                                               "sign": CURRENCY_SIGNS.get(a.currency, "")})
            slot["total"] = round(slot["total"] + (a.balance or 0), 2)
            slot["count"] += 1
        order = ["RUB", "GEL", "USD", "EUR", "TRY"]
        return sorted(agg.values(), key=lambda s: (order.index(s["currency"]) if s["currency"] in order else 99))

    # ── названия ног ─────────────────────────────────────────────────────────
    def account_of(self, title: str | None) -> Account | None:
        """Название → счёт. Неоднозначное и неизвестное название счёта не даёт."""
        rows = self._by_title.get((title or "").strip() or "\0")
        if not rows or len(rows) > 1:
            return None
        return rows[0]

    def currency_of(self, title: str | None) -> str:
        a = self.account_of(title)
        return a.currency if a and a.configured else UNKNOWN_CURRENCY

    def title_visible(self, title: str | None) -> bool:
        """Видна ли пользователю нога с таким названием. Неизвестное название —
        не видно (не «на всякий случай показать»)."""
        if self.is_owner:
            return True
        a = self.account_of(title)
        return bool(a) and a.visibility == PUBLIC

    def public_titles(self) -> list[str]:
        return sorted({a.title for a in self._accounts
                       if a.visibility == PUBLIC and not a.ambiguous})

    # ── строки ───────────────────────────────────────────────────────────────
    def classify(self, row) -> str:
        """Вид строки с точки зрения границы: public | private_internal |
        cross_out (ушло из публичного в приватное) | cross_in (обратно)."""
        out_t = self._get(row, "outcome_account")
        in_t = self._get(row, "income_account")
        out_pub, in_pub = self._is_public(out_t), self._is_public(in_t)
        if out_pub and in_pub:
            return "public"
        if not out_pub and not in_pub:
            return "private_internal"
        return "cross_out" if out_pub else "cross_in"

    def visible(self, row) -> bool:
        """Видна ли строка пользователю. Владельцу — всё; остальным — публичные
        и ПЕРЕСЕКАЮЩИЕ границу (последние только в маске, см. `mask`).
        Строка между двумя приватными счетами не видна никому, кроме владельца."""
        if self.is_owner:
            return True
        return self.classify(row) in ("public", "cross_out", "cross_in")

    def mask(self, row) -> dict:
        """Обезличенная публичная нога кросс-строки.

        🔒 Вызывать ТОЛЬКО на выходе, после классификации и после агрегатов.
        Маска обнуляет вторую ногу, а `outcome > 0 and income = 0` — признак
        расхода во всём проекте (`zenmoney.py`, `expenses.py`, `alloc_map.py`).
        Замаскируешь раньше — вывод себе за границу уедет бухгалтеру в «Разноску»
        как расход к разноске и встанет в расходы по категориям.

        Что остаётся: дата и рублёвая сумма ухода. Что уходит: вторая нога,
        её счёт и валюта, курс, назначение платежа, категория.
        """
        d = dict(row) if not isinstance(row, dict) else dict(row)
        kind = self.classify(row)
        if self.is_owner or kind not in ("cross_out", "cross_in"):
            return d
        if kind == "cross_out":
            d["income"], d["income_account"], d["income_currency"] = 0, None, None
            d["outcome_currency"] = self.row_currency(row, "outcome")
        else:
            d["outcome"], d["outcome_account"], d["outcome_currency"] = 0, None, None
            d["income_currency"] = self.row_currency(row, "income")
        label = ABROAD_LABEL if kind == "cross_out" else ABROAD_LABEL_IN
        d["payee"] = label
        d["comment"] = None
        d["tags"] = "[]"
        d["display_category"] = label
        d["masked"] = True
        d["abroad"] = True
        return d

    def filter_rows(self, rows) -> list:
        return [r for r in rows if self.visible(r)]

    def tx_sql(self, alias: str = "", both_legs: bool = False) -> tuple[str, list]:
        """Фрагмент WHERE для запросов к zm_transactions.

        По умолчанию — строки, КАСАЮЩИЕСЯ публичного контура (хотя бы одной ногой):
        перевод себе за границу бухгалтер видит рублёвой ногой, иначе у неё в
        остатке Райффайзена появится дырка — деньги ушли, а строки нет.
        `both_legs=True` — только полностью публичные (разноска, подсказки: там
        кросс-строке делать нечего). Владельцу фильтр не навешивается."""
        if self.is_owner:
            return "", []
        titles = self.public_titles()
        if not titles:
            return " AND 0", []
        p = f"{alias}." if alias else ""
        marks = ",".join("?" * len(titles))
        op = "AND" if both_legs else "OR"
        return (f" AND ({p}outcome_account IN ({marks}) {op} {p}income_account IN ({marks}))",
                titles + titles)

    # ── валюта строки ────────────────────────────────────────────────────────
    def row_currency(self, row, side: str = "outcome") -> str:
        """Валюта НОГИ строки. Строка целиком валюты не имеет: перевод за границу
        уходит рублями и приходит лари одной записью."""
        key = "outcome_account" if side == "outcome" else "income_account"
        return self.currency_of(self._get(row, key))

    def row_in_currency(self, row, currency: str) -> bool:
        """Относится ли строка к валютному контуру: хотя бы одна нога в нём."""
        return currency in (self.row_currency(row, "outcome"), self.row_currency(row, "income"))

    def currencies(self, include_cash: bool = False) -> list[str]:
        return [t["currency"] for t in self.totals(include_cash=include_cash)]

    def _get(self, row, key):
        try:
            return row[key]
        except (TypeError, KeyError, IndexError):
            return getattr(row, key, None)

    def _is_public(self, title) -> bool:
        a = self.account_of(title)
        return bool(a) and a.visibility == PUBLIC


def scope_for(user=None, owner: bool | None = None) -> Scope:
    """Линза пользователя. `owner=True` — служебный вызов без пользователя
    (например, остаток бизнес-счёта): доступ там не при чём, валютный замок — да."""
    return Scope(user, owner=owner)
