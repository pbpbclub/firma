# BOM-контракт: Blender → Firma (каталог себестоимости)

Локальный Blender-скрипт снимает ведомость материалов изделия и шлёт её в firma —
карточка себестоимости каталога создаётся/обновляется автоматически с привязкой
к номенклатуре и живым прайсам. Дальше смета разворачивается из каталога одним
действием (cost-fill / from-catalog).

## Endpoint

```
POST https://firma.yuranek.com/api/catalog/import-bom
Authorization: Bearer <JWT>           # токен firma (30 дней, роль admin)
Content-Type: application/json
```

## Формат

```json
{
  "source": "blender",
  "version": 1,
  "product": {
    "title": "Стол Loft-01",
    "category": "стол",
    "brand": "MeRA",
    "catalog_item_id": null,
    "markup_pct": 100
  },
  "mode": "upsert",
  "lines": [
    { "type": "material", "material_code": "list-3-1250-2500", "qty": 0.5, "unit": "лист" },
    { "type": "material", "title": "Труба профильная 40x20x2", "qty": 6.2, "unit": "м" },
    { "type": "material", "title": "Фанера берёза 18мм", "qty": 0.5, "unit": "лист" },
    { "type": "labor", "work_type": "Сварка", "qty": 1, "unit": "шт" },
    { "type": "labor", "title": "Полировка кромки", "qty": 2, "unit": "ч" },
    { "type": "delivery", "title": "Доставка до клиента", "qty": 1, "unit": "шт" }
  ]
}
```

Правила:
- `product.title` обязателен. `mode: "upsert"` (по умолчанию) — карточка ищется по
  `catalog_item_id`, иначе по точному названию; найденная перезаписывается (строки
  заменяются целиком). `mode: "create"` — всегда новая.
- `line.type`: `material | labor | service | delivery`.
- Материал: лучше слать **`material_code`** (код номенклатуры materials.db — см.
  `GET /api/materials/search?q=`); без кода — `title`, приёмник сматчит сам
  (выученное правило → точное название номенклатуры → выученная цена price_book).
- Работа: `work_type` — имя вида работ (создастся, если новое); цена подтянется из
  справочника ставок.
- `unit_price` слать не нужно: цены — снапшот живых прайсов и ставок на момент
  импорта. Явная `unit_price` имеет приоритет.

## Ответ

```json
{
  "catalog_item_id": "…",
  "created": true,
  "title": "Стол Loft-01",
  "lines_total": 6,
  "matched": 4,
  "unmatched": [
    { "title": "Фанера берёза 18мм",
      "ask": "Материал «Фанера берёза 18мм» не найден в номенклатуре — какой это код или цена, ₽/лист?" }
  ],
  "cost_total": 18450.0
}
```

`unmatched` не блокирует импорт: строки лягут без цены и всплывут как «нужен ввод»
в cost-check сметы (веб и финагент). Ответ на вопрос запоминается (price_book /
costing_rules) — следующий импорт с тем же названием сматчится сам.

## Мини-пример на Python (для локального скрипта)

```python
import requests

BOM = {...}  # как выше
r = requests.post(
    "https://firma.yuranek.com/api/catalog/import-bom",
    json=BOM,
    headers={"Authorization": f"Bearer {TOKEN}"},
    timeout=20,
)
r.raise_for_status()
res = r.json()
for u in res["unmatched"]:
    print("ВОПРОС:", u["ask"])
```
