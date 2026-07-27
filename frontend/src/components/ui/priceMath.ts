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

// ── Безнал: 13% удерживаются ИЗ суммы счёта ──────────────────────────────────
// Зеркало backend/money.py. Юра (27.07.2026): «Я называю сумму за нал. Если платят
// по безналу — из суммы счёта удержу 13%». Поэтому делим, а не умножаем, и округляем
// итог вверх до 100 ₽: 195 600 → 224 827,59 → 224 900.
export const ROUND_STEP = 100;
export const DEFAULT_BANK_PCT = 13;

export const roundUpMoney = (v: number, step = ROUND_STEP) =>
  !v || v <= 0 ? (v || 0) : Math.ceil(v / step) * step;

/** Сумма к оплате клиентом. rounded=false — без округления (промежуточные расчёты). */
export function clientPrice(sale: number, isBank: boolean, pct = DEFAULT_BANK_PCT, rounded = true) {
  const s = sale || 0;
  if (!isBank || s <= 0 || pct >= 100) return s;
  const gross = s / (1 - pct / 100);
  return rounded ? roundUpMoney(gross) : gross;
}

/** Обратно: из суммы счёта получить цену «как за нал» (ручная правка «К оплате»). */
export function cashFromClient(clientTotal: number, isBank: boolean, pct = DEFAULT_BANK_PCT) {
  const c = clientTotal || 0;
  return !isBank || c <= 0 ? c : Math.round(c * (1 - pct / 100) * 100) / 100;
}
