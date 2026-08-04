"""План/факт по заказу — инвариант «одна оплата = один факт» (routers/orders.py).

Самая дорогая регрессия в проекте: ошибка здесь не роняет приложение, а тихо
меняет маржу. Два реальных инцидента, зафиксированных в CLAUDE.md и code_rules,
вынесены в отдельные тесты — задвоение покрытого обязательства и схлопывание
плана при частичной разбивке позиций по строкам.
"""
import sqlite3

import pytest

import routers.orders as orders_mod
from routers.orders import _bucket, _plan_fact, _transit_facts


class _NoClose:
    """sqlite3.Connection с заглушенным close() — _transit_facts закрывает
    zenmoney-соединение сам, а фикстуре оно нужно на несколько вызовов."""
    def __init__(self, conn): self._c = conn
    def __getattr__(self, name): return getattr(self._c, name)
    def close(self): pass


@pytest.fixture
def zm(monkeypatch):
    """In-memory zenmoney.db (боевая схема, mode=ro) — для дедупа с zm_links."""
    src = sqlite3.connect("file:/opt/fin-agent/data/zenmoney.db?mode=ro", uri=True, timeout=15)
    try:
        stmts = [r[0] for r in src.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL "
            "AND name NOT LIKE 'sqlite_%'")]
    finally:
        src.close()
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    for stmt in stmts:
        c.execute(stmt)
    wrapped = _NoClose(c)
    monkeypatch.setattr(orders_mod, "get_zenmoney", lambda: wrapped)
    yield c
    c.close()


def _zm_link(zm, oid, tx_id, outcome, payee="Карина Х."):
    zm.execute(
        "INSERT INTO zm_transactions (id, date, payee, outcome, income) VALUES (?,?,?,?,0)",
        (tx_id, "2026-07-20", payee, outcome))
    zm.execute(
        "INSERT INTO zm_links (zm_tx_id, order_id, contractor_name) VALUES (?,?,?)",
        (tx_id, oid, "Кебра"))


def _order(conn, oid="ORD-T01", price=100_000.0, cost=60_000.0):
    conn.execute(
        "INSERT INTO orders (id, number, title, status, price_plan, cost_plan) "
        "VALUES (?,?,?,?,?,?)", (oid, oid, "Тестовый заказ", "in_production", price, cost))
    return oid


def _set(conn, oid, sid="SET-1", payment_type="cash", status="approved"):
    conn.execute(
        "INSERT INTO estimate_sets (id, order_id, number, title, status, payment_type, "
        "bank_pct, created_at) VALUES (?,?,?,?,?,?,?, '2026-07-01')",
        (sid, oid, 1, "Смета", status, payment_type, 13.0))
    return sid


def _item(conn, sid, iid, category="material", qty=1, cost_total=0.0, sale=0.0):
    conn.execute(
        "INSERT INTO estimate_items (id, set_id, title, category, quantity, cost_total, "
        "sale_price) VALUES (?,?,?,?,?,?,?)",
        (iid, sid, f"Позиция {iid}", category, qty, cost_total, sale))
    return iid


def _line(conn, iid, lid, ltype, total):
    conn.execute(
        "INSERT INTO estimate_lines (id, item_id, type, title, qty, unit_price, line_total) "
        "VALUES (?,?,?,?,1,?,?)", (lid, iid, ltype, f"Строка {lid}", total, total))


def _expense(conn, oid, amount, category="material", **kw):
    conn.execute(
        "INSERT INTO expenses (id, order_id, title, amount, category, creditor_id, "
        "finance_tx_id, zenmoney_tx_id) VALUES (?,?,?,?,?,?,?,?)",
        (kw.get("eid", f"EXP-{amount}"), oid, "Трата", amount, category,
         kw.get("creditor_id"), kw.get("finance_tx_id"), kw.get("zenmoney_tx_id")))


def _creditor(conn, oid, cid, paid, **kw):
    conn.execute(
        "INSERT INTO creditors (id, name, total, paid, order_id, estimate_item_id, "
        "estimate_line_id, finance_tx_id, zenmoney_tx_id) VALUES (?,?,?,?,?,?,?,?,?)",
        (cid, "Мастер", paid, paid, oid, kw.get("estimate_item_id"),
         kw.get("estimate_line_id"), kw.get("finance_tx_id"), kw.get("zenmoney_tx_id")))


class TestBucket:
    @pytest.mark.parametrize("raw,expected", [
        ("material", "Материалы"), ("материал", "Материалы"), ("материалы", "Материалы"),
        ("labor", "Работы"), ("service", "Работы"), ("work", "Работы"), ("работы", "Работы"),
        ("delivery", "Доставка"), ("доставка", "Доставка"),
        ("other", "Прочее"), ("", "Прочее"), (None, "Прочее"),
    ])
    def test_известные_значения(self, raw, expected):
        assert _bucket(raw) == expected

    def test_регистр_не_важен(self):
        assert _bucket("MATERIAL") == "Материалы"

    def test_чужое_значение_уезжает_в_прочее(self):
        """Функция тотальная: любое незнакомое значение молча становится «Прочее».

        Это осознанное поведение, но оно и есть причина правила «категории строго
        четыре»: опечатка в category не упадёт, а тихо перекосит разбивку.
        """
        assert _bucket("materails") == "Прочее"


class TestФакт:
    def test_факт_складывает_расходы_по_категориям(self, conn):
        oid = _order(conn)
        _set(conn, oid)
        _expense(conn, oid, 10_000, "material", eid="E1")
        _expense(conn, oid, 5_000, "work", eid="E2")
        res = _plan_fact(conn, oid, 60_000, 0, 100_000)
        by = {c["category"]: c["fact"] for c in res["categories"]}
        assert by["Материалы"] == 10_000
        assert by["Работы"] == 5_000

    def test_непокрытое_обязательство_попадает_в_факт(self, conn):
        oid = _order(conn)
        _set(conn, oid)
        _creditor(conn, oid, "C1", 20_000)
        res = _plan_fact(conn, oid, 60_000, 0, 100_000)
        by = {c["category"]: c["fact"] for c in res["categories"]}
        assert by["Прочее"] == 20_000

    def test_обязательство_покрытое_расходом_не_задваивается(self, conn):
        """ИНВАРИАНТ: одна оплата = один факт. Связка через creditor_id."""
        oid = _order(conn)
        _set(conn, oid)
        _creditor(conn, oid, "C1", 20_000)
        _expense(conn, oid, 20_000, "work", eid="E1", creditor_id="C1")
        res = _plan_fact(conn, oid, 60_000, 0, 100_000)
        assert sum(c["fact"] for c in res["categories"]) == 20_000

    def test_покрытие_по_id_транзакции_банка(self, conn):
        """Расход и обязательство — один перевод, связаны finance_tx_id."""
        oid = _order(conn)
        _set(conn, oid)
        _creditor(conn, oid, "C1", 15_000, finance_tx_id="TX-77")
        _expense(conn, oid, 15_000, "work", eid="E1", finance_tx_id="TX-77")
        res = _plan_fact(conn, oid, 60_000, 0, 100_000)
        assert sum(c["fact"] for c in res["categories"]) == 15_000

    def test_покрытие_по_id_транзакции_zenmoney(self, conn):
        oid = _order(conn)
        _set(conn, oid)
        _creditor(conn, oid, "C1", 12_000, zenmoney_tx_id="ZM-9")
        _expense(conn, oid, 12_000, "work", eid="E1", zenmoney_tx_id="ZM-9")
        res = _plan_fact(conn, oid, 60_000, 0, 100_000)
        assert sum(c["fact"] for c in res["categories"]) == 12_000

    def test_разные_транзакции_не_считаются_покрытием(self, conn):
        """Совпадать должен именно id, а не факт наличия обеих записей."""
        oid = _order(conn)
        _set(conn, oid)
        _creditor(conn, oid, "C1", 10_000, finance_tx_id="TX-1")
        _expense(conn, oid, 8_000, "work", eid="E1", finance_tx_id="TX-2")
        res = _plan_fact(conn, oid, 60_000, 0, 100_000)
        assert sum(c["fact"] for c in res["categories"]) == 18_000

    def test_категория_обязательства_берётся_из_сметы(self, conn):
        """Оплаченное напрямую обязательство раньше целиком падало в «Прочее»."""
        oid = _order(conn)
        sid = _set(conn, oid)
        iid = _item(conn, sid, "IT-1", category="labor", cost_total=30_000)
        _creditor(conn, oid, "C1", 30_000, estimate_item_id=iid)
        res = _plan_fact(conn, oid, 60_000, 0, 100_000)
        by = {c["category"]: c["fact"] for c in res["categories"]}
        assert by["Работы"] == 30_000
        assert "Прочее" not in by


class TestПлан:
    def test_план_из_строк_умножается_на_количество(self, conn):
        oid = _order(conn)
        sid = _set(conn, oid)
        iid = _item(conn, sid, "IT-1", qty=3, cost_total=999)
        _line(conn, iid, "L1", "material", 1_000)
        _line(conn, iid, "L2", "labor", 500)
        res = _plan_fact(conn, oid, 60_000, 0, 100_000)
        by = {c["category"]: c["plan"] for c in res["categories"]}
        # cost_total позиции игнорируется, когда есть строки состава.
        assert by["Материалы"] == 3_000
        assert by["Работы"] == 1_500

    def test_позиция_без_строк_идёт_своей_суммой(self, conn):
        oid = _order(conn)
        sid = _set(conn, oid)
        _item(conn, sid, "IT-1", category="delivery", qty=1, cost_total=7_000)
        res = _plan_fact(conn, oid, 60_000, 0, 100_000)
        by = {c["category"]: c["plan"] for c in res["categories"]}
        assert by["Доставка"] == 7_000

    def test_частичная_разбивка_не_схлопывает_план(self, conn):
        """Инцидент Горбачёва: одна разобранная позиция из двух выключала фолбэк,
        и план заказа падал до суммы её строк."""
        oid = _order(conn)
        sid = _set(conn, oid)
        broken = _item(conn, sid, "IT-1", category="material", qty=1, cost_total=99)
        _line(conn, broken, "L1", "material", 19_267)
        _item(conn, sid, "IT-2", category="labor", qty=1, cost_total=130_600)
        res = _plan_fact(conn, oid, 60_000, 0, 100_000)
        assert res["cost_plan"] == 149_867

    def test_без_сметы_план_берётся_из_заказа(self, conn):
        oid = _order(conn)
        res = _plan_fact(conn, oid, 60_000, 0, 100_000)
        assert res["cost_plan"] == 60_000
        assert {c["category"]: c["plan"] for c in res["categories"]}["Прочее"] == 60_000


class TestТранзитныйФакт:
    """Тот же инвариант живёт вторым экземпляром в _transit_facts.

    Копия отдельная и с другой механикой (флаг covered вместо NOT EXISTS), так
    что починка одной не чинит вторую — проверяем обе. zm_links из zenmoney.db
    здесь не участвуют: функция обязана считать по своим источникам, если
    внешняя база недоступна.
    """

    def test_расход_учитывается_один_раз(self, conn):
        oid = _order(conn)
        _expense(conn, oid, 44_370, "work", eid="E1")
        assert _transit_facts(conn)[oid]["fact"] == 44_370

    def test_покрытое_обязательство_не_задваивает_выплату(self, conn):
        oid = _order(conn)
        _creditor(conn, oid, "C1", 44_370)
        _expense(conn, oid, 44_370, "work", eid="E1", creditor_id="C1")
        assert _transit_facts(conn)[oid]["fact"] == 44_370

    def test_непокрытое_обязательство_добавляется(self, conn):
        oid = _order(conn)
        _expense(conn, oid, 10_000, "work", eid="E1")
        _creditor(conn, oid, "C1", 5_000)
        assert _transit_facts(conn)[oid]["fact"] == 15_000

    def test_zm_link_гасится_расходом_с_тем_же_tx(self, conn, zm):
        """Штатная связка: разнесённый расход несёт zenmoney_tx_id привязки."""
        oid = _order(conn)
        _zm_link(zm, oid, "ZM-1", 44_370)
        _expense(conn, oid, 44_370, "work", eid="E1", zenmoney_tx_id="ZM-1")
        assert _transit_facts(conn)[oid]["fact"] == 44_370

    def test_zm_link_не_задваивает_ручной_расход_без_tx(self, conn, zm):
        """Инцидент-кандидат: Юра внёс выплату руками (без tx_id), фин-агент
        привязал ТОТ ЖЕ перевод через zm_links — факт не должен удвоиться."""
        oid = _order(conn)
        _zm_link(zm, oid, "ZM-1", 44_370)
        _expense(conn, oid, 44_370, "work", eid="E1")   # ручной, tx_id пуст
        assert _transit_facts(conn)[oid]["fact"] == 44_370

    def test_zm_link_не_задваивает_обязательство_без_tx(self, conn, zm):
        oid = _order(conn)
        _zm_link(zm, oid, "ZM-1", 44_370)
        _creditor(conn, oid, "C1", 44_370)               # закрыто руками, tx_id пуст
        assert _transit_facts(conn)[oid]["fact"] == 44_370

    def test_zm_link_на_другую_сумму_добавляется(self, conn, zm):
        """Дедуп по сумме не должен гасить НАСТОЯЩУЮ вторую выплату."""
        oid = _order(conn)
        _zm_link(zm, oid, "ZM-1", 20_000)
        _expense(conn, oid, 44_370, "work", eid="E1")
        assert _transit_facts(conn)[oid]["fact"] == 64_370

    def test_сводка_видит_факт_транзита_из_привязок(self, conn, zm):
        """_plan_fact у транзитного заказа обязан брать факт из _transit_facts
        (включая zm_links) — иначе сводка П/Ф показывает нули при живой выплате."""
        oid = _order(conn)
        sid = _set(conn, oid, payment_type="transit")
        _item(conn, sid, "I1", category="work", cost_total=44_370, sale=51_000)
        _zm_link(zm, oid, "ZM-1", 44_370)
        res = _plan_fact(conn, oid, 44_370, 0, 51_000)
        assert res["cost_fact"] == 44_370
        assert res["has_facts"] is True

    def test_транзит_не_задваивает_свои_источники_в_сводке(self, conn, zm):
        oid = _order(conn)
        sid = _set(conn, oid, payment_type="transit")
        _item(conn, sid, "I1", category="work", cost_total=44_370, sale=51_000)
        _zm_link(zm, oid, "ZM-1", 44_370)
        _expense(conn, oid, 44_370, "work", eid="E1", zenmoney_tx_id="ZM-1")
        res = _plan_fact(conn, oid, 44_370, 0, 51_000)
        assert res["cost_fact"] == 44_370

    def test_два_расхода_с_одним_tx_считаются_раз(self, conn):
        """Дубль внутри expenses (например после деградации инбокса)."""
        oid = _order(conn)
        _expense(conn, oid, 5_000, "work", eid="E1", finance_tx_id="F1")
        _expense(conn, oid, 5_000, "work", eid="E2", finance_tx_id="F1")
        assert _transit_facts(conn)[oid]["fact"] == 5_000


class TestПрогноз:
    def test_прогноз_не_завышает_прибыль_при_неполном_факте(self, conn):
        """«Выручка − факт» врала бы вверх, пока расходы внесены не целиком."""
        oid = _order(conn)
        sid = _set(conn, oid)
        _item(conn, sid, "IT-1", category="material", qty=1, cost_total=60_000)
        _expense(conn, oid, 10_000, "material", eid="E1")
        res = _plan_fact(conn, oid, 60_000, 0, 100_000)
        # Прогноз считается от плана (60 000), а не от внесённых 10 000.
        assert res["gross_forecast"] == res["gross_plan"]

    def test_перерасход_сверх_плана_съедает_прогноз(self, conn):
        oid = _order(conn)
        sid = _set(conn, oid)
        _item(conn, sid, "IT-1", category="material", qty=1, cost_total=60_000)
        _expense(conn, oid, 80_000, "material", eid="E1")
        res = _plan_fact(conn, oid, 60_000, 0, 100_000)
        assert res["gross_forecast"] < res["gross_plan"]
        assert res["gross_forecast"] == 100_000 - 80_000


def _payment(conn, oid, amount, bank_tx_id=None, zenmoney_tx_id=None, channel=None,
             source="manual"):
    conn.execute(
        "INSERT INTO payments (id, order_id, amount, paid_at, bank_tx_id, zenmoney_tx_id, "
        "channel, source) VALUES (?,?,?,'2026-07-03',?,?,?,?)",
        (f"PAY-{amount}-{bank_tx_id or zenmoney_tx_id or channel or 'cash'}", oid, amount,
         bank_tx_id, zenmoney_tx_id, channel, source))


class TestСкидкаИСмешаннаяОплата:
    """Скидка — договорённость в конце (Спираль: «22 500 он не будет доплачивать»),
    смешанная оплата — часть по безналу, часть налом/на личную карту. УСН платится
    только с того, что прошло через р/с."""

    def test_скидка_уменьшает_выручку_и_долг(self, conn):
        from routers.orders import _margin
        oid = _order(conn, price=280_000, cost=128_200)
        sid = _set(conn, oid, payment_type="cash", status="approved")
        _item(conn, sid, "I1", cost_total=128_200, sale=280_000)
        conn.execute("UPDATE orders SET discount = ? WHERE id = ?", (52_500, oid))
        m = _margin(conn, oid, 280_000, 128_200)
        assert m["revenue"] == 227_500
        assert m["price_before_discount"] == 280_000

    def test_предрасчёт_скидок_даёт_то_же_что_запрос_по_заказу(self, conn):
        """Списки передают скидку батчем (_discounts), одиночные вызовы читают
        её SELECT'ом. Оба пути обязаны давать одну цифру — иначе список заказов
        и карточка разойдутся."""
        from routers.orders import _margin, _discounts
        with_d = _order(conn, price=280_000, cost=128_200)
        sid = _set(conn, with_d, payment_type="cash", status="approved")
        _item(conn, sid, "I1", cost_total=128_200, sale=280_000)
        conn.execute("UPDATE orders SET discount = ?, discount_note = ? WHERE id = ?",
                     (52_500, "договорились", with_d))
        without_d = _order(conn, oid="ORD-T02", price=100_000, cost=50_000)
        sid2 = _set(conn, without_d, sid="SET-2", payment_type="cash", status="approved")
        _item(conn, sid2, "I2", cost_total=50_000, sale=100_000)

        d = _discounts(conn)
        assert without_d not in d          # заказы без скидки в словарь не попадают
        for oid, price, cost in ((with_d, 280_000, 128_200), (without_d, 100_000, 50_000)):
            solo = _margin(conn, oid, price, cost)
            batch = _margin(conn, oid, price, cost, discounts=d)
            assert batch["discount"] == solo["discount"]
            assert batch["discount_note"] == solo["discount_note"]
            assert batch["revenue"] == solo["revenue"]

    def test_усн_только_с_банковской_части_когда_заказ_закрыт(self, conn):
        from routers.orders import _margin
        oid = _order(conn, price=280_000, cost=128_200)
        sid = _set(conn, oid, payment_type="bank", status="approved")
        _item(conn, sid, "I1", cost_total=128_200, sale=243_600)   # 243600/0.87=280000
        conn.execute("UPDATE orders SET discount = ? WHERE id = ?", (52_500, oid))
        _payment(conn, oid, 125_000, bank_tx_id="1647")   # р/с
        _payment(conn, oid, 80_000, zenmoney_tx_id="ZM-A")  # личная карта
        _payment(conn, oid, 22_500, zenmoney_tx_id="ZM-B")
        m = _margin(conn, oid, 280_000, 128_200)
        assert m["revenue"] == 227_500        # 280 000 − скидка
        assert m["tax_base"] == 125_000       # заказ закрыт: налог только с р/с
        assert m["tax"] == 7_500

    def test_недоплаченный_остаток_считается_будущим_безналом(self, conn):
        from routers.orders import _margin
        oid = _order(conn, price=100_000, cost=50_000)
        sid = _set(conn, oid, payment_type="bank", status="approved")
        _item(conn, sid, "I1", cost_total=50_000, sale=87_000)
        _payment(conn, oid, 30_000, bank_tx_id="F1")
        _payment(conn, oid, 20_000, channel="cash")        # нал — помечен ЯВНО
        m = _margin(conn, oid, 100_000, 50_000)
        # 30 000 пришло на р/с + 50 000 остатка ещё придёт (консервативно безналом)
        assert m["tax_base"] == 80_000
        assert m["tax"] == 4_800


class TestКаналПлатежаИУСН:
    """Канал платежа (channel) — прошли ли деньги через р/с. Раньше признаком был
    bank_tx_id, и он врал в обе стороны: у ручных и агентских платежей он пуст
    (4 оплаты от ООО через Т-Банк, 383 000 ₽, считались налом), а заказ со сметой
    cash не начислял УСН вовсе на реально прошедший безнал (ORD-023, 184 000 ₽)."""

    def test_усн_начисляется_на_безнал_при_смете_cash(self, conn):
        """ORD-023: активная смета cash, деньги пришли на р/с — налог обязан быть.
        Налогооблагаемость определяет ФАКТ поступления, а не тип сметы."""
        from routers.orders import _margin
        oid = _order(conn, price=230_000, cost=115_000)
        sid = _set(conn, oid, payment_type="cash", status="approved")
        _item(conn, sid, "I1", cost_total=115_000, sale=230_000)
        _payment(conn, oid, 184_000, channel="bank", source="fin-agent")
        m = _margin(conn, oid, 230_000, 115_000)
        assert m["tax_base"] == 184_000
        assert m["tax"] == 11_040
        assert m["tax_pct"] == 6.0

    def test_смета_cash_без_безнала_налога_не_даёт(self, conn):
        from routers.orders import _margin
        oid = _order(conn, price=230_000, cost=115_000)
        sid = _set(conn, oid, payment_type="cash", status="approved")
        _item(conn, sid, "I1", cost_total=115_000, sale=230_000)
        _payment(conn, oid, 184_000, channel="cash")
        m = _margin(conn, oid, 230_000, 115_000)
        assert m["tax_base"] == 0
        assert m["tax"] == 0

    def test_безнал_без_bank_tx_id_попадает_в_базу_усн(self, conn):
        """Обратная сторона того же бага: bank-заказ, оплата внесена руками
        (счёт от ООО через Т-Банк), bank_tx_id пуст. Деньги на р/с — база УСН."""
        from routers.orders import _margin
        oid = _order(conn, price=100_000, cost=50_000)
        sid = _set(conn, oid, payment_type="bank", status="approved")
        _item(conn, sid, "I1", cost_total=50_000, sale=87_000)
        _payment(conn, oid, 100_000, channel="bank")
        m = _margin(conn, oid, 100_000, 50_000)
        assert m["tax_base"] == 100_000
        assert m["tax"] == 6_000

    def test_канал_не_указан_считается_безналом_консервативно(self, conn):
        """NULL-канал: недоначисленный УСН — налоговый риск, лишний резерв —
        просто деньги в фонде. Ошибаемся в сторону резерва."""
        from routers.orders import _margin
        oid = _order(conn, price=100_000, cost=50_000)
        sid = _set(conn, oid, payment_type="cash", status="approved")
        _item(conn, sid, "I1", cost_total=50_000, sale=100_000)
        _payment(conn, oid, 60_000)            # channel NULL
        m = _margin(conn, oid, 100_000, 50_000)
        assert m["tax_base"] == 60_000
        assert m["tax"] == 3_600

    def test_личная_карта_не_база_усн(self, conn):
        from routers.orders import _margin
        oid = _order(conn, price=100_000, cost=50_000)
        sid = _set(conn, oid, payment_type="cash", status="approved")
        _item(conn, sid, "I1", cost_total=50_000, sale=100_000)
        _payment(conn, oid, 100_000, channel="personal")
        m = _margin(conn, oid, 100_000, 50_000)
        assert m["tax_base"] == 0
        assert m["tax"] == 0

    def test_без_оплат_налог_как_раньше_от_всей_выручки(self, conn):
        from routers.orders import _margin
        oid = _order(conn, price=100_000, cost=50_000)
        sid = _set(conn, oid, payment_type="bank", status="approved")
        _item(conn, sid, "I1", cost_total=50_000, sale=87_000)
        m = _margin(conn, oid, 100_000, 50_000)
        assert m["tax_base"] == 100_000
        assert m["tax"] == 6_000
