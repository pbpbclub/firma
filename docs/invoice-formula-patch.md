# Патч формулы безнала в `invoice.py` (вне git)

`/opt/firma/backend/invoice.py` не отслеживается git и деплоится отдельно, поэтому правка
формулы продублирована здесь — чтобы не потерялась при переустановке.

**Дата:** 27.07.2026. **Причина:** ТЗ `docs/firma_tz_pricing.md`, п.2 — 13% удерживаются
ИЗ суммы счёта, а не накручиваются на цену нала.

Было:
```python
if is_bank:
    item_bank_pct = r["bank_pct"] if r["bank_pct"] is not None else set_bank_pct
    total_client  = round(sale_price * (1 + item_bank_pct / 100))
else:
    total_client = round(sale_price)
```

Стало (единая формула с firma — `backend/money.py`):
```python
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from money import client_price
...
total_client = round(client_price(sale_price, "bank" if is_bank else "cash", set_bank_pct))
```

Процент берётся у СМЕТЫ: позиционный `bank_pct` в данных содержит мусор (в MIRRA от −53%
до +66% — туда писали разницу цены, а не процент банка).

**Копия у фин-агента** — `/opt/fin-agent/tools/invoice.py` — НЕ правилась: это его зона.
Ему отправлена записка; пока он не применит тот же патч, его счета будут считаться
по старой формуле.
