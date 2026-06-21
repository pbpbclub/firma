// Единое представление наценки: канон — проценты (%).
// Производные: множитель ×N (1 + pct/100) и сумма наценки.
//
// Хранение по таблицам (UI-only, без миграций):
//   • catalog_items  → markup_pct (проценты)
//   • estimate_items → markup (множитель). markup = pctToMarkup(pct)

export function pctToMarkup(pct: number): number {
  return Math.round((1 + (pct || 0) / 100) * 1000) / 1000;
}

export function markupToPct(markup: number | null | undefined): number {
  return Math.round(((markup ?? 1) - 1) * 100);
}

// Денежное форматирование (ru-RU, ₽). «—» для нуля/пустого.
export function fmtMoney(n: number | null | undefined): string {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

// Число без валюты (для строк «Итого»).
export function fmtNum(n: number | null | undefined): string {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n);
}
