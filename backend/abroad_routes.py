"""Выводы себе за границу — по маршрутам (решение Юры 23.09.2026).

До этого «вывод» считался только по строкам ZenMoney, где обе ноги в одной записи
(рубли ушли — лари пришли). Так ложится лишь часть переводов, и в сентябре экран
показывал 1 500 ₽ вместо 160 тыс.: Avosend и почти вся Золотая корона записаны
ОДНОЙ ногой — расходом с рублёвой карты, а приход на грузинский счёт отдельной
строкой без получателя. Юра: «это различные переводы через различные схемы и
сервисы» — поэтому вывод опознаётся по МАРШРУТУ, а не по форме строки.

🔒 Считается только нога, уходящая с ДОМАШНЕГО (рублёвого) счёта наружу:
  - строка-расход (income = 0) с приметой маршрута;
  - либо кросс-строка «рублёвый счёт → счёт страны» (маршрут по примете, иначе
    «прямой перевод»).
Внутренний шаг «Т-Банк → Райффайзен» — перевод между своими рублёвыми счетами, в
вывод не идёт (иначе один перевод считался бы дважды). Возврат от сервиса
(«Прочие поступления AVOSEND») — приход, не вывод.

🔒 Такая строка — НЕ расход. В «Личных» она считается переводом, в Разноску не
попадает (решение Юры 23.09.2026: «да, это не расход»).

Маршрут — справочник в коде: способы вывода добавляются, опознавать по признаку
в данных, а не по сумме (то же правило, что `purpose='owner_draw'` у фирмы).
"""

ROUTES = [
    # key, title, признаки (в payee или comment, нижний регистр)
    ("avosend",      "Avosend",               ("avosend",)),
    ("golden_crown", "Золотая корона",        ("золотая корона", "korona", "корона")),
    ("uz_ms9",       "Узбекистан (MS 9)",     ("курс конвертации: 1 rub", " uzs")),
    ("bog_direct",   "Прямой перевод в BOG",  ("pheiment",)),
]
DIRECT = ("direct", "Прямой перевод на карту")
TITLES = {k: t for k, t, _ in ROUTES} | {DIRECT[0]: DIRECT[1]}


def _signature(row) -> str | None:
    text = f"{(row['payee'] or '')} | {(row['comment'] or '')}".lower()
    # «Прочие поступления AVOSEND» — возврат сервиса на карту, это приход
    if "поступлени" in text:
        return None
    if (row["payee"] or "").strip().lower() == "ms 9":
        return "uz_ms9"
    for key, _title, marks in ROUTES:
        if any(m in text for m in marks):
            return key
    return None


def route_of(row, scope) -> str | None:
    """Маршрут вывода, если строка — вывод себе за границу; иначе None."""
    out_acc = scope.account_of(row["outcome_account"])
    if not out_acc or out_acc.region is not None:
        return None                          # уходит не с домашнего счёта
    # 🔒 Fail-closed по валюте ноги: сумма вывода везде показывается РУБЛЯМИ
    # (`amount_rub`). Счёт без назначенной валюты региона не имеет (region NULL
    # у всех, кого нет в реестре), и без этой проверки нерублёвая нога молча
    # складывалась бы в рублёвый итог «вывод себе за границу».
    if out_acc.currency != "RUB":
        return None
    inc, out = row["income"] or 0, row["outcome"] or 0
    if out <= 0:
        return None
    if inc > 0:
        in_acc = scope.account_of(row["income_account"])
        if in_acc and in_acc.region is not None:     # кросс-строка RU → страна
            return _signature(row) or DIRECT[0]
        return None                          # перевод между своими рублёвыми
    return _signature(row)                   # расход с приметой маршрута


def outflows(rows, scope, region: str | None = None) -> list[dict]:
    """Строки-выводы: {id, date, amount_rub, route, route_title, account, payee}.

    `region` — раздел страны. Кросс-строка знает страну назначения (счёт второй
    ноги) и в чужой раздел не идёт. У строки-расхода (Avosend, Корона) страны
    назначения в данных НЕТ — маршрут там сервис, а не страна, поэтому такие
    строки остаются во всех разделах: сопоставление «маршрут → страна» — решение
    Юры, а не догадка кода.

    Строка без даты пропускается: она не ложится ни в один месяц, а по месяцам
    считаются и итог, и разбивка."""
    out = []
    for r in rows:
        key = route_of(r, scope)
        if not key or not (r["date"] or ""):
            continue
        in_acc = scope.account_of(r["income_account"]) if (r["income"] or 0) > 0 else None
        to_region = in_acc.region if in_acc else None
        if region is not None and to_region is not None and to_region != region:
            continue
        out.append({"id": str(r["id"]), "date": r["date"], "amount_rub": round(r["outcome"] or 0, 2),
                    "route": key, "route_title": TITLES[key], "account": r["outcome_account"],
                    "payee": r["payee"], "comment": r["comment"], "to_region": to_region})
    return out
