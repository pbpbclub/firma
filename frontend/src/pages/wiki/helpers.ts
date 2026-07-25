// Общие хелперы вики-экрана (раньше по 2-3 копии в Customers/Contractors/ContractorDetail).

export const PAGE_SIZE = 100;                        // дефолт: справочники небольшие
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 0];   // 0 = «Все»

export function initials(name: string | undefined) {
  if (!name) return "—";
  const cleaned = (name || "").trim().replace(/["«»„"]/g, "").replace(/^(ООО|ИП|ЗАО|ОАО|ПАО)\s+/i, "");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (!parts.length) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function fmt(n: number | null | undefined) {
  // «0 ₽» (закрытый долг, нулевой расход) и «нет данных» — разные факты: проверяем
  // на null/undefined/NaN, не на falsy, иначе реальный ноль превращается в «—».
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

export function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}
