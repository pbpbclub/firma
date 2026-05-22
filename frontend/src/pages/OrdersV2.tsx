import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ordersApi } from "../api";
import { MagnifyingGlass, DotsThree, Plus, Files, CaretRight, Archive, ArrowCounterClockwise, CaretDown, Funnel } from "@phosphor-icons/react";

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  draft:         { label: "Черновик",       color: "#A89070" },
  estimate:      { label: "Смета",          color: "#E8592A" },
  project:       { label: "Проект",         color: "#E8592A" },
  in_production: { label: "В производстве", color: "#1A1A1A" },
  completed:     { label: "Завершён",       color: "#4A7C59" },
  cancelled:     { label: "Отменён",        color: "#8B3A3A" },
};

const STATUSES = [
  { value: "", label: "Все" },
  { value: "estimate", label: "Смета" },
  { value: "in_production", label: "В работе" },
  { value: "completed", label: "Завершён" },
];

const PAGE_SIZE = 10;

function fmt(n: number) {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

function initials(name: string | undefined) {
  if (!name) return "—";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const ALL_STATUSES = [
  { value: "draft",         label: "Черновик",        color: "#A89070" },
  { value: "estimate",      label: "Смета",            color: "#E8592A" },
  { value: "project",       label: "Проект",           color: "#E8592A" },
  { value: "in_production", label: "В производстве",   color: "#1A1A1A" },
  { value: "completed",     label: "Завершён",         color: "#4A7C59" },
  { value: "cancelled",     label: "Отменён",          color: "#8B3A3A" },
];

function StatusPicker({ orderId, current, onChange }: { orderId: string; current: string; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const st = ALL_STATUSES.find(s => s.value === current) || { label: current, color: "#A89070" };

  const pick = async (value: string) => {
    if (value === current) { setOpen(false); return; }
    setSaving(true);
    try {
      await ordersApi.updateStatus(orderId, value);
      onChange();
    } finally {
      setSaving(false);
      setOpen(false);
    }
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={saving}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "5px 10px", border: "1px solid #EDEBE6", background: "none",
          fontSize: 11, cursor: "pointer", color: st.color, fontWeight: 600,
        }}
      >
        {saving ? "..." : st.label}
        <CaretDown size={10} style={{ color: "#A89070" }} />
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, marginTop: 2,
          background: "#fff", border: "1px solid #EDEBE6", zIndex: 100,
          boxShadow: "0 4px 16px rgba(0,0,0,0.12)", minWidth: 160,
        }}>
          {ALL_STATUSES.map(s => (
            <div
              key={s.value}
              onClick={() => pick(s.value)}
              style={{
                padding: "8px 14px", fontSize: 12, cursor: "pointer",
                color: s.value === current ? "#1A1A1A" : s.color,
                fontWeight: s.value === current ? 700 : 400,
                background: s.value === current ? "#FAF8F5" : "transparent",
              }}
              onMouseEnter={(e) => { if (s.value !== current) (e.currentTarget as HTMLElement).style.background = "#FAF8F5"; }}
              onMouseLeave={(e) => { if (s.value !== current) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              {s.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ColumnFilter({ options, value, onChange, maxHeight }: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  maxHeight?: number;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  useEffect(() => { if (!open) setQ(""); }, [open]);
  const filtered = q ? options.filter(o => o.toLowerCase().includes(q.toLowerCase())) : options;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", display: "flex", alignItems: "center", color: value ? "#E8592A" : "#C8C0B0" }}>
        <Funnel size={11} weight={value ? "fill" : "regular"} />
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200, background: "#FFFFFF", border: "1px solid #EDEBE6", boxShadow: "0 4px 16px rgba(0,0,0,0.10)", minWidth: 180 }}>
          <div style={{ padding: "5px 8px", borderBottom: "1px solid #F2EFE9" }}>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} onClick={e => e.stopPropagation()}
              placeholder="Поиск..." style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "4px 8px", fontSize: 12, outline: "none", fontFamily: "inherit" }} />
          </div>
          <div style={{ maxHeight: maxHeight ?? 200, overflowY: "auto" }}>
            <div onClick={() => { onChange(""); setOpen(false); }} style={{ padding: "8px 12px", fontSize: 12, cursor: "pointer", color: !value ? "#E8592A" : "#1A1A1A", fontWeight: !value ? 600 : 400, borderBottom: "1px solid #F2EFE9" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>Все</div>
            {filtered.map(opt => (
              <div key={opt} onClick={() => { onChange(opt); setOpen(false); }} style={{ padding: "8px 12px", fontSize: 12, cursor: "pointer", color: value === opt ? "#E8592A" : "#1A1A1A", fontWeight: value === opt ? 600 : 400 }}
                onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>{opt}</div>
            ))}
            {filtered.length === 0 && <div style={{ padding: "8px 12px", fontSize: 12, color: "#C8C0B0" }}>Не найдено</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function AmountFilter({ min, max, onChange }: {
  min: string; max: string;
  onChange: (min: string, max: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const active = !!min || !!max;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", display: "flex", alignItems: "center", color: active ? "#E8592A" : "#C8C0B0" }}>
        <Funnel size={11} weight={active ? "fill" : "regular"} />
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 200, background: "#FFFFFF", border: "1px solid #EDEBE6", boxShadow: "0 4px 16px rgba(0,0,0,0.10)", padding: "10px 12px", minWidth: 210 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="number" placeholder="От" value={min} onChange={e => onChange(e.target.value, max)} autoFocus
              style={{ width: 84, border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none" }} />
            <span style={{ fontSize: 12, color: "#A89070" }}>—</span>
            <input type="number" placeholder="До" value={max} onChange={e => onChange(min, e.target.value)}
              style={{ width: 84, border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none" }} />
          </div>
          {active && (
            <button onClick={() => { onChange("", ""); setOpen(false); }}
              style={{ marginTop: 8, width: "100%", padding: "5px", border: "none", background: "#FAF8F5", fontSize: 11, color: "#A89070", cursor: "pointer" }}>
              Сбросить
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function IconBtn({ onClick, children, orange }: { onClick?: () => void; children: React.ReactNode; orange?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 28, height: 28,
        background: orange ? "#E8592A" : "#F2EFE9",
        border: "none",
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: orange ? "#FFFFFF" : "#6B6355",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

export default function OrdersV2() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<any>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [archiveMode, setArchiveMode] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [customerFilter, setCustomerFilter] = useState("");
  const [titleFilter, setTitleFilter] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");

  const { data = [], isLoading } = useQuery({
    queryKey: ["orders-v2", status, search, archiveMode],
    queryFn: () => {
      const params: Record<string, string | boolean> = {};
      if (status) params.status = status;
      if (search) params.search = search;
      if (archiveMode) params.archived = true;
      return ordersApi.list(params);
    },
  });

  const handleArchive = async () => {
    if (!selected) return;
    setArchiving(true);
    try {
      if (archiveMode) {
        await ordersApi.unarchive(selected.id);
      } else {
        await ordersApi.archive(selected.id);
      }
      qc.invalidateQueries({ queryKey: ["orders-v2"] });
      setSelected(null);
    } finally {
      setArchiving(false);
    }
  };

  const { data: detail } = useQuery({
    queryKey: ["order-detail-v2", selected?.id],
    queryFn: () => ordersApi.get(selected.id),
    enabled: !!selected,
  });

  const paidTotal = detail?.payments?.reduce((s: number, p: any) => s + p.amount, 0) ?? 0;
  const pct = detail?.price_plan > 0 ? Math.min(100, (paidTotal / detail.price_plan) * 100) : 0;

  const allData = data as any[];
  const uniqueCustomers = useMemo(() => [...new Set(allData.map((r: any) => r.customer_name).filter(Boolean))].sort() as string[], [allData]);
  const uniqueTitles = useMemo(() => [...new Set(allData.map((r: any) => r.title).filter(Boolean))].sort() as string[], [allData]);
  const filteredData = useMemo(() => {
    let r = allData;
    if (customerFilter) r = r.filter((o: any) => o.customer_name === customerFilter);
    if (titleFilter) r = r.filter((o: any) => o.title === titleFilter);
    if (amountMin) r = r.filter((o: any) => (o.price_plan || 0) >= parseFloat(amountMin));
    if (amountMax) r = r.filter((o: any) => (o.price_plan || 0) <= parseFloat(amountMax));
    return r;
  }, [allData, customerFilter, titleFilter, amountMin, amountMax]);
  const totalCount = filteredData.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageData = filteredData.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const cols = selected
    ? "2fr 1.2fr 100px 120px 40px"
    : "2fr 1.5fr 120px 130px 120px 40px";

  function renderPageNums() {
    const pages: (number | "…")[] = [];
    if (totalPages <= 5) {
      for (let i = 0; i < totalPages; i++) pages.push(i);
    } else {
      pages.push(0, 1, 2);
      if (page > 3) pages.push("…");
      if (page > 2 && page < totalPages - 2) pages.push(page);
      if (page < totalPages - 3) pages.push("…");
      pages.push(totalPages - 1);
    }
    return [...new Set(pages)].map((p, i) =>
      p === "…" ? (
        <span key={`e${i}`} style={{ fontSize: 10, color: "#A89070", padding: "0 2px" }}>…</span>
      ) : (
        <button
          key={p}
          onClick={() => setPage(p as number)}
          style={{
            minWidth: 20, height: 20,
            background: "none", border: "none", cursor: "pointer",
            fontSize: 10,
            fontWeight: page === p ? 600 : 400,
            color: page === p ? "#1A1A1A" : "#A89070",
            borderBottom: page === p ? "2px solid #E8592A" : "2px solid transparent",
            padding: "0 2px",
          }}
        >
          {(p as number) + 1}
        </button>
      )
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>

      {/* ── Left: table panel ───────────────────────────── */}
      <div style={{
        flex: selected ? "0 0 58%" : "1 1 0",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        borderRight: selected ? "1px solid #EDEBE6" : "none",
        transition: "flex 0.2s ease",
      }}>

        {/* Panel header */}
        <div style={{ padding: "24px 28px 0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>
              Заказы
            </div>
            {/* Action buttons */}
            {searchOpen ? (
              <div style={{ position: "relative" }}>
                <MagnifyingGlass size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#A89070" }} />
                <input
                  autoFocus
                  style={{
                    paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6,
                    border: "1px solid #EDEBE6",
                    background: "transparent",
                    fontSize: 12, color: "#1A1A1A",
                    outline: "none", width: 180,
                    borderRadius: 0,
                  }}
                  placeholder="Поиск..."
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                  onKeyDown={(e) => { if (e.key === "Escape") { setSearchOpen(false); setSearch(""); setPage(0); } }}
                />
              </div>
            ) : (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <IconBtn onClick={() => setSearchOpen(true)}><MagnifyingGlass size={14} /></IconBtn>
                <IconBtn><Files size={14} /></IconBtn>
                <IconBtn orange><Plus size={14} /></IconBtn>
              </div>
            )}
          </div>

          {/* Status tabs */}
          <div style={{ display: "flex", gap: 24, borderBottom: "1px solid #EDEBE6" }}>
            {!archiveMode && STATUSES.map((s) => (
              <button
                key={s.value}
                onClick={() => { setStatus(s.value); setPage(0); }}
                style={{
                  fontSize: 13, padding: "0 0 12px",
                  border: "none", background: "none", cursor: "pointer",
                  color: status === s.value ? "#1A1A1A" : "#A89070",
                  fontWeight: status === s.value ? 600 : 400,
                  borderBottom: status === s.value ? "2px solid #E8592A" : "2px solid transparent",
                  marginBottom: -1,
                  transition: "all 0.15s",
                }}
              >
                {s.label}
              </button>
            ))}
            <button
              onClick={() => { setArchiveMode(!archiveMode); setStatus(""); setPage(0); setSelected(null); }}
              style={{
                fontSize: 13, padding: "0 0 12px",
                border: "none", background: "none", cursor: "pointer",
                color: archiveMode ? "#1A1A1A" : "#A89070",
                fontWeight: archiveMode ? 600 : 400,
                borderBottom: archiveMode ? "2px solid #A89070" : "2px solid transparent",
                marginBottom: -1,
                marginLeft: archiveMode ? 0 : "auto",
                transition: "all 0.15s",
                display: "flex", alignItems: "center", gap: 5,
              }}
            >
              <Archive size={12} />
              Архив
            </button>
          </div>
        </div>

        {/* Column headers */}
        <div style={{ display: "grid", gridTemplateColumns: cols, padding: "8px 28px", borderBottom: "1px solid #F7F5F1", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>НАЗВАНИЕ</span>
            <ColumnFilter options={uniqueTitles} value={titleFilter} onChange={(v) => { setTitleFilter(v); setPage(0); }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>КЛИЕНТ</span>
            <ColumnFilter options={uniqueCustomers} value={customerFilter} onChange={(v) => { setCustomerFilter(v); setPage(0); }} />
          </div>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>СТАТУС</div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>СУММА</span>
            <AmountFilter min={amountMin} max={amountMax} onChange={(mn, mx) => { setAmountMin(mn); setAmountMax(mx); setPage(0); }} />
          </div>
          {!selected && <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>К ПОЛУЧЕНИЮ</div>}
          <div />
        </div>

        {/* Rows */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {isLoading ? (
            <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 12 }}>Загружаем...</div>
          ) : pageData.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 12 }}>Заказов нет</div>
          ) : (
            pageData.map((o: any) => {
              const st = STATUS_MAP[o.status] || { label: o.status, color: "#A89070" };
              const isActive = selected?.id === o.id;
              return (
                <div
                  key={o.id}
                  onClick={() => setSelected(isActive ? null : o)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: cols,
                    padding: "10px 28px",
                    borderBottom: "1px solid #F7F5F1",
                    cursor: "pointer",
                    background: isActive ? "#E8592A" : "transparent",
                    alignItems: "center",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#FAF8F5"; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                >
                  <div style={{ fontSize: 13, fontWeight: 500, color: isActive ? "#FFFFFF" : "#1A1A1A", lineHeight: 1.4 }}>
                    {o.title}
                  </div>
                  <div style={{
                    width: 28, height: 28,
                    borderRadius: "50%",
                    background: isActive ? "rgba(255,255,255,0.25)" : "#F2EFE9",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, fontWeight: 700,
                    color: isActive ? "#FFFFFF" : "#1A1A1A",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                  }}>
                    {initials(o.customer_name)}
                  </div>
                  <div style={{ fontSize: 11, color: isActive ? "#FFFFFF" : st.color, fontWeight: 500, lineHeight: 1.4 }}>
                    {st.label}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: isActive ? "#FFFFFF" : "#1A1A1A", lineHeight: 1.4 }}>
                    {fmt(o.price_plan)}
                  </div>
                  {!selected && (
                    <div style={{ fontSize: 13, fontWeight: 600, color: isActive ? "#FFFFFF" : (o.debt > 0 ? "#E8592A" : "#C8C0B0"), lineHeight: 1.4 }}>
                      {o.debt > 0 ? fmt(o.debt) : "—"}
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <DotsThree size={14} style={{ color: isActive ? "rgba(255,255,255,0.6)" : "#C8C0B0" }} />
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer with pagination */}
        <div style={{
          padding: "8px 28px",
          borderTop: "1px solid #F7F5F1",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 10, color: "#A89070" }}>
            {totalCount > 0
              ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, totalCount)} из ${totalCount}`
              : "0 заказов"
            }
          </div>
          <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
            {renderPageNums()}
            <button
              onClick={() => setPage(p => Math.min(p + 1, totalPages - 1))}
              disabled={page >= totalPages - 1}
              style={{
                background: "none", border: "none", cursor: page >= totalPages - 1 ? "default" : "pointer",
                color: page >= totalPages - 1 ? "#D0C8C0" : "#A89070",
                display: "flex", alignItems: "center", padding: "0 2px",
              }}
            >
              <CaretRight size={11} />
            </button>
          </div>
        </div>
      </div>

      {/* ── Right: detail panel ─────────────────────────── */}
      {selected && (
        <div style={{
          flex: "0 0 42%",
          display: "flex",
          flexDirection: "column",
          animation: "slideIn 0.18s ease",
          minWidth: 0,
        }}>
          {/* Detail header */}
          <div style={{
            padding: "22px 24px 18px",
            borderBottom: "1px solid #EDEBE6",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}>
            <div>
              <div style={{ fontSize: 24, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em", maxWidth: 300 }}>
                {selected.title}
              </div>
              <div style={{ fontSize: 11, color: "#A89070", marginTop: 8 }}>
                {[selected.number ? `№ ${selected.number}` : "", selected.customer_name].filter(Boolean).join(" · ")}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
                <StatusPicker
                  orderId={selected.id}
                  current={detail?.status ?? selected.status}
                  onChange={() => {
                    qc.invalidateQueries({ queryKey: ["orders-v2"] });
                    qc.invalidateQueries({ queryKey: ["order-detail-v2", selected.id] });
                  }}
                />
                {selected.customer_id && (
                  <button
                    onClick={() => navigate(`/customers/${selected.customer_id}`)}
                    style={{ padding: "5px 10px", border: "1px solid #EDEBE6", background: "transparent", color: "#1A1A1A", fontSize: 11, cursor: "pointer" }}
                  >
                    Клиент
                  </button>
                )}
                <button
                  onClick={() => navigate(`/orders/${selected.id}/estimate`)}
                  style={{ padding: "5px 10px", border: "1px solid #E8592A", background: "transparent", color: "#E8592A", fontSize: 11, cursor: "pointer", fontWeight: 600 }}
                >
                  Смета
                </button>
                <button
                  onClick={handleArchive}
                  disabled={archiving}
                  style={{
                    padding: "5px 10px", border: "1px solid #EDEBE6", background: "transparent",
                    color: archiveMode ? "#4A7C59" : "#A89070", fontSize: 11, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 5,
                  }}
                >
                  {archiveMode
                    ? <><ArrowCounterClockwise size={11} /> Восстановить</>
                    : <><Archive size={11} /> В архив</>
                  }
                </button>
              </div>
            </div>
            <button
              onClick={() => setSelected(null)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 4, marginTop: -2 }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#1A1A1A")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#C8C0B0")}
            >
              <DotsThree size={20} />
            </button>
          </div>

          {/* Detail content */}
          <div style={{ flex: 1, overflow: "auto", padding: "24px 24px 20px" }}>

            {/* Finances */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 16, textTransform: "uppercase" }}>Финансы</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "16px 32px" }}>
                {[
                  { label: "Стоимость", value: fmt(selected.price_plan), color: "#1A1A1A" },
                  { label: "Оплачено",  value: fmt(paidTotal),           color: "#4A7C59" },
                  { label: "Долг",      value: selected.debt > 0 ? fmt(selected.debt) : "Оплачено", color: selected.debt > 0 ? "#E8592A" : "#4A7C59" },
                  { label: "Маржа",     value: fmt(selected.margin),     color: "#1A1A1A" },
                ].map((item) => (
                  <div key={item.label}>
                    <div style={{ fontSize: 10, color: "#A89070", marginBottom: 4 }}>{item.label}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: item.color }}>{item.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Progress */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#A89070", marginBottom: 8 }}>
                <span>Прогресс оплаты</span>
                <span style={{ color: "#1A1A1A", fontWeight: 600 }}>{Math.round(pct)}%</span>
              </div>
              <div style={{ height: 2, background: "#F2EFE9" }}>
                <div style={{ height: 2, background: "#E8592A", width: `${pct}%`, transition: "width 0.4s" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#A89070", marginTop: 6 }}>
                <span>{fmt(paidTotal)} оплачено</span>
                <span>{fmt(selected.price_plan)} всего</span>
              </div>
            </div>

            {/* Meta */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 16, textTransform: "uppercase" }}>Детали</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "16px 32px" }}>
                {[
                  { label: "Статус",   value: (STATUS_MAP[selected.status] || {}).label || "—" },
                  { label: "Приоритет", value: selected.priority_label || "—" },
                  { label: "Платежи",  value: String(detail?.payments?.length ?? "—") },
                  { label: "Сметы",    value: String(detail?.estimate_sets?.length ?? "—") },
                  ...(selected.deadline ? [{ label: "Дедлайн", value: fmtDate(selected.deadline) }] : []),
                ].map((item) => (
                  <div key={item.label}>
                    <div style={{ fontSize: 10, color: "#A89070", marginBottom: 4 }}>{item.label}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>{item.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Payments list */}
            {detail?.payments?.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 14, textTransform: "uppercase" }}>
                  Платежи
                </div>
                {detail.payments.slice(0, 4).map((p: any, i: number) => (
                  <div
                    key={i}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "flex-start",
                      paddingBottom: 12, marginBottom: 12,
                      borderBottom: "1px solid #F2EFE9",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>{fmt(p.amount)}</div>
                      {p.note && <div style={{ fontSize: 10, color: "#A89070", marginTop: 2 }}>{p.note}</div>}
                    </div>
                    <div style={{ fontSize: 10, color: "#A89070" }}>{fmtDate(p.paid_at)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(10px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
