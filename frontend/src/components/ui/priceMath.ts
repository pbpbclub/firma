// Единое представление наценки: канон — проценты (%).
// Производные: множитель ×N (1 + pct/100) и сумма наценки.
//
// Хранение по таблицам (UI-only, без миграций):
//   • catalog_items  → markup_pct (проценты)
//   • estimate_items → markup (множитель). markup = pctToMarkup(pct)

export function pctToMarkup(pct: number): number {
  return Math.round((1 + (pct || 0) / 100) * 1000) / 1000;
}

// digits — точность в знаках после запятой. По умолчанию целые % (обратная
// совместимость); футеры калькуляторов показывают 1 знак, чтобы наценка,
// производная от ручной цены (якорь = цена), не врала из-за округления.
export function markupToPct(markup: number | null | undefined, digits = 0): number {
  const k = Math.pow(10, digits);
  return Math.round(((markup ?? 1) - 1) * 100 * k) / k;
}

// Денежное форматирование (ru-RU, ₽). «—» только для null/undefined/NaN.
// Реальный 0 показываем как «0 ₽»: закрытый долг ≠ отсутствие данных.
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

// Число без валюты (для строк «Итого»).
export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n);
}
