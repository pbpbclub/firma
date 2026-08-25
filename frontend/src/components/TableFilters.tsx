import { useState, useRef, useEffect } from "react";
import { SortMark, type SortState } from "./ui/sort";
import { useIsMobile } from "./ui/responsive";

// Опциональная сортировка колонки: стрелка справа от заголовка-фильтра.
// Клик по самому заголовку занят поповером фильтра, поэтому — отдельная кнопка.
export type HeaderSort = { colKey: string; sort: SortState; onToggle: (key: string) => void };

// Заголовок-кнопка с подчёркиванием: пунктир = фильтруемый, сплошной оранжевый = активный
function triggerStyle(active: boolean, align?: "left" | "right"): React.CSSProperties {
  return {
    background: "none", border: "none", cursor: "pointer", padding: 0,
    fontSize: 11, letterSpacing: "0.04em", whiteSpace: "nowrap", fontFamily: "inherit",
    color: active ? "#E8592A" : "#A89070",
    borderBottom: active ? "1px solid #E8592A" : "1px dashed #C8C0B0",
    textAlign: align ?? "left",
  };
}

function useClickOutside(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open, onClose]);
  return ref;
}

const popBase = (align?: "left" | "right", isMobile = false): React.CSSProperties => isMobile
  // Телефон: лист над нижней панелью, на всю ширину. Абсолютный поповер с
  // minWidth 180–230 у правых колонок уходил за край экрана внутри overflow:auto
  // и был недостижим.
  ? { position: "fixed", left: 12, right: 12, bottom: "calc(56px + env(safe-area-inset-bottom) + 8px)",
      zIndex: 300, background: "#FFFFFF", border: "1px solid #EDEBE6", maxHeight: "60dvh", overflowY: "auto",
      boxShadow: "0 -4px 24px rgba(0,0,0,0.14)" }
  : { position: "absolute", top: "calc(100% + 4px)", [align === "right" ? "right" : "left"]: 0,
      zIndex: 200, background: "#FFFFFF", border: "1px solid #EDEBE6",
      boxShadow: "0 4px 16px rgba(0,0,0,0.10)" };

// Подложка под мобильным листом. Рендерится ВНУТРИ ref-контейнера, чтобы
// useClickOutside не считал тап по ней «снаружи» и не закрывал лист дважды.
const Backdrop = ({ onClose }: { onClose: () => void }) => (
  <div onClick={(e) => { e.stopPropagation(); onClose(); }}
    style={{ position: "fixed", inset: 0, zIndex: 299, background: "rgba(0,0,0,0.25)" }} />
);

// ─── Категориальный фильтр ───────────────────────────────────────────────────

export function ColumnFilter({ label, options, value, onChange, align, maxHeight, sort }: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
  align?: "left" | "right";
  maxHeight?: number;
  sort?: HeaderSort;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const isMobile = useIsMobile();
  const ref = useClickOutside(open, () => setOpen(false));
  useEffect(() => { if (!open) setQ(""); }, [open]);
  const filtered = q ? options.filter(o => o.toLowerCase().includes(q.toLowerCase())) : options;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }} style={triggerStyle(!!value, align)}>
        {label}
      </button>
      {sort && <SortMark colKey={sort.colKey} sort={sort.sort} onToggle={sort.onToggle} />}
      {open && isMobile && <Backdrop onClose={() => setOpen(false)} />}
      {open && (
        <div style={{ ...popBase(align, isMobile), minWidth: 180 }}>
          <div style={{ padding: "5px 8px", borderBottom: "1px solid #F2EFE9" }}>
            <input autoFocus={!isMobile} value={q} onChange={e => setQ(e.target.value)} onClick={e => e.stopPropagation()}
              placeholder="Поиск..." style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "4px 8px", fontSize: 12, outline: "none", fontFamily: "inherit" }} />
          </div>
          <div style={{ maxHeight: maxHeight ?? 200, overflowY: "auto" }}>
            <div onClick={() => { onChange(""); setOpen(false); }} style={{ padding: isMobile ? "12px 14px" : "8px 12px", fontSize: isMobile ? 14 : 12, cursor: "pointer", color: !value ? "#E8592A" : "#1A1A1A", fontWeight: !value ? 600 : 400, borderBottom: "1px solid #F2EFE9" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>Все</div>
            {filtered.map(opt => (
              <div key={opt} onClick={() => { onChange(opt); setOpen(false); }} style={{ padding: isMobile ? "12px 14px" : "8px 12px", fontSize: isMobile ? 14 : 12, cursor: "pointer", color: value === opt ? "#E8592A" : "#1A1A1A", fontWeight: value === opt ? 600 : 400 }}
                onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>{opt}</div>
            ))}
            {filtered.length === 0 && <div style={{ padding: "8px 12px", fontSize: 12, color: "#C8C0B0" }}>Не найдено</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Диапазон сумм ───────────────────────────────────────────────────────────

export function AmountFilter({ label, min, max, onChange, align, sort }: {
  label: string;
  min: string; max: string;
  onChange: (min: string, max: string) => void;
  align?: "left" | "right";
  sort?: HeaderSort;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const ref = useClickOutside(open, () => setOpen(false));
  const active = !!min || !!max;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }} style={triggerStyle(active, align)}>
        {label}
      </button>
      {sort && <SortMark colKey={sort.colKey} sort={sort.sort} onToggle={sort.onToggle} />}
      {open && isMobile && <Backdrop onClose={() => setOpen(false)} />}
      {open && (
        <div style={{ ...popBase(align, isMobile), padding: "10px 12px", minWidth: 210 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="number" placeholder="От" value={min} onChange={e => onChange(e.target.value, max)} autoFocus={!isMobile}
              style={{ width: isMobile ? "100%" : 84, minWidth: 0, border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none" }} />
            <span style={{ fontSize: 12, color: "#A89070" }}>—</span>
            <input type="number" placeholder="До" value={max} onChange={e => onChange(min, e.target.value)}
              style={{ width: isMobile ? "100%" : 84, minWidth: 0, border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none" }} />
          </div>
          {active && (
            <button type="button" onClick={() => { onChange("", ""); setOpen(false); }}
              style={{ marginTop: 8, width: "100%", padding: "5px", border: "none", background: "#FAF8F5", fontSize: 11, color: "#A89070", cursor: "pointer" }}>
              Сбросить
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Диапазон дат ────────────────────────────────────────────────────────────

export function PeriodFilter({ label, from, to, onChange, align }: {
  label: string;
  from: string; to: string;
  onChange: (from: string, to: string) => void;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const ref = useClickOutside(open, () => setOpen(false));
  const active = !!from || !!to;
  function iso(d: Date) { return d.toISOString().slice(0, 10); }
  const PRESETS = [
    { label: "Неделя",       get: (): [string,string] => { const d = new Date(); d.setDate(d.getDate()-6); return [iso(d), iso(new Date())]; } },
    { label: "30 дней",      get: (): [string,string] => { const d = new Date(); d.setDate(d.getDate()-29); return [iso(d), iso(new Date())]; } },
    { label: "Этот мес",     get: (): [string,string] => { const n = new Date(); return [`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-01`, iso(n)]; } },
    { label: "Прошлый мес",  get: (): [string,string] => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth()-1, 1)), iso(new Date(n.getFullYear(), n.getMonth(), 0))]; } },
    { label: "Квартал",      get: (): [string,string] => { const n = new Date(); const q = Math.floor(n.getMonth()/3); return [iso(new Date(n.getFullYear(), q*3, 1)), iso(n)]; } },
    { label: "Прошлый кв",   get: (): [string,string] => { const n = new Date(); const q = Math.floor(n.getMonth()/3); const pq = q === 0 ? 3 : q-1; const y = q === 0 ? n.getFullYear()-1 : n.getFullYear(); return [iso(new Date(y, pq*3, 1)), iso(new Date(y, pq*3+3, 0))]; } },
    { label: "Этот год",     get: (): [string,string] => { const n = new Date(); return [`${n.getFullYear()}-01-01`, iso(n)]; } },
    { label: "Прошлый год",  get: (): [string,string] => { const y = new Date().getFullYear()-1; return [`${y}-01-01`, `${y}-12-31`]; } },
  ];
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }} style={triggerStyle(active, align)}>
        {label}
      </button>
      {open && isMobile && <Backdrop onClose={() => setOpen(false)} />}
      {open && (
        <div style={{ ...popBase(align, isMobile), minWidth: 230 }}>
          <div style={{ padding: "8px 10px 6px", borderBottom: "1px solid #F2EFE9", display: "flex", flexWrap: "wrap", gap: 4 }}>
            {PRESETS.map(p => (
              <button type="button" key={p.label}
                onClick={() => { const [f,t] = p.get(); onChange(f,t); setOpen(false); }}
                style={{ fontSize: isMobile ? 12 : 10, padding: isMobile ? "8px 12px" : "3px 8px", border: "1px solid #EDEBE6", background: "none", cursor: "pointer", color: "#6B6355" }}
                onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
                onMouseLeave={e => (e.currentTarget.style.background = "none")}
              >{p.label}</button>
            ))}
          </div>
          <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10, color: "#A89070", width: 18, flexShrink: 0 }}>с</span>
              <input type="date" value={from} onChange={e => onChange(e.target.value, to)}
                style={{ flex: 1, border: "1px solid #EDEBE6", padding: "5px 6px", fontSize: 11, outline: "none", color: "#1A1A1A" }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10, color: "#A89070", width: 18, flexShrink: 0 }}>по</span>
              <input type="date" value={to} onChange={e => onChange(from, e.target.value)}
                style={{ flex: 1, border: "1px solid #EDEBE6", padding: "5px 6px", fontSize: 11, outline: "none", color: "#1A1A1A" }} />
            </div>
          </div>
          {active && (
            <button type="button" onClick={() => { onChange("", ""); setOpen(false); }}
              style={{ width: "100%", padding: "6px", border: "none", borderTop: "1px solid #F2EFE9", background: "#FAF8F5", fontSize: 11, color: "#A89070", cursor: "pointer" }}>
              Сбросить
            </button>
          )}
        </div>
      )}
    </div>
  );
}
