---
name: warn-payment-fact-invariant
enabled: true
event: file
conditions:
  - field: content
    operator: regex_match
    pattern: creditors?\.paid|c\.paid
  - field: content
    operator: not_contains
    pattern: NOT EXISTS
---

⚠️ **Инвариант «одна оплата = один факт»** (CLAUDE.md, docs/code_rules.md 20.07)

Обязательство (`creditors.paid`) попадает в факт, **только если оно не покрыто расходом**. Иначе один и тот же платёж считается дважды — как `expense` и как `creditors.paid`, и маржа занижается вдвое.

Покрытие определяется по трём связкам, нужны все три:

```sql
NOT EXISTS (SELECT 1 FROM expenses e WHERE e.order_id = c.order_id AND (
     e.creditor_id = c.id
  OR (e.finance_tx_id  IS NOT NULL AND e.finance_tx_id  = c.finance_tx_id)
  OR (e.zenmoney_tx_id IS NOT NULL AND e.zenmoney_tx_id = c.zenmoney_tx_id)))
```

Инвариант живёт **двумя копиями**: `_plan_fact` (через `NOT EXISTS`) и `_transit_facts` (через флаг `covered` — там покрытая строка не идёт в сумму, но её `zenmoney_tx_id` всё равно кладётся в `zm_seen`, иначе перевод всплывёт из `zm_links` и задвоится). Правишь одну — проверь вторую.

Обе покрыты тестами: `python3 -m pytest tests/ -q`.
