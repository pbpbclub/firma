import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { financeApi, ordersApi } from "../api";
import { MagnifyingGlass, X, LinkSimple } from "@phosphor-icons/react";
import { ColumnFilter, AmountFilter, PeriodFilter } from "../components/TableFilters";
import { Modal } from "../components/ui/Modal";

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

// ── Модал: привязать транзакцию к обязательству ───────────────────────────

function LinkCreditorModal({ tx, creditorByFinTx, onClose }: {
  tx: any;
  creditorByFinTx: Map<string, any>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const { data: suggested = [], isFetching } = useQuery({
    queryKey: ["suggest-creditors", tx.id],
    queryFn: () => financeApi.suggestCreditors(tx.counterparty || tx.purpose || "", tx.amount || 0),
  });

  const link = useMutation({
    mutationFn: ({ creditorId, txId }: { creditorId: string; txId: string | null }) => {
      const patch: any = { finance_tx_id: txId };
      if (txId !== null) patch.paid = tx.amount;
      return financeApi.updateCreditor(creditorId, patch);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["creditors-all"] }); onClose(); },
  });

  const currentCreditor = creditorByFinTx.get(String(tx.id));

  const items: any[] = suggested as any[];
  const filtered = search
    ? items.filter((c: any) => (c.name || "").toLowerCase().includes(search.toLowerCase()))
    : items;

  function fmtAmt(n: number) {
    return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
  }

  return (
    <Modal size="md" eyebrow="ПРИВЯЗАТЬ К ОБЯЗАТЕЛЬСТВУ" onClose={onClose}>

        {/* Транзакция */}
        <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid #F2EFE9" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1A1A" }}>
            {tx.counterparty || tx.purpose || "—"}
          </div>
          <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>
            {(tx.date || "").slice(0, 10)} · −{fmtAmt(tx.amount)}
          </div>
        </div>

        {/* Already linked */}
        {currentCreditor && (
          <div style={{ padding: "8px 20px", background: "#F2FDF5", borderBottom: "1px solid #D0EDD8", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 11, color: "#4A7C59" }}>
              <LinkSimple size={11} style={{ marginRight: 4 }} />
              Привязано: <strong>{currentCreditor.name}</strong>
            </div>
            <button
              onClick={() => link.mutate({ creditorId: currentCreditor.id, txId: null })}
              style={{ fontSize: 11, color: "#8B3A3A", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >Отвязать</button>
          </div>
        )}

        {/* Search */}
        <div style={{ padding: "8px 20px", borderBottom: "1px solid #F2EFE9" }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Поиск по обязательству..."
            style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "5px 10px", fontSize: 12, outline: "none" }} />
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {isFetching && <div style={{ padding: 32, textAlign: "center", color: "#A89070", fontSize: 12 }}>Загружаем...</div>}
          {!isFetching && filtered.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "#C8C0B0", fontSize: 12 }}>Обязательства не найдены</div>}
          {!isFetching && filtered.map((c: any) => {
            const isLinked = currentCreditor?.id === c.id;
            return (
              <div key={c.id}
                onClick={() => link.mutate({ creditorId: c.id, txId: String(tx.id) })}
                style={{
                  display: "grid", gridTemplateColumns: "1fr 100px 80px",
                  padding: "9px 20px", borderBottom: "1px solid #F2EFE9", cursor: "pointer",
                  background: isLinked ? "#F2FDF5" : "transparent", alignItems: "center", gap: 10,
                }}
                onMouseEnter={e => { if (!isLinked) e.currentTarget.style.background = "#FAF8F5"; }}
                onMouseLeave={e => { if (!isLinked) e.currentTarget.style.background = "transparent"; }}
              >
                <div>
                  <div style={{ fontSize: 12, color: "#1A1A1A", fontWeight: 500 }}>{c.name}</div>
                  {c.description && <div style={{ fontSize: 10, color: "#A89070", marginTop: 1 }}>{c.description}</div>}
                </div>
                <div style={{ fontSize: 11, color: "#8B3A3A", textAlign: "right" }}>долг {fmtAmt(c.debt)}</div>
                <div style={{ fontSize: 11, color: "#A89070", textAlign: "right" }}>
                  {fmtAmt(c.total)}
                  {isLinked && <LinkSimple size={10} style={{ color: "#4A7C59", marginLeft: 4 }} />}
                </div>
              </div>
            );
          })}
        </div>
    </Modal>
  );
}

// ── Модал: привязать входящую транзакцию к заказу ────────────────────────────

function LinkOrderModal({ tx, paymentByFinTx, onClose }: {
  tx: any;
  paymentByFinTx: Map<string, any>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const { data: suggested = [], isFetching } = useQuery({
    queryKey: ["suggest-orders", tx.id],
    queryFn: () => ordersApi.suggest(tx.counterparty || tx.purpose || "", tx.amount || 0),
  });

  const link = useMutation({
    mutationFn: async ({ orderId, txId }: { orderId: string | null; txId: string }) => {
      if (orderId === null) {
        const cur = paymentByFinTx.get(String(txId));
        if (cur) await ordersApi.deletePayment(cur.order_id, cur.payment_id);
      } else {
        await ordersApi.addPayment(orderId, {
          amount: tx.amount,
          paid_at: (tx.date || "").slice(0, 10),
          note: `ДДС: ${tx.counterparty || tx.purpose || ""}`.trim(),
          bank_tx_id: String(txId),
        });
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payments-map"] }); onClose(); },
  });

  const currentPayment = paymentByFinTx.get(String(tx.id));

  function fmtAmt(n: number) {
    return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
  }

  const items: any[] = suggested as any[];
  const filtered = search
    ? items.filter((o: any) => ((o.title || "") + " " + (o.customer_name || "")).toLowerCase().includes(search.toLowerCase()))
    : items;

  return (
    <Modal size="md" eyebrow="ПРИВЯЗАТЬ К ЗАКАЗУ" onClose={onClose}>
        <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid #F2EFE9" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1A1A" }}>{tx.counterparty || tx.purpose || "—"}</div>
          <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>{(tx.date || "").slice(0, 10)} · +{fmtAmt(tx.amount)}</div>
        </div>
        {currentPayment && (
          <div style={{ padding: "8px 20px", background: "#F2FDF5", borderBottom: "1px solid #D0EDD8", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 11, color: "#4A7C59" }}>
              <LinkSimple size={11} style={{ marginRight: 4 }} />
              Привязано: <strong>{currentPayment.order_title} ({currentPayment.order_number})</strong>
            </div>
            <button onClick={() => link.mutate({ orderId: null, txId: String(tx.id) })} style={{ fontSize: 11, color: "#8B3A3A", background: "none", border: "none", cursor: "pointer", padding: 0 }}>Отвязать</button>
          </div>
        )}
        <div style={{ padding: "8px 20px", borderBottom: "1px solid #F2EFE9" }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по заказу или клиенту..."
            style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "5px 10px", fontSize: 12, outline: "none" }} />
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {isFetching && <div style={{ padding: 32, textAlign: "center", color: "#A89070", fontSize: 12 }}>Загружаем...</div>}
          {!isFetching && filtered.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "#C8C0B0", fontSize: 12 }}>Заказы не найдены</div>}
          {!isFetching && filtered.map((o: any) => (
            <div key={o.id} onClick={() => link.mutate({ orderId: o.id, txId: String(tx.id) })}
              style={{ display: "grid", gridTemplateColumns: "1fr 100px 80px", padding: "9px 20px", borderBottom: "1px solid #F2EFE9", cursor: "pointer", alignItems: "center", gap: 10 }}
              onMouseEnter={e => { e.currentTarget.style.background = "#FAF8F5"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: "#1A1A1A" }}>{o.title}</div>
                {o.customer_name && <div style={{ fontSize: 10, color: "#A89070", marginTop: 1 }}>{o.customer_name}</div>}
              </div>
              <div style={{ fontSize: 11, color: "#E8592A", textAlign: "right" }}>{o.number}</div>
              <div style={{ fontSize: 11, color: "#A89070", textAlign: "right" }}>{fmtAmt(o.price_plan || 0)}</div>
            </div>
          ))}
        </div>
    </Modal>
  );
}

export default function Finance() {
  const [direction, setDirection] = useState("");
  const [search, setSearch] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [descFilter, setDescFilter] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const clearFilters = () => { setAccountFilter(""); setDateFrom(""); setDateTo(""); setDescFilter(""); setAmountMin(""); setAmountMax(""); setSelectedIds(new Set()); };
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [linkModal, setLinkModal] = useState<any>(null);
  const [linkOrderModal, setLinkOrderModal] = useState<any>(null);
  const FIN_GRID = "28px 110px 1fr 120px 120px 28px 28px";

  const { data: allCreditors } = useQuery({
    queryKey: ["creditors-all"],
    queryFn: () => financeApi.creditors("all"),
  });
  const creditorByFinTx = useMemo(() => {
    const m = new Map<string, any>();
    for (const c of (allCreditors?.items ?? []) as any[]) {
      if (c.finance_tx_id) m.set(String(c.finance_tx_id), c);
    }
    return m;
  }, [allCreditors]);

  const { data: paymentsMapData = [] } = useQuery({
    queryKey: ["payments-map"],
    queryFn: ordersApi.paymentsMap,
  });
  const paymentByFinTx = useMemo(() => {
    const m = new Map<string, any>();
    for (const p of paymentsMapData as any[]) {
      if (p.bank_tx_id) m.set(String(p.bank_tx_id), p);
    }
    return m;
  }, [paymentsMapData]);

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
      if (dateFrom && t.date < dateFrom) return false;
      if (dateTo && t.date > dateTo) return false;
      if (descFilter) {
        const desc = t.counterparty || t.purpose || (t.source === "fund" ? t.fund_name : "") || "";
        if (desc !== descFilter) return false;
      }
      if (amountMin && t.amount < parseFloat(amountMin)) return false;
      if (amountMax && t.amount > parseFloat(amountMax)) return false;
      return true;
    });
  }, [txs, accountFilter, dateFrom, dateTo, descFilter, amountMin, amountMax]);

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

        {/* Filter / selection bar — always visible to prevent layout shift */}
        {(() => {
          const hasFilters = !!(accountFilter || dateFrom || dateTo || descFilter || amountMin || amountMax);
          const canClear = hasFilters || selectedIds.size > 0;
          const fIn = filteredTxs.filter((t: any) => t.direction === "in").reduce((s: number, t: any) => s + t.amount, 0);
          const fOut = filteredTxs.filter((t: any) => t.direction === "out").reduce((s: number, t: any) => s + t.amount, 0);
          const selItems = filteredTxs.filter((t: any) => selectedIds.has(String(t.id)));
          const selIn = selItems.filter((t: any) => t.direction === "in").reduce((s: number, t: any) => s + t.amount, 0);
          const selOut = selItems.filter((t: any) => t.direction === "out").reduce((s: number, t: any) => s + t.amount, 0);
          const selNet = selIn - selOut;
          const net = fIn - fOut;
          return (
            <div style={{ padding: "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
              <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#6B6355", alignItems: "center" }}>
                {selectedIds.size > 0 && <span style={{ color: "#E8592A", fontWeight: 600 }}>Выбрано {selectedIds.size}</span>}
                {selectedIds.size > 0 && selIn > 0 && <span style={{ color: "#4A7C59" }}>+{fmt(selIn)}</span>}
                {selectedIds.size > 0 && selOut > 0 && <span style={{ color: "#8B3A3A" }}>−{fmt(selOut)}</span>}
                {selectedIds.size > 0 && (selIn > 0 || selOut > 0) && <span style={{ color: selNet >= 0 ? "#4A7C59" : "#8B3A3A", fontWeight: 600 }}>{selNet >= 0 ? "+" : "−"}{fmt(Math.abs(selNet))}</span>}
                {selectedIds.size === 0 && <span>{filteredTxs.length} транзакций</span>}
                {selectedIds.size === 0 && hasFilters && fIn > 0 && <span style={{ color: "#4A7C59" }}>+{fmt(fIn)}</span>}
                {selectedIds.size === 0 && hasFilters && fOut > 0 && <span style={{ color: "#8B3A3A" }}>−{fmt(fOut)}</span>}
                {selectedIds.size === 0 && hasFilters && (fIn > 0 || fOut > 0) && <span style={{ color: net >= 0 ? "#4A7C59" : "#8B3A3A", fontWeight: 600 }}>{net >= 0 ? "+" : "−"}{fmt(Math.abs(net))}</span>}
              </div>
              <button onClick={canClear ? clearFilters : undefined} style={{ fontSize: 10, color: canClear ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: canClear ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
                <X size={10} /> Сбросить
              </button>
            </div>
          );
        })()}

        {/* Column headers */}
        <div style={{ display: "grid", gridTemplateColumns: FIN_GRID, padding: "8px 28px", borderBottom: "1px solid #EDEBE6", flexShrink: 0, alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <Checkbox
              checked={filteredTxs.length > 0 && filteredTxs.every((t: any) => selectedIds.has(String(t.id)))}
              indeterminate={filteredTxs.some((t: any) => selectedIds.has(String(t.id))) && !filteredTxs.every((t: any) => selectedIds.has(String(t.id)))}
              onChange={() => {
                const allSel = filteredTxs.every((t: any) => selectedIds.has(String(t.id)));
                setSelectedIds(allSel ? new Set() : new Set(filteredTxs.map((t: any) => String(t.id))));
              }}
            />
          </div>
          <div><PeriodFilter label="ДАТА" from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} /></div>
          <div><ColumnFilter label="ОПИСАНИЕ" options={uniqueDescs} value={descFilter} onChange={setDescFilter} /></div>
          <div><ColumnFilter label="СЧЁТ" options={["Т-Банк", "Сбербанк", "Фонды"]} value={accountFilter} onChange={setAccountFilter} /></div>
          <div><AmountFilter label="СУММА" min={amountMin} max={amountMax} onChange={(mn, mx) => { setAmountMin(mn); setAmountMax(mx); }} /></div>
          <div /><div />
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
                  display: "grid", gridTemplateColumns: FIN_GRID,
                  padding: "11px 28px", borderBottom: "1px solid #F2EFE9",
                  alignItems: "center", transition: "background 0.1s",
                  background: selectedIds.has(String(t.id)) ? "#FFF8F5" : "transparent",
                }}
                onMouseEnter={(e) => { if (!selectedIds.has(String(t.id))) e.currentTarget.style.background = "#FAF8F5"; }}
                onMouseLeave={(e) => { if (!selectedIds.has(String(t.id))) e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{ display: "flex", alignItems: "center" }}>
                  <Checkbox checked={selectedIds.has(String(t.id))} onChange={() => toggleSelect(String(t.id))} />
                </div>
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
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: t.direction === "in" ? "#4A7C59" : "#8B3A3A" }}>
                    {t.direction === "in" ? "+" : "−"}{fmt(t.amount)}
                  </div>
                  {t.direction === "out" && creditorByFinTx.has(String(t.id)) && (
                    <div style={{ fontSize: 10, color: "#4A7C59", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {creditorByFinTx.get(String(t.id))?.name}
                    </div>
                  )}
                  {t.direction === "in" && paymentByFinTx.has(String(t.id)) && (
                    <div style={{ fontSize: 10, color: "#4A7C59", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {paymentByFinTx.get(String(t.id))?.number}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", justifyContent: "center" }}>
                  {t.direction === "out" && t.source !== "fund" && (
                    <button
                      onClick={e => { e.stopPropagation(); setLinkModal(t); }}
                      title="Привязать к обязательству"
                      style={{
                        background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex",
                        color: creditorByFinTx.has(String(t.id)) ? "#4A7C59" : "#C8C0B0",
                      }}
                      onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
                      onMouseLeave={e => (e.currentTarget.style.color = creditorByFinTx.has(String(t.id)) ? "#4A7C59" : "#C8C0B0")}
                    >
                      <LinkSimple size={12} />
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", justifyContent: "center" }}>
                  {t.direction === "in" && t.source !== "fund" && (
                    <button
                      onClick={e => { e.stopPropagation(); setLinkOrderModal(t); }}
                      title="Привязать к заказу"
                      style={{
                        background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex",
                        color: paymentByFinTx.has(String(t.id)) ? "#4A7C59" : "#C8C0B0",
                      }}
                      onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
                      onMouseLeave={e => (e.currentTarget.style.color = paymentByFinTx.has(String(t.id)) ? "#4A7C59" : "#C8C0B0")}
                    >
                      <LinkSimple size={12} />
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
          {linkModal && (
            <LinkCreditorModal
              tx={linkModal}
              creditorByFinTx={creditorByFinTx}
              onClose={() => setLinkModal(null)}
            />
          )}
          {linkOrderModal && (
            <LinkOrderModal
              tx={linkOrderModal}
              paymentByFinTx={paymentByFinTx}
              onClose={() => setLinkOrderModal(null)}
            />
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
