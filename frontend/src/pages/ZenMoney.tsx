import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Briefcase, MagnifyingGlass, Funnel, X } from "@phosphor-icons/react";
import { zenmoneyApi } from "../api";

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

function PeriodFilter({ from, to, onChange }: {
  from: string; to: string;
  onChange: (from: string, to: string) => void;
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
      <button onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", display: "flex", alignItems: "center", color: active ? "#E8592A" : "#C8C0B0" }}>
        <Funnel size={11} weight={active ? "fill" : "regular"} />
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200, background: "#FFFFFF", border: "1px solid #EDEBE6", boxShadow: "0 4px 16px rgba(0,0,0,0.10)", minWidth: 230 }}>
          <div style={{ padding: "8px 10px 6px", borderBottom: "1px solid #F2EFE9", display: "flex", flexWrap: "wrap", gap: 4 }}>
            {PRESETS.map(p => (
              <button key={p.label}
                onClick={() => { const [f,t] = p.get(); onChange(f,t); setOpen(false); }}
                style={{ fontSize: 10, padding: "3px 8px", border: "1px solid #EDEBE6", background: "none", cursor: "pointer", color: "#6B6355" }}
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
            <button onClick={() => { onChange("", ""); setOpen(false); }}
              style={{ width: "100%", padding: "6px", border: "none", borderTop: "1px solid #F2EFE9", background: "#FAF8F5", fontSize: 11, color: "#A89070", cursor: "pointer" }}>
              Сбросить
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const fmt = (n: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.abs(n));

const BANK_MAP: Array<{ name: string; match: (t: string) => boolean; bg: string; text: string; color: string }> = [
  {
    name: "Т-Банк",
    match: t => ["all airlines", "black", "тинькофф платинум", "т-мобайл", "брокерский счёт"].includes(t)
              || t.includes("тинькофф") || t.includes("tinkoff"),
    bg: "#FFDD2D", text: "Т", color: "#1A1A1A",
  },
  {
    name: "Сбер",
    match: t => ["mastercard mass", "универсальный на 5 лет", "накопительный счёт",
                 "сберегательный счет", "кредитная сберкарта", "платёжный счёт"].includes(t)
              || t.includes("сбер") || t.includes("sber"),
    bg: "#21A038", text: "С", color: "#FFFFFF",
  },
  {
    name: "Альфа",
    match: t => t === "текущий счёт" || t.includes("альфа") || t.includes("alfa"),
    bg: "#EF3124", text: "А", color: "#FFFFFF",
  },
  {
    name: "Наличные",
    match: t => t === "cash" || t.includes("наличн"),
    bg: "#E8E4DA", text: "₽", color: "#6B6355",
  },
];

function detectBank(title: string): { name: string; bg: string; text: string; color: string } {
  const t = (title || "").toLowerCase().trim();
  const found = BANK_MAP.find(b => b.match(t));
  if (found) return { name: found.name, bg: found.bg, text: found.text, color: found.color };
  const letter = (title || "?")[0].toUpperCase();
  return { name: letter, bg: "#EDEBE6", text: letter, color: "#6B6355" };
}

function BankBadge({ title }: { title: string }) {
  const c = detectBank(title);
  return (
    <div style={{ width: 22, height: 22, borderRadius: "50%", background: c.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, color: c.color, flexShrink: 0 }} title={title}>
      {c.text}
    </div>
  );
}

function Checkbox({ checked, indeterminate = false, onChange }: {
  checked: boolean; indeterminate?: boolean; onChange: () => void;
}) {
  return (
    <div onClick={e => { e.stopPropagation(); onChange(); }} style={{
      width: 14, height: 14, flexShrink: 0, cursor: "pointer",
      border: `1.5px solid ${checked || indeterminate ? "#E8592A" : "#D0C8C0"}`,
      background: checked ? "#E8592A" : "transparent",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      {checked && <svg width="8" height="6" viewBox="0 0 8 6" fill="none"><path d="M1 3L3 5.5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      {!checked && indeterminate && <div style={{ width: 8, height: 1.5, background: "#E8592A" }} />}
    </div>
  );
}

const MONTHS_RU = ["Янв","Фев","Мар","Апр","Май","Июн","Июл","Авг","Сен","Окт","Ноя","Дек"];

function getMonthLabel(ym: string) {
  const [y, m] = ym.split("-");
  return `${MONTHS_RU[parseInt(m) - 1]} ${y.slice(2)}`;
}

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export default function ZenMoneyPage() {
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonth);
  const [showBusiness, setShowBusiness] = useState(false);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [payeeFilter, setPayeeFilter] = useState("");
  const [amountFilter, setAmountFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [bankFilter, setBankFilter] = useState("");
  const clearFilters = () => { setBankFilter(""); setCatFilter(""); setPayeeFilter(""); setAmountFilter(""); setDateFrom(""); setDateTo(""); setSelectedIds(new Set()); };
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const ZM_GRID = "28px 80px 36px 1fr 110px 100px";

  const AMOUNT_RANGES = [
    { label: "до 1 000 ₽",     test: (a: number) => a < 1000 },
    { label: "1 000–5 000 ₽",  test: (a: number) => a >= 1000 && a < 5000 },
    { label: "5 000–20 000 ₽", test: (a: number) => a >= 5000 && a < 20000 },
    { label: "свыше 20 000 ₽", test: (a: number) => a >= 20000 },
  ];

  const { data: accounts = [] } = useQuery({
    queryKey: ["zm-accounts"],
    queryFn: zenmoneyApi.accounts,
  });

  const { data: cashflow = [] } = useQuery({
    queryKey: ["zm-cashflow"],
    queryFn: () => zenmoneyApi.cashflow(6),
  });

  const { data: report } = useQuery({
    queryKey: ["zm-report", selectedMonth],
    queryFn: () => zenmoneyApi.report(selectedMonth),
  });

  const { data: allTransactions = [] } = useQuery({
    queryKey: ["zm-transactions", selectedMonth, search],
    queryFn: () =>
      zenmoneyApi.transactions({
        month: selectedMonth,
        ...(search ? { search } : {}),
        limit: 300,
      }),
    enabled: !showBusiness,
  });

  const { data: businessTx = [] } = useQuery({
    queryKey: ["zm-business"],
    queryFn: () => zenmoneyApi.business(3),
    enabled: showBusiness,
  });

  const monthOptions = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    });
  }, []);

  // Exclude transfers
  const transactions = (allTransactions as any[]).filter(
    (t: any) => !(t.income > 0 && t.outcome > 0)
  );

  const displayTx: any[] = showBusiness ? (businessTx as any[]) : transactions;

  const uniqueCats = useMemo(
    () => [...new Set(displayTx.map((t: any) => t.tags?.[0]).filter(Boolean))].sort() as string[],
    [displayTx]
  );
  const uniquePayees = useMemo(
    () => [...new Set(displayTx.map((t: any) => t.payee || t.comment).filter(Boolean))].sort() as string[],
    [displayTx]
  );
  const uniqueBanks = useMemo(() => {
    const isExpense = (t: any) => t.outcome > 0 && t.income === 0;
    const names = displayTx.map((t: any) =>
      detectBank(isExpense(t) ? (t.outcome_account || "") : (t.income_account || "")).name
    );
    return [...new Set(names)].sort() as string[];
  }, [displayTx]);

  const filteredTx = useMemo(() => {
    let result = displayTx;
    if (bankFilter) result = result.filter((t: any) => {
      const isExp = t.outcome > 0 && t.income === 0;
      return detectBank(isExp ? (t.outcome_account || "") : (t.income_account || "")).name === bankFilter;
    });
    if (catFilter) result = result.filter((t: any) => t.tags?.[0] === catFilter);
    if (payeeFilter) result = result.filter((t: any) => (t.payee || t.comment) === payeeFilter);
    if (amountFilter) {
      const range = AMOUNT_RANGES.find(r => r.label === amountFilter);
      if (range) result = result.filter((t: any) => {
        const amount = t.outcome > 0 ? t.outcome : t.income;
        return range.test(amount);
      });
    }
    if (dateFrom) result = result.filter((t: any) => t.date >= dateFrom);
    if (dateTo) result = result.filter((t: any) => t.date <= dateTo);
    return result;
  }, [displayTx, bankFilter, catFilter, payeeFilter, amountFilter, dateFrom, dateTo]);

  // Chart
  const maxVal = Math.max(...(cashflow as any[]).map((r: any) => Math.max(r.incomes, r.expenses)), 1);
  const CHART_H = 60;

  // Total balance
  const totalBalance = (accounts as any[]).reduce((s: number, a: any) => s + (a.balance || 0), 0);

  // Business stats
  const bizExpense = (businessTx as any[])
    .filter((t: any) => t.outcome > 0 && t.income === 0)
    .reduce((s: number, t: any) => s + t.outcome, 0);
  const bizIncome = (businessTx as any[])
    .filter((t: any) => t.income > 0 && t.outcome === 0)
    .reduce((s: number, t: any) => s + t.income, 0);

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>

      {/* ── Left: transactions panel ──────────────────────────── */}
      <div style={{
        flex: "1 1 0",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        borderRight: "1px solid #EDEBE6",
      }}>
        {/* Header */}
        <div style={{ padding: "24px 28px 0", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>
              Личные финансы
            </div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              {/* Month picker */}
              {!showBusiness && (
                <select
                  value={selectedMonth}
                  onChange={(e) => setSelectedMonth(e.target.value)}
                  style={{
                    fontSize: 12,
                    border: "1px solid #EDEBE6",
                    background: "none",
                    color: "#1A1A1A",
                    padding: "4px 8px",
                    cursor: "pointer",
                    outline: "none",
                  }}
                >
                  {monthOptions.map((m) => (
                    <option key={m} value={m}>{getMonthLabel(m)}</option>
                  ))}
                </select>
              )}

              {/* Search */}
              {!showBusiness && (
                <div style={{ position: "relative" }}>
                  <MagnifyingGlass
                    size={12}
                    style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#A89070" }}
                  />
                  <input
                    type="text"
                    placeholder="Поиск..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{
                      border: "1px solid #EDEBE6",
                      paddingLeft: 26,
                      paddingRight: 8,
                      paddingTop: 4,
                      paddingBottom: 4,
                      fontSize: 12,
                      color: "#1A1A1A",
                      background: "none",
                      outline: "none",
                      width: 160,
                    }}
                  />
                </div>
              )}

              {/* Toggle */}
              <button
                onClick={() => setShowBusiness(false)}
                style={{
                  padding: "4px 12px", fontSize: 12,
                  border: "1px solid #EDEBE6",
                  background: !showBusiness ? "#1A1A1A" : "none",
                  color: !showBusiness ? "#FFFFFF" : "#A89070",
                  cursor: "pointer",
                }}
              >
                Все
              </button>
              <button
                onClick={() => setShowBusiness(true)}
                style={{
                  padding: "4px 12px", fontSize: 12,
                  border: `1px solid ${showBusiness ? "#E8592A" : "#EDEBE6"}`,
                  background: showBusiness ? "#E8592A" : "none",
                  color: showBusiness ? "#FFFFFF" : "#A89070",
                  cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 5,
                }}
              >
                <Briefcase size={12} />
                Бизнес
              </button>
            </div>
          </div>

          {/* Month summary strip */}
          {!showBusiness && report && (
            <div style={{
              display: "flex", gap: 32, marginBottom: 16,
              paddingBottom: 16, borderBottom: "1px solid #EDEBE6",
            }}>
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>РАСХОДЫ</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#8B3A3A" }}>
                  {fmt(report.expenses)} ₽
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>ДОХОДЫ</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#4A7C59" }}>
                  {fmt(report.incomes)} ₽
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>БАЛАНС</div>
                <div style={{
                  fontSize: 18, fontWeight: 700,
                  color: report.incomes - report.expenses >= 0 ? "#4A7C59" : "#8B3A3A",
                }}>
                  {report.incomes - report.expenses >= 0 ? "+" : "−"}
                  {fmt(report.incomes - report.expenses)} ₽
                </div>
              </div>
              <div style={{ marginLeft: "auto", alignSelf: "center" }}>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>ОПЕРАЦИЙ</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#1A1A1A" }}>{displayTx.length}</div>
              </div>
            </div>
          )}

          {/* Business summary strip */}
          {showBusiness && (
            <div style={{
              display: "flex", gap: 32, marginBottom: 16,
              paddingBottom: 16, borderBottom: "1px solid #EDEBE6",
            }}>
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>ПОТРАЧЕНО НА БИЗНЕС</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#8B3A3A" }}>{fmt(bizExpense)} ₽</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>ПОЛУЧЕНО ОТ ИП</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#4A7C59" }}>{fmt(bizIncome)} ₽</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>ОПЕРАЦИЙ</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#1A1A1A" }}>{displayTx.length}</div>
              </div>
              <div style={{ marginLeft: "auto", alignSelf: "center", fontSize: 11, color: "#A89070" }}>
                за последние 3 месяца
              </div>
            </div>
          )}

          {/* Filter / selection bar — always visible to prevent layout shift */}
          {(() => {
            const hasFilters = !!(bankFilter || catFilter || payeeFilter || amountFilter || dateFrom || dateTo);
            const canClear = hasFilters || selectedIds.size > 0;
            const exp = filteredTx.reduce((s: number, t: any) => s + (t.outcome > 0 && t.income === 0 ? t.outcome : 0), 0);
            const inc = filteredTx.reduce((s: number, t: any) => s + (t.income > 0 && t.outcome === 0 ? t.income : 0), 0);
            const selItems = filteredTx.filter((t: any) => selectedIds.has(String(t.id)));
            const selExp = selItems.reduce((s: number, t: any) => s + (t.outcome > 0 && t.income === 0 ? t.outcome : 0), 0);
            const selInc = selItems.reduce((s: number, t: any) => s + (t.income > 0 && t.outcome === 0 ? t.income : 0), 0);
            const selNet = selInc - selExp;
            const net = inc - exp;
            return (
              <div style={{ padding: "10px 0", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
                <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#6B6355", alignItems: "center" }}>
                  {selectedIds.size > 0 && <span style={{ color: "#E8592A", fontWeight: 600 }}>Выбрано {selectedIds.size}</span>}
                  {selectedIds.size > 0 && selExp > 0 && <span style={{ color: "#8B3A3A" }}>−{fmt(selExp)}</span>}
                  {selectedIds.size > 0 && selInc > 0 && <span style={{ color: "#4A7C59" }}>+{fmt(selInc)}</span>}
                  {selectedIds.size > 0 && (selExp > 0 || selInc > 0) && <span style={{ color: selNet >= 0 ? "#4A7C59" : "#8B3A3A", fontWeight: 600 }}>{selNet >= 0 ? "+" : "−"}{fmt(Math.abs(selNet))}</span>}
                  {selectedIds.size === 0 && <span>{filteredTx.length} операций</span>}
                  {selectedIds.size === 0 && hasFilters && exp > 0 && <span style={{ color: "#8B3A3A" }}>−{fmt(exp)}</span>}
                  {selectedIds.size === 0 && hasFilters && inc > 0 && <span style={{ color: "#4A7C59" }}>+{fmt(inc)}</span>}
                  {selectedIds.size === 0 && hasFilters && (exp > 0 || inc > 0) && <span style={{ color: net >= 0 ? "#4A7C59" : "#8B3A3A", fontWeight: 600 }}>{net >= 0 ? "+" : "−"}{fmt(Math.abs(net))}</span>}
                </div>
                <button onClick={canClear ? clearFilters : undefined} style={{ fontSize: 10, color: canClear ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: canClear ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
                  <X size={10} /> Сбросить
                </button>
              </div>
            );
          })()}

          {/* Table header */}
          <div style={{
            display: "grid",
            gridTemplateColumns: ZM_GRID,
            padding: "10px 0 6px",
            borderBottom: "1px solid #EDEBE6",
            alignItems: "center",
          }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <Checkbox
                checked={filteredTx.length > 0 && filteredTx.every((t: any) => selectedIds.has(String(t.id)))}
                indeterminate={filteredTx.some((t: any) => selectedIds.has(String(t.id))) && !filteredTx.every((t: any) => selectedIds.has(String(t.id)))}
                onChange={() => {
                  const allSel = filteredTx.every((t: any) => selectedIds.has(String(t.id)));
                  setSelectedIds(allSel ? new Set() : new Set(filteredTx.map((t: any) => String(t.id))));
                }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>ДАТА</span>
              <PeriodFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} />
            </div>
            <div style={{ display: "flex", alignItems: "center" }}>
              <ColumnFilter options={uniqueBanks} value={bankFilter} onChange={setBankFilter} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>ПОЛУЧАТЕЛЬ</span>
              <ColumnFilter options={uniquePayees} value={payeeFilter} onChange={setPayeeFilter} maxHeight={220} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>КАТЕГОРИЯ</span>
              <ColumnFilter options={uniqueCats} value={catFilter} onChange={setCatFilter} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>СУММА</span>
              <ColumnFilter options={AMOUNT_RANGES.map(r => r.label)} value={amountFilter} onChange={setAmountFilter} />
            </div>
          </div>
        </div>

        {/* Transactions scroll area */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 28px 24px" }}>
          {filteredTx.length === 0 && (
            <div style={{ padding: "40px 0", textAlign: "center", color: "#A89070", fontSize: 13 }}>
              Нет операций
            </div>
          )}
          {filteredTx.slice(0, 200).map((tx: any) => {
            const isExpense = tx.outcome > 0 && tx.income === 0;
            const isIncome = tx.income > 0 && tx.outcome === 0;
            const amount = isExpense ? tx.outcome : tx.income;
            const isBiz = !!tx.matched_contractor || tx.is_business_income;

            return (
              <div
                key={tx.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: ZM_GRID,
                  padding: "7px 0",
                  borderBottom: "1px solid #F2EFE9",
                  background: selectedIds.has(String(tx.id)) ? "#FFF8F5" : isBiz ? "#FFFBF5" : "transparent",
                  alignItems: "start",
                }}
              >
                <div style={{ paddingTop: 2 }}>
                  <Checkbox checked={selectedIds.has(String(tx.id))} onChange={() => toggleSelect(String(tx.id))} />
                </div>
                <div style={{ fontSize: 11, color: "#6B6355", paddingTop: 1 }}>{tx.date?.slice(5)}</div>
                <div style={{ paddingTop: 1 }}>
                  <BankBadge title={isExpense ? (tx.outcome_account || "") : (tx.income_account || "")} />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: "#1A1A1A" }}>
                    {tx.payee || tx.comment || "—"}
                  </div>
                  {tx.payee && tx.comment && (
                    <div style={{ fontSize: 10, color: "#A89070" }}>{tx.comment}</div>
                  )}
                  {isBiz && (
                    <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                      {tx.matched_contractor && (
                        <span style={{
                          fontSize: 9, background: "#FFF3EF", color: "#E8592A",
                          padding: "1px 5px", border: "1px solid #F0D8D0",
                        }}>
                          {tx.matched_contractor}
                        </span>
                      )}
                      {tx.is_business_income && (
                        <span style={{
                          fontSize: 9, background: "#EFF5F1", color: "#4A7C59",
                          padding: "1px 5px", border: "1px solid #D0E0D4",
                        }}>
                          от ИП
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 10, color: "#A89070", paddingTop: 1 }}>
                  {(tx.tags as string[])?.[0] || ""}
                </div>
                <div style={{
                  fontSize: 12, fontWeight: 500, paddingTop: 1,
                  color: isIncome ? "#4A7C59" : "#1A1A1A",
                }}>
                  {isIncome ? "+" : "−"}{fmt(amount)} ₽
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Right: stats panel ───────────────────────────────── */}
      <div style={{
        width: 320,
        minWidth: 320,
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        padding: "24px 24px",
        gap: 0,
      }}>

        {/* Total balance */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>ИТОГО</div>
          <div style={{
            fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em",
            color: totalBalance >= 0 ? "#1A1A1A" : "#8B3A3A",
          }}>
            {totalBalance < 0 ? "−" : ""}{fmt(totalBalance)} ₽
          </div>
        </div>

        {/* Accounts */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>СЧЕТА</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {(accounts as any[])
              .filter((a: any) => a.balance !== 0)
              .map((acc: any) => (
                <div
                  key={acc.id}
                  style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "7px 0",
                    borderBottom: "1px solid #F2EFE9",
                  }}
                >
                  <div style={{ fontSize: 12, color: "#6B6355" }}>{acc.title}</div>
                  <div style={{
                    fontSize: 13, fontWeight: 600,
                    color: acc.balance >= 0 ? "#1A1A1A" : "#8B3A3A",
                  }}>
                    {acc.balance < 0 ? "−" : ""}{fmt(acc.balance)} ₽
                  </div>
                </div>
              ))}
          </div>
        </div>

        {/* Cashflow chart */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 14 }}>
            КЭШФЛОУ — 6 МЕС
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 4 }}>
            {(cashflow as any[]).map((r: any) => {
              const incH = Math.max(Math.round((r.incomes / maxVal) * CHART_H), 2);
              const expH = Math.max(Math.round((r.expenses / maxVal) * CHART_H), 2);
              const [, m] = r.month.split("-");
              return (
                <div
                  key={r.month}
                  style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flex: 1 }}
                >
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: CHART_H }}>
                    <div
                      style={{ width: 10, height: incH, background: "#4A7C59" }}
                      title={`Доходы: ${fmt(r.incomes)} ₽`}
                    />
                    <div
                      style={{ width: 10, height: expH, background: "#EDEBE6" }}
                      title={`Расходы: ${fmt(r.expenses)} ₽`}
                    />
                  </div>
                  <div style={{ fontSize: 8, color: "#A89070" }}>{MONTHS_RU[parseInt(m) - 1]}</div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 8, height: 8, background: "#4A7C59" }} />
              <span style={{ fontSize: 10, color: "#A89070" }}>Доходы</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 8, height: 8, background: "#EDEBE6", border: "1px solid #CCC8C0" }} />
              <span style={{ fontSize: 10, color: "#A89070" }}>Расходы</span>
            </div>
          </div>
        </div>

        {/* Category breakdown */}
        {report && report.categories?.length > 0 && (
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>
              КАТЕГОРИИ · {getMonthLabel(selectedMonth).toUpperCase()}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {(report.categories as any[]).slice(0, 10).map((cat: any, i: number) => {
                const pct = report.expenses > 0
                  ? Math.round((cat.total / report.expenses) * 100)
                  : 0;
                const barW = Math.max(pct, 1);
                return (
                  <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid #F2EFE9" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <div style={{ fontSize: 11, color: "#1A1A1A" }}>{cat.category}</div>
                      <div style={{ fontSize: 11, color: "#8B3A3A", fontWeight: 500 }}>
                        {fmt(cat.total)} ₽
                      </div>
                    </div>
                    <div style={{ height: 2, background: "#F2EFE9" }}>
                      <div style={{ height: 2, width: `${barW}%`, background: "#E8592A" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
