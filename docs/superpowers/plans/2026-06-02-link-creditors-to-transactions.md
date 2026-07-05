# Link Creditors to Transactions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Показывать тег с именем обязательства в строке транзакции и авто-обновлять поле `paid` при привязке.

**Architecture:** Оба файла уже содержат `LinkCreditorModal`/`LinkZenModal`, Map и иконку. Нужно (1) добавить тег под суммой и (2) расширить mutationFn чтобы передавался `paid`.

**Tech Stack:** React, TypeScript, @tanstack/react-query, phosphor-icons, inline styles

---

### Task 1: Тег + авто-paid в Finance.tsx

**Files:**
- Modify: `frontend/src/pages/Finance.tsx`

- [ ] **Step 1: Добавить тег с именем обязательства в строку транзакции**

Найти блок (около строки 531) со столбцом суммы в `filteredTxs.map`. Заменить:

```tsx
<div style={{ fontSize: 13, fontWeight: 600, color: t.direction === "in" ? "#4A7C59" : "#8B3A3A" }}>
  {t.direction === "in" ? "+" : "−"}{fmt(t.amount)}
</div>
```

На:

```tsx
<div>
  <div style={{ fontSize: 13, fontWeight: 600, color: t.direction === "in" ? "#4A7C59" : "#8B3A3A" }}>
    {t.direction === "in" ? "+" : "−"}{fmt(t.amount)}
  </div>
  {creditorByFinTx.has(String(t.id)) && (
    <div style={{ fontSize: 10, color: "#4A7C59", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {creditorByFinTx.get(String(t.id))?.name}
    </div>
  )}
</div>
```

- [ ] **Step 2: Авто-обновить paid при привязке**

Найти `link = useMutation` внутри `LinkCreditorModal` (около строки 221). Заменить `mutationFn`:

```ts
mutationFn: ({ creditorId, txId }: { creditorId: string; txId: string | null }) =>
  financeApi.updateCreditor(creditorId, { finance_tx_id: txId }),
```

На:

```ts
mutationFn: ({ creditorId, txId }: { creditorId: string; txId: string | null }) => {
  const patch: any = { finance_tx_id: txId };
  if (txId !== null) patch.paid = tx.amount;
  return financeApi.updateCreditor(creditorId, patch);
},
```

- [ ] **Step 3: Проверить вручную**

```bash
# Убедиться что сборка проходит
cd /home/claude-runner/firma/frontend && npm run build 2>&1 | tail -5
```

- [ ] **Step 4: Задеплоить**

```bash
cd /home/claude-runner/firma/frontend && npm run build && sudo rm -rf /opt/firma/frontend/dist && sudo cp -r dist /opt/firma/frontend/
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Finance.tsx
git commit -m "Finance: show creditor tag in tx row, auto-set paid on link"
```

---

### Task 2: Тег + авто-paid в ZenMoney.tsx

**Files:**
- Modify: `frontend/src/pages/ZenMoney.tsx`

- [ ] **Step 1: Добавить тег с именем обязательства в строку транзакции**

Найти строку около 1028 где показывается иконка LinkSimple. Рядом с суммой транзакции добавить тег. Найти блок отображения суммы (ищи `tx.outcome` или `tx.income` в этой области) и добавить под ним:

```tsx
{creditorByZenTx.has(String(tx.id)) && (
  <div style={{ fontSize: 10, color: "#4A7C59", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
    {creditorByZenTx.get(String(tx.id))?.name}
  </div>
)}
```

- [ ] **Step 2: Авто-обновить paid при привязке**

Найти `link = useMutation` внутри `LinkZenModal` (около строки 472). Заменить:

```ts
mutationFn: ({ creditorId, txId }: { creditorId: string; txId: string | null }) =>
  financeApi.updateCreditor(creditorId, { zenmoney_tx_id: txId }),
```

На:

```ts
mutationFn: ({ creditorId, txId }: { creditorId: string; txId: string | null }) => {
  const patch: any = { zenmoney_tx_id: txId };
  if (txId !== null) patch.paid = tx.outcome;
  return financeApi.updateCreditor(creditorId, patch);
},
```

- [ ] **Step 3: Проверить вручную**

Открыть ZenMoney → привязать транзакцию → увидеть тег с именем долга → проверить в Debtors что `paid` обновился.

- [ ] **Step 4: Задеплоить**

```bash
cd /home/claude-runner/firma/frontend && npm run build && sudo rm -rf /opt/firma/frontend/dist && sudo cp -r dist /opt/firma/frontend/
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/ZenMoney.tsx
git commit -m "ZenMoney: show creditor tag in tx row, auto-set paid on link"
```
