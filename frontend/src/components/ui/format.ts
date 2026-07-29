// Единое форматирование денег и дат. Деньги — реэкспорт из priceMath (там же
// математика наценки): один источник вместо локальных fmt() в каждой странице.
export { fmtMoney, fmtNum } from "./priceMath";
import { fmtMoney as _fm } from "./priceMath";

// Вариант с прочерком на нуле — историческое поведение большинства экранов
// (ноль в таблице читался как «нечего показывать»). Для мест, где ноль значим
// (закрытый долг, нулевая дельта), используй fmtMoney.
export function fmtMoneyDash(n: number | null | undefined): string {
  return !n ? "—" : _fm(n);
}

// «21 июл. 2026» / «21 июл.»; «—» для пустого.
export function fmtDate(s: string | null | undefined, withYear = true): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(+d)) return s;
  return d.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });
}
