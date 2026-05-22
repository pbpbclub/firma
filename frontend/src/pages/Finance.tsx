import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { financeApi } from "../api";
import { MagnifyingGlass, Funnel } from "@phosphor-icons/react";

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

function DateFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
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
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", display: "flex", alignItems: "center", color: value ? "#E8592A" : "#C8C0B0" }}>
        <Funnel size={11} weight={value ? "fill" : "regular"} />
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200, background: "#FFFFFF", border: "1px solid #EDEBE6", boxShadow: "0 4px 16px rgba(0,0,0,0.10)", padding: "10px 12px", minWidth: 190 }}>
          <input type="date" value={value} onChange={e => onChange(e.target.value)} autoFocus
            style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "6px 8px", fontSize: 12, color: "#1A1A1A", outline: "none" }} />
          {value && (
            <button onClick={() => { onChange(""); setOpen(false); }}
              style={{ marginTop: 8, width: "100%", padding: "5px", border: "none", background: "#FAF8F5", fontSize: 11, color: "#A89070", cursor: "pointer" }}>
              Сбросить
            </button>
          )}
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

function BankBadge({ bank }: { bank: string }) {
  const cfg: Record<string, { bg: string; text: string; color: string }> = {
    tbank: { bg: "#FFDD2D", text: "Т", color: "#1A1A1A" },
    sber:  { bg: "#21A038", text: "С", color: "#FFFFFF" },
    fund:  { bg: "#E8E4DA", text: "Ф", color: "#A89070" },
  };
  const c = cfg[bank] ?? { bg: "#EDEBE6", text: "?", color: "#6B6355" };
  return (
    <div style={{ width: 22, height: 22, borderRadius: "50%", background: c.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, color: c.color, flexShrink: 0 }}>
      {c.text}
    </div>
  );
}

function fmt(n: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.abs(n)) + " ₽";
}

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

const FILTERS = [
  { v: "", l: "Все" },
  { v: "in", l: "Поступления" },
  { v: "out", l: "Списания" },
];

export default function Finance() {
  const [direction, setDirection] = useState("");
  const [search, setSearch] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [descFilter, setDescFilter] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");

  const { data: balance } = useQuery({ queryKey: ["balance"], queryFn: financeApi.balance });
  const { data: summary } = useQuery({ queryKey: ["dds-summary"], queryFn: financeApi.summary });
  const { data: txs = [], isLoading } = useQuery({
    queryKey: ["transactions", direction, search],
    queryFn: () => {
      const p: Record<string, string> = {};
      if (direction) p.direction = direction;
      if (search) p.search = search;
      return financeApi.transactions(p);
    },
  });

  const uniqueDescs = useMemo(
    () => [...new Set((txs as any[]).map((t: any) => t.counterparty || t.purpose || (t.source === "fund" ? t.fund_name : null)).filter(Boolean))].sort() as string[],
    [txs]
  );

  const filteredTxs = useMemo(() => {
    return (txs as any[]).filter((t: any) => {
      if (accountFilter) {
        if (accountFilter === "Фонды" && t.source !== "fund") return false;
        if (accountFilter === "Т-Банк" && t.bank !== "tbank") return false;
        if (accountFilter === "Сбербанк" && t.bank !== "sber") return false;
        if (accountFilter !== "Фонды" && accountFilter !== "Т-Банк" && accountFilter !== "Сбербанк") return false;
      }
      if (dateFilter && t.date !== dateFilter) return false;
      if (descFilter) {
        const desc = t.counterparty || t.purpose || (t.source === "fund" ? t.fund_name : "") || "";
        if (desc !== descFilter) return false;
      }
      if (amountMin && t.amount < parseFloat(amountMin)) return false;
      if (amountMax && t.amount > parseFloat(amountMax)) return false;
      return true;
    });
  }, [txs, accountFilter, dateFilter, descFilter, amountMin, amountMax]);

  const monthly: any[] = summary?.monthly_chart || [];
  const maxVal = monthly.length > 0 ? Math.max(...monthly.map((m: any) => Math.max(m.income, m.expense))) : 0;

  const totalIn  = summary?.total_in  ?? 0;
  const totalOut = summary?.total_out ?? 0;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>

      {/* ── Left: transactions ──────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, borderRight: "1px solid #EDEBE6" }}>

        {/* Header */}
        <div style={{ padding: "24px 28px 0", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>ДДС</div>
          </div>

          {/* Filter tabs */}
          <div style={{ display: "flex", gap: 24, borderBottom: "1px solid #EDEBE6" }}>
            {FILTERS.map((f) => (
              <button
                key={f.v}
                onClick={() => setDirection(f.v)}
                style={{
                  fontSize: 13, padding: "0 0 12px",
                  border: "none", background: "none", cursor: "pointer",
                  color: direction === f.v ? "#1A1A1A" : "#A89070",
                  fontWeight: direction === f.v ? 600 : 400,
                  borderBottom: direction === f.v ? "2px solid #E8592A" : "2px solid transparent",
                  marginBottom: -1,
                }}
              >
                {f.l}
              </button>
            ))}
            <div style={{ marginLeft: "auto", paddingBottom: 8, display: "flex", alignItems: "center" }}>
              <div style={{ position: "relative" }}>
                <MagnifyingGlass size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#A89070" }} />
                <input
                  style={{
                    paddingLeft: 28, paddingRight: 10, paddingTop: 5, paddingBottom: 5,
                    border: "1px solid #EDEBE6", background: "transparent",
                    fontSize: 12, color: "#1A1A1A", outline: "none", width: 180, borderRadius: 0,
                  }}
                  placeholder="Поиск..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Column headers */}
        <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 120px 120px", padding: "8px 28px", borderBottom: "1px solid #EDEBE6", flexShrink: 0, alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ДАТА</span>
            <DateFilter value={dateFilter} onChange={setDateFilter} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ОПИСАНИЕ</span>
            <ColumnFilter options={uniqueDescs} value={descFilter} onChange={setDescFilter} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>СЧЁТ</span>
            <ColumnFilter options={["Т-Банк", "Сбербанк", "Фонды"]} value={accountFilter} onChange={setAccountFilter} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>СУММА</span>
            <AmountFilter min={amountMin} max={amountMax} onChange={(mn, mx) => { setAmountMin(mn); setAmountMax(mx); }} />
          </div>
        </div>

        {/* Rows */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {isLoading ? (
            <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>
          ) : filteredTxs.length === 0 ? (
            <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Транзакций нет</div>
          ) : (
            filteredTxs.map((t: any, i: number) => (
              <div
                key={t.id || i}
                style={{
                  display: "grid", gridTemplateColumns: "110px 1fr 120px 120px",
                  padding: "11px 28px", borderBottom: "1px solid #F2EFE9",
                  alignItems: "center", transition: "background 0.1s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#FAF8F5")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div style={{ fontSize: 12, color: "#A89070" }}>{fmtDate(t.date)}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                  <BankBadge bank={t.bank || t.source || ""} />
                  <div style={{ fontSize: 13, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.source === "fund"
                      ? (t.counterparty || t.purpose || `Фонд: ${t.fund_name}`)
                      : (t.counterparty || t.purpose || "—")}
                  </div>
                </div>
                <div style={{ fontSize: 12 }}>
                  {t.source === "fund"
                    ? <span style={{ color: "#A89070", background: "#F2EFE9", padding: "1px 6px", fontSize: 10, fontWeight: 600 }}>
                        {t.fund_name}
                      </span>
                    : <span style={{ color: "#A89070" }}>
                        {t.bank === "tbank" ? "Т-Банк" : t.bank === "sber" ? "Сбербанк" : t.bank || "—"}
                      </span>
                  }
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: t.direction === "in" ? "#4A7C59" : "#8B3A3A" }}>
                  {t.direction === "in" ? "+" : "−"}{fmt(t.amount)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Right: summary panel ────────────────────────── */}
      <div style={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", overflowY: "auto" }}>

        {/* Total balance */}
        <div style={{ padding: "24px 20px 20px", borderBottom: "1px solid #EDEBE6" }}>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 8 }}>ИТОГО НА СЧЕТАХ</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: (balance?.total ?? 0) >= 0 ? "#4A7C59" : "#8B3A3A", letterSpacing: "-0.02em" }}>
            {fmt(balance?.total ?? 0)}
          </div>
        </div>

        {/* Per-account */}
        {balance?.accounts?.map((a: any) => (
          <div key={a.account} style={{ padding: "14px 20px", borderBottom: "1px solid #F2EFE9" }}>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em", marginBottom: 6 }}>
              {(a.name || a.account).toUpperCase()}
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#1A1A1A" }}>{fmt(a.balance)}</div>
          </div>
        ))}

        {/* Period summary */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #EDEBE6" }}>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 12 }}>ПЕРИОД</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "#A89070" }}>Поступления</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#4A7C59" }}>+{fmt(totalIn)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "#A89070" }}>Списания</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#8B3A3A" }}>−{fmt(totalOut)}</span>
            </div>
            <div style={{ height: 1, background: "#EDEBE6" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "#A89070" }}>Чистый поток</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: (totalIn - totalOut) >= 0 ? "#4A7C59" : "#8B3A3A" }}>
                {(totalIn - totalOut) >= 0 ? "+" : "−"}{fmt(totalIn - totalOut)}
              </span>
            </div>
          </div>
        </div>

        {/* Monthly chart */}
        {monthly.length > 0 && (
          <div style={{ padding: "16px 20px", borderBottom: "1px solid #EDEBE6" }}>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 12 }}>ПО МЕСЯЦАМ</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 60 }}>
              {monthly.map((m: any) => {
                const incH = maxVal > 0 ? (m.income / maxVal) * 56 : 0;
                const expH = maxVal > 0 ? (m.expense / maxVal) * 56 : 0;
                return (
                  <div key={m.month} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                    <div style={{ display: "flex", gap: 1, alignItems: "flex-end", height: 56 }}>
                      <div style={{ width: 5, background: "#4A7C59", height: incH }} title={fmt(m.income)} />
                      <div style={{ width: 5, background: "#EDEBE6", height: expH }} title={fmt(m.expense)} />
                    </div>
                    <div style={{ fontSize: 8, color: "#A89070" }}>{m.month.slice(5)}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
              {[{ color: "#4A7C59", label: "Приход" }, { color: "#EDEBE6", label: "Расход", border: "#C8C0B0" }].map((l) => (
                <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#A89070" }}>
                  <div style={{ width: 7, height: 7, background: l.color, border: l.border ? `1px solid ${l.border}` : "none" }} />
                  {l.label}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
