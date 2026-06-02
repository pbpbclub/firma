# Design: Привязка транзакций к обязательствам (обратное направление)

## Контекст

В Firma уже реализована привязка обязательства → транзакции (из раздела «Мы должны»).
Отсутствует обратное направление: из ДДС и Личных финансов нельзя указать, к какому долгу
относится конкретное списание. Это нужно чтобы в реальном времени видеть «это списание —
оплата долга X» без переключения между разделами.

## Что уже есть (не меняем)

- `creditors.finance_tx_id` и `creditors.zenmoney_tx_id` — поля в БД
- `PATCH /finance/creditors/{id}` — поддерживает оба поля + `paid`
- `GET /finance/creditors/suggest?counterparty=&amount=&limit=10` — умный подбор долгов
- `LinkTxModal` в `Debtors.tsx` — привязка долга → транзакции (остаётся без изменений)

## Новый компонент: `LinkCreditorModal`

Единый компонент, используется в Finance.tsx и ZenMoney.tsx.

**Пропсы:**
```ts
interface LinkCreditorModalProps {
  tx: { id: string; counterparty: string; amount: number }  // Finance
    | { id: string; payee: string; outcome: number }         // ZenMoney
  txField: "finance_tx_id" | "zenmoney_tx_id"
  currentCreditor?: { id: string; name: string; total: number } | null
  onClose: () => void
  onLinked: () => void
}
```

**Поведение:**
1. Если `currentCreditor` не null — показывает его вверху с кнопкой «Отвязать»
2. Загружает топ-5 через `financeApi.suggestCreditors(name, amount)`
3. Поле поиска фильтрует полный список (`financeApi.creditors()`)
4. Клик по строке долга → `PATCH /creditors/{id}` с `{ [txField]: tx.id, paid: amount }` → `onLinked()`
5. «Отвязать» → `PATCH /creditors/{id}` с `{ [txField]: null }` (paid не трогаем) → `onLinked()`
6. Если привязываем к новому долгу, а старый уже есть → сначала отвязываем старый (`{ [txField]: null }`), потом привязываем новый

## Finance.tsx

**Загрузка Map:**
```ts
const { data: allCreditors } = useQuery(["creditors", "all"], () => financeApi.creditors())
// Примечание: GET /finance/creditors без параметра status должен возвращать все записи,
// иначе нужно добавить status=all в бэкенд
const financeLinkedMap = useMemo(() =>
  Object.fromEntries((allCreditors?.items ?? [])
    .filter(c => c.finance_tx_id)
    .map(c => [c.finance_tx_id, c])),
  [allCreditors]
)
```

**В строке транзакции** (только `direction === "out"`):
- Иконка `LinkSimple` (phosphor-icons): серая если не привязано, зелёная (`#4A7C59`) если привязано
- Тег под суммой если привязано: `fontSize: 10, color: "#4A7C59"` — имя обязательства
- Клик → `setLinkModal(tx)` → открывает `LinkCreditorModal`

**После привязки:** `queryClient.invalidateQueries(["creditors"])` → Map обновляется.

## ZenMoney.tsx

Аналогично Finance.tsx, но:
- Map строится по `zenmoney_tx_id`
- Иконку показываем только для транзакций с `outcome > 0` и `income === 0` (только расходы, не переводы)
- `txField = "zenmoney_tx_id"`, `amount = tx.outcome`

## Крайние случаи

| Ситуация | Поведение |
|----------|-----------|
| Транзакция уже привязана к долгу A, пользователь выбирает долг B | Сначала PATCH долга A с `{ finance_tx_id: null }`, потом PATCH долга B |
| Сумма транзакции ≠ сумма долга | Записываем `paid` из транзакции, разницу пользователь видит в Debtors |
| Перевод ZenMoney (income > 0 и outcome > 0) | Иконку не показываем |
| Отвязка | PATCH с `{ [txField]: null }`, поле `paid` не меняем |

## Файлы для изменения

| Файл | Изменение |
|------|-----------|
| `frontend/src/pages/Finance.tsx` | Map creditors + иконка + тег + `LinkCreditorModal` |
| `frontend/src/pages/ZenMoney.tsx` | То же, через `zenmoney_tx_id` |
| `frontend/src/api.ts` | Убедиться что `financeApi.creditors("all")` и `financeApi.suggestCreditors` поддерживают нужные параметры |

`LinkCreditorModal` размещаем inline в Finance.tsx (по аналогии с тем, как `LinkTxModal` живёт в Debtors.tsx).

## Проверка

1. ДДС → строка списания → иконка серая → клик → модалка с топ-5 и поиском
2. Выбрать долг → иконка зеленеет, тег с именем появляется
3. В Debtors.tsx → у долга поле «Оплачено» обновилось суммой транзакции
4. Клик на зелёную иконку → модалка с текущим долгом вверху + кнопка «Отвязать»
5. «Отвязать» → иконка серая, тег исчезает, `paid` у долга не изменился
6. То же самое повторить в ZenMoney.tsx
