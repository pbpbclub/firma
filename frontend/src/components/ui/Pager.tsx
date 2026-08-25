// Пагинация списка: счётчик, выбор размера страницы (запоминается) и номера страниц.
// Общий для экранов со списками — сделан по образцу футера Вики.
import { useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { useIsMobile } from "./responsive";

export const PAGE_SIZE_OPTIONS = [25, 50, 100, 0];   // 0 = «Все»

/** Состояние пагинации со срезом. storageKey — чтобы выбор пережил перезагрузку. */
export function usePager(totalCount: number, storageKey: string, defaultSize = 50) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(() => {
    const raw = localStorage.getItem(storageKey);
    // Number(null) === 0, а 0 — это «Все»: без проверки на null дефолт был бы «Все».
    const saved = raw === null ? NaN : Number(raw);
    return PAGE_SIZE_OPTIONS.includes(saved) ? saved : defaultSize;
  });
  const changePageSize = (n: number) => {
    setPageSize(n); setPage(0); localStorage.setItem(storageKey, String(n));
  };
  const size = pageSize || Math.max(totalCount, 1);        // «Все» — одним срезом
  const totalPages = Math.max(1, Math.ceil(totalCount / size));
  const safePage = Math.min(page, totalPages - 1);         // фильтры укоротили список
  const slice = <T,>(items: T[]) => items.slice(safePage * size, (safePage + 1) * size);
  return { page: safePage, setPage, pageSize, changePageSize, size, totalPages, slice };
}

export function Pager({ pager, totalCount, truncated }: {
  pager: ReturnType<typeof usePager>;
  totalCount: number;
  truncated?: boolean;
}) {
  const { page, setPage, pageSize, changePageSize, size, totalPages } = pager;
  const isMobile = useIsMobile();
  const btnPad = isMobile ? "8px 8px" : "0 1px";
  const nums: (number | "…")[] = [];
  if (totalPages <= 5) for (let i = 0; i < totalPages; i++) nums.push(i);
  else {
    nums.push(0);
    if (page > 2) nums.push("…");
    if (page > 1 && page < totalPages - 1) nums.push(page);
    if (page < totalPages - 2) nums.push("…");
    nums.push(totalPages - 1);
  }
  return (
    <div style={{ padding: isMobile ? "6px 16px" : "8px 28px", borderTop: "1px solid #F7F5F1", display: "flex",
                  justifyContent: "space-between", alignItems: "center", flexShrink: 0,
                  flexWrap: isMobile ? "wrap" : undefined, gap: isMobile ? 8 : 0 }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center", fontSize: isMobile ? 11 : 10, color: "#A89070", flexWrap: isMobile ? "wrap" : undefined }}>
        <span>
          {totalCount > 0 ? `${page * size + 1}–${Math.min((page + 1) * size, totalCount)} из ${totalCount}` : "0"}
          {truncated && <span style={{ color: "#8B3A3A" }}> · показаны не все, уточни период</span>}
        </span>
        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ letterSpacing: "0.06em" }}>НА СТРАНИЦЕ</span>
          {PAGE_SIZE_OPTIONS.map(n => (
            <button type="button" key={n} onClick={() => changePageSize(n)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: btnPad, fontSize: isMobile ? 12 : 10,
                       fontFamily: "inherit", fontWeight: pageSize === n ? 600 : 400,
                       color: pageSize === n ? "#1A1A1A" : "#A89070",
                       borderBottom: pageSize === n ? "2px solid #E8592A" : "2px solid transparent" }}>
              {n === 0 ? "Все" : n}
            </button>
          ))}
        </span>
      </div>
      {totalPages > 1 && (
        <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
          {[...new Set(nums)].map((p, i) =>
            p === "…" ? (
              <span key={`e${i}`} style={{ fontSize: 10, color: "#C8C0B0", padding: "0 2px" }}>…</span>
            ) : (
              <button type="button" key={p} onClick={() => setPage(p as number)}
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: isMobile ? 12 : 10,
                         fontFamily: "inherit", fontWeight: page === p ? 600 : 400,
                         color: page === p ? "#1A1A1A" : "#A89070", padding: isMobile ? "8px 10px" : "0 2px",
                         borderBottom: page === p ? "2px solid #E8592A" : "2px solid transparent" }}>
                {(p as number) + 1}
              </button>
            ))}
          <button type="button" onClick={() => setPage(p => Math.min(p + 1, totalPages - 1))} disabled={page >= totalPages - 1}
            style={{ background: "none", border: "none", display: "flex", alignItems: "center", padding: isMobile ? "8px 10px" : "0 2px",
                     cursor: page >= totalPages - 1 ? "default" : "pointer",
                     color: page >= totalPages - 1 ? "#D0C8C0" : "#A89070" }}>
            <CaretRight size={11} />
          </button>
        </div>
      )}
    </div>
  );
}
