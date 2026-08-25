/**
 * Единственный примитив адаптива в проекте.
 *
 * Стили в Фирме инлайновые — медиазапросы к ним не применяются, поэтому ветвление
 * «десктоп / телефон» делается в JSX через useIsMobile(). Правило: десктопная ветка
 * не меняется ни на пиксель, мобильная — тернарием в свойстве или
 * `...(isMobile ? {...} : null)`. Приёмка — побайтное сравнение скриншотов 1500×900.
 *
 * BP_MOBILE — парная константа к `@media (max-width: 767px)` в index.css
 * (там живёт единственное глобальное правило: поля 16px против зума iOS).
 * Менять ВМЕСТЕ.
 */
import { useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

export const BP_MOBILE = 768;
const MQ_MOBILE = `(max-width: ${BP_MOBILE - 1}px)`;

const lists = new Map<string, MediaQueryList>();
function mql(q: string): MediaQueryList {
  let m = lists.get(q);
  if (!m) { m = window.matchMedia(q); lists.set(q, m); }
  return m;
}

export function useMediaQuery(q: string): boolean {
  return useSyncExternalStore(
    (cb) => { const m = mql(q); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => mql(q).matches,
    () => false,
  );
}

export const useIsMobile = () => useMediaQuery(MQ_MOBILE);

/** Мобильные токены — дополнение к SP/PAD из type.ts, не замена. */
export const M = {
  pageX: 16,                                   // гаттер вместо SP.pageX = 28
  touch: 40,                                   // минимальная тач-мишень
  /** Ряд вкладок шапки: прокрутка вбок вместо переполнения. */
  tabStrip: {
    overflowX: "auto", whiteSpace: "nowrap", scrollbarWidth: "none",
    WebkitOverflowScrolling: "touch", flexWrap: "nowrap",
  } as CSSProperties,
  /** Ряд заголовков-фильтров таблицы → чипы в перенос. */
  filterRow: {
    display: "flex", flexWrap: "wrap", gap: "8px 16px", padding: "8px 16px",
    borderBottom: "1px solid #F7F5F1", alignItems: "center",
  } as CSSProperties,
  /** Секция «подпись width:80 + содержимое gap:48» → стопка. */
  labeled: { flexDirection: "column", gap: 10 } as CSSProperties,
} as const;

/**
 * Desktop-only поверхность на телефоне: прокрутка по горизонтали внутри
 * контейнера. Сознательно «не сломано», а не «красиво» — для панелей, которые
 * на телефон не переверстываем (Готовность, редактор сметы, лицевые счета, админка).
 * На десктопе прозрачен.
 */
export function HScroll({ minWidth = 720, children }: { minWidth?: number; children: ReactNode }) {
  const m = useIsMobile();
  if (!m) return <>{children}</>;
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", WebkitOverflowScrolling: "touch" }}>
      <div style={{ minWidth, minHeight: "100%", display: "flex", flexDirection: "column" }}>{children}</div>
    </div>
  );
}
