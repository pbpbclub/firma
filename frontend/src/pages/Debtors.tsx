import { fmtMoneyDash as fmt } from "../components/ui/format";
import { QueryError } from "../components/ui/QueryError";
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loading } from "../components/ui/Loading";
import { EmptyState } from "../components/ui/EmptyState";
import { financeApi, zenmoneyApi, ordersApi, ledgerApi } from "../api";
import { useNavigate } from "react-router-dom";
import { Bank, X, Check, Plus, LinkSimple } from "@phosphor-icons/react";
import { ColumnFilter, AmountFilter, PeriodFilter } from "../components/TableFilters";
import { Modal, ConfirmModal } from "../components/ui/Modal";
import { MONO } from "../components/ui/Num";
import { OrderLink } from "../components/ui/links";
import { useTableSort } from "../components/ui/sort";
import { ObligationsConfirmModal, type Unpaid } from "../components/order/ObligationsConfirmModal";
import { CompleteOrderButton } from "../components/order/CompleteOrderButton";
import { useIsMobile, M, HScroll } from "../components/ui/responsive";
import { RowCard } from "../components/ui/RowCard";
import { IconButton } from "../components/ui/IconButton";
import { T, POLARITY, debtColor } from "../components/ui/type";
import { DeadlinePill } from "../components/ui/Pill";
import { Button } from "../components/ui/Button";

const SANS = "inherit";

// Полярность вкладки: деньги входят (in) / выходят (out) — задаёт цвет зоны.
const TAB_POLARITY: Record<string, keyof typeof POLARITY> = {
  debtors: "in", unallocated: "in", creditors: "out", fixed: "out",
  ledger: "out",
};

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


function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function deadlineColor(deadline: string) {
  if (!deadline) return "#A89070";
  const days = (new Date(deadline).getTime() - Date.now()) / 86400000;
  if (days < 0) return "#8B3A3A";
  if (days < 7) return "#E8592A";
  return "#6B6355";
}

// ── Модал: связать с входящей транзакцией ─────────────────────────────────

function LinkInTxModal({ title, name, amount, linkedTxId, onLink, onClose }: {
  title: string; name: string; amount: number; linkedTxId?: string | null;
  onLink: (txId: string | null) => void; onClose: () => void;
}) {
  const [search, setSearch] = useState("");

  const { data: txs = [], isFetching: loading } = useQuery({
    queryKey: ["suggest-in-tx", name, amount],
    queryFn: () => financeApi.suggestInTx(name, amount),
  });

  const filtered = search
    ? (txs as any[]).filter((t: any) => {
        const label = ((t.counterparty || "") + " " + (t.purpose || "")).toLowerCase();
        return label.includes(search.toLowerCase());
      })
    : (txs as any[]);

  function fmtAmt(n: number) {
    return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
  }

  return (
    <Modal size="md" eyebrow="ПРИВЯЗАТЬ ПОСТУПЛЕНИЕ" onClose={onClose}>
        <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid #F2EFE9" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1A1A" }}>{title}</div>
          <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>{name} · {fmtAmt(amount)}</div>
        </div>

        {linkedTxId && (
          <div style={{ padding: "8px 20px", background: "#F2FDF5", borderBottom: "1px solid #D0EDD8", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 11, color: "#4A7C59" }}>
              <LinkSimple size={11} style={{ marginRight: 4 }} />
              Привязана транзакция
            </div>
            <button type="button" onClick={() => onLink(null)}
              style={{ fontSize: 11, color: "#8B3A3A", background: "none", border: "none", cursor: "pointer", padding: 0 }}>Отвязать</button>
          </div>
        )}

        <div style={{ padding: "8px 20px", borderBottom: "1px solid #F2EFE9" }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Поиск по контрагенту..."
            style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "5px 10px", fontSize: 12, outline: "none" }} />
        </div>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {loading && <Loading compact />}
          {!loading && filtered.length === 0 && <EmptyState compact title="Транзакции не найдены" />}
          {!loading && filtered.map((t: any) => {
            const isLinked = String(t.id) === String(linkedTxId);
            const label = t.counterparty || t.purpose || "—";
            return (
              <div key={t.id}
                onClick={() => onLink(String(t.id))}
                style={{
                  display: "grid", gridTemplateColumns: "80px 1fr 100px",
                  padding: "9px 20px", borderBottom: "1px solid #F2EFE9", cursor: "pointer",
                  background: isLinked ? "#F2FDF5" : "transparent", alignItems: "center", gap: 10,
                }}
                onMouseEnter={e => { if (!isLinked) e.currentTarget.style.background = "#FAF8F5"; }}
                onMouseLeave={e => { if (!isLinked) e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{ fontSize: 11, color: "#A89070" }}>{(t.date || "").slice(0, 10)}</div>
                <div style={{ fontSize: 12, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {label}
                  {t.purpose && t.counterparty && <div style={{ fontSize: 10, color: "#A89070", marginTop: 1 }}>{t.purpose}</div>}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#4A7C59", textAlign: "right" }}>
                  +{fmtAmt(t.amount || 0)}
                  {isLinked && <LinkSimple size={10} style={{ color: "#4A7C59", marginLeft: 4 }} />}
                </div>
              </div>
            );
          })}
        </div>
    </Modal>
  );
}

// ── Модал: добавить обязательство ──────────────────────────────────────────

function AddCreditorModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [total, setTotal] = useState("");
  const [paid, setPaid] = useState("0");
  const [desc, setDesc] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState("");

  const { mutate, isPending } = useMutation({
    mutationFn: () => financeApi.createCreditor({
      name: name.trim(),
      total: parseFloat(total) || 0,
      paid: parseFloat(paid) || 0,
      description: desc.trim() || undefined,
      due_date: dueDate || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["creditors"] });
      onClose();
    },
    onError: (e: any) => setError(e?.response?.data?.detail || "Не удалось сохранить"),
  });

  return (
    <Modal
      size="md"
      eyebrow="НОВОЕ ОБЯЗАТЕЛЬСТВО"
      onClose={onClose}
      onCancel={onClose}
      onSave={() => mutate()}
      saveLabel="Добавить"
      saving={isPending}
      canSave={!!name.trim() && !!total}
    >
        <div style={{ padding: "18px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>КОНТРАГЕНТ *</div>
            <input
              value={name} onChange={e => setName(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }}
              placeholder="Самсонов Саша"
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ДОЛГ, ₽ *</div>
              <input
                type="number" value={total} onChange={e => setTotal(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }}
                placeholder="0"
              />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>УЖЕ ОПЛАЧЕНО, ₽</div>
              <input
                type="number" value={paid} onChange={e => setPaid(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }}
                placeholder="0"
              />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ЗА ЧТО</div>
            <textarea
              value={desc} onChange={e => setDesc(e.target.value)} rows={2}
              style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none", resize: "vertical", fontFamily: "inherit" }}
              placeholder="Доставка, работы по заказу..."
            />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>СРОК ОПЛАТЫ</div>
            <input
              type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }}
            />
          </div>
        </div>

      {error && <div style={{ padding: "0 24px 12px", fontSize: 11, color: "#8B3A3A" }}>{error}</div>}
    </Modal>
  );
}

// ── Модал: отметить оплату / редактировать ─────────────────────────────────

function PayCreditorModal({ item, onClose }: { item: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [paid, setPaid] = useState(String(item.paid ?? 0));
  const [total, setTotal] = useState(String(item.total ?? 0));
  const [desc, setDesc] = useState(item.description ?? "");
  const [dueDate, setDueDate] = useState(item.due_date ?? "");

  const update = useMutation({
    mutationFn: (data: any) => financeApi.updateCreditor(item.id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["creditors"] }); qc.invalidateQueries({ queryKey: ["fixed-obligations"] }); onClose(); },
  });

  const close = useMutation({
    mutationFn: () => financeApi.updateCreditor(item.id, { status: "closed" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["creditors"] }); qc.invalidateQueries({ queryKey: ["fixed-obligations"] }); onClose(); },
  });

  const del = useMutation({
    mutationFn: () => financeApi.deleteCreditor(item.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["creditors"] }); qc.invalidateQueries({ queryKey: ["fixed-obligations"] }); onClose(); },
  });

  return (
    <Modal size="md" eyebrow="ОБЯЗАТЕЛЬСТВО" onClose={onClose}>
      <div style={{ padding: "18px 24px" }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#1A1A1A", marginBottom: 14 }}>{item.name}</div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ВСЕГО ДОЛГ, ₽</div>
              <input
                type="number" value={total} onChange={e => setTotal(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }}
              />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ОПЛАЧЕНО, ₽</div>
              <input
                type="number" value={paid} onChange={e => setPaid(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }}
              />
            </div>
          </div>

          <div style={{ background: "#FAF8F5", padding: "8px 12px", display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 12, color: "#A89070" }}>Остаток к оплате</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#8B3A3A" }}>
              {fmt(Math.max(0, (parseFloat(total) || 0) - (parseFloat(paid) || 0)))}
            </span>
          </div>

          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ЗА ЧТО</div>
            <textarea
              value={desc} onChange={e => setDesc(e.target.value)} rows={2}
              style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none", resize: "vertical", fontFamily: "inherit" }}
            />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>СРОК ОПЛАТЫ</div>
            <input
              type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }}
            />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20, gap: 8 }}>
          <button type="button"
            onClick={() => del.mutate()}
            style={{ padding: "7px 12px", border: "1px solid #EDEBE6", background: "none", fontSize: 11, cursor: "pointer", color: "#8B3A3A" }}
          >
            Удалить
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button"
              onClick={() => close.mutate()}
              style={{ padding: "7px 12px", border: "1px solid #4A7C59", background: "none", fontSize: 11, cursor: "pointer", color: "#4A7C59", display: "flex", alignItems: "center", gap: 4 }}
            >
              <Check size={12} /> Закрыть долг
            </button>
            <button type="button"
              onClick={() => update.mutate({ paid: parseFloat(paid) || 0, total: parseFloat(total) || 0, description: desc || undefined, due_date: dueDate || undefined })}
              style={{ padding: "7px 16px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600 }}
            >
              Сохранить
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Вкладка: дебиторка ─────────────────────────────────────────────────────

const debtorCols = "28px 2fr 1fr 130px 150px 130px 100px 28px";

function DebtorsTab() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({ queryKey: ["debtors"], queryFn: financeApi.debtors });
  const [statusFilter, setStatusFilter] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [orderFilter, setOrderFilter] = useState("");
  const [planMin, setPlanMin] = useState("");
  const [planMax, setPlanMax] = useState("");
  const [paidMin, setPaidMin] = useState("");
  const [paidMax, setPaidMax] = useState("");
  const [debtMin, setDebtMin] = useState("");
  const [debtMax, setDebtMax] = useState("");
  const [dlFrom, setDlFrom] = useState("");
  const [dlTo, setDlTo] = useState("");
  const [linkItem, setLinkItem] = useState<any>(null);
  // «Расчёты закрыты» (orders.settled_at): заглушённые долги — отдельным свёрнутым
  // блоком, чтобы было видно, что и на сколько заглушено, и можно было открыть заново.
  const [settledOpen, setSettledOpen] = useState(false);
  const unsettle = useMutation({
    mutationFn: (orderId: string) => ordersApi.unsettle(orderId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["debtors"] }); qc.invalidateQueries({ queryKey: ["orders-v2"] }); },
  });
  const clearFilters = () => { setStatusFilter(""); setClientFilter(""); setOrderFilter(""); setPlanMin(""); setPlanMax(""); setPaidMin(""); setPaidMax(""); setDebtMin(""); setDebtMax(""); setDlFrom(""); setDlTo(""); setSelectedIds(new Set()); };
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const items: any[] = data?.items || [];
  const uniqueStatuses = [...new Set(items.map((r: any) => r.status_label || r.status).filter(Boolean))].sort() as string[];
  const uniqueClients = useMemo(() => [...new Set(items.map((r: any) => r.customer_name).filter(Boolean))].sort() as string[], [items]);
  const uniqueOrders = useMemo(() => [...new Set(items.map((r: any) => r.title).filter(Boolean))].sort() as string[], [items]);
  const filtered = useMemo(() => {
    let r = items;
    if (statusFilter) r = r.filter((d: any) => (d.status_label || d.status) === statusFilter);
    if (clientFilter) r = r.filter((d: any) => d.customer_name === clientFilter);
    if (orderFilter) r = r.filter((d: any) => d.title === orderFilter);
    if (planMin) r = r.filter((d: any) => (d.price_plan || 0) >= parseFloat(planMin));
    if (planMax) r = r.filter((d: any) => (d.price_plan || 0) <= parseFloat(planMax));
    if (paidMin) r = r.filter((d: any) => (d.paid_total || 0) >= parseFloat(paidMin));
    if (paidMax) r = r.filter((d: any) => (d.paid_total || 0) <= parseFloat(paidMax));
    if (debtMin) r = r.filter((d: any) => (d.debt || 0) >= parseFloat(debtMin));
    if (debtMax) r = r.filter((d: any) => (d.debt || 0) <= parseFloat(debtMax));
    if (dlFrom) r = r.filter((d: any) => d.deadline && d.deadline.slice(0, 10) >= dlFrom);
    if (dlTo) r = r.filter((d: any) => d.deadline && d.deadline.slice(0, 10) <= dlTo);
    return r;
  }, [items, statusFilter, clientFilter, orderFilter, planMin, planMax, paidMin, paidMax, debtMin, debtMax, dlFrom, dlTo]);

  const total     = filtered.reduce((s: number, r: any) => s + (r.debt || 0), 0);
  const totalPlan = filtered.reduce((s: number, r: any) => s + (r.price_plan || 0), 0);
  const totalPaid = filtered.reduce((s: number, r: any) => s + (r.paid_total || 0), 0);

  const linkOrder = useMutation({
    mutationFn: ({ id, txId }: { id: string; txId: string | null }) =>
      ordersApi.update(id, { finance_tx_id: txId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["debtors"] }); setLinkItem(null); },
  });

  if (isLoading) return <Loading />;
  if (isError) return <QueryError error={error} what="дебиторку" />;

  return (
    <>
      {linkItem && (
        <LinkInTxModal
          title={linkItem.title}
          name={linkItem.customer_name || linkItem.title}
          amount={linkItem.debt}
          linkedTxId={linkItem.finance_tx_id}
          onLink={(txId) => linkOrder.mutate({ id: linkItem.id, txId })}
          onClose={() => setLinkItem(null)}
        />
      )}
      {(() => {
        const hasFilters = !!(statusFilter || clientFilter || orderFilter || planMin || planMax || paidMin || paidMax || debtMin || debtMax || dlFrom || dlTo);
        const canClear = hasFilters || selectedIds.size > 0;
        const selDebt = filtered.filter((d: any) => selectedIds.has(String(d.id || d.number))).reduce((s: number, d: any) => s + (d.debt || 0), 0);
        return (
          <div style={{ padding: isMobile ? "8px 16px" : "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0, flexWrap: isMobile ? "wrap" : undefined, gap: isMobile ? 6 : 0 }}>
            <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#6B6355", alignItems: "center" }}>
              {selectedIds.size > 0 && <span style={{ color: "#E8592A", fontWeight: 600 }}>Выбрано {selectedIds.size}</span>}
              {selectedIds.size > 0 && selDebt > 0 && <span style={{ color: debtColor(selDebt, "in") }}>долг {fmt(selDebt)}</span>}
              {selectedIds.size === 0 && <span>{filtered.length} позиций</span>}
              {selectedIds.size === 0 && hasFilters && total > 0 && <span style={{ color: debtColor(total, "in") }}>долг {fmt(total)}</span>}
            </div>
            <button type="button" onClick={canClear ? clearFilters : undefined} style={{ fontSize: 10, color: canClear ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: canClear ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
              <X size={10} /> Сбросить
            </button>
          </div>
        );
      })()}

      <div style={isMobile ? M.filterRow : { display: "grid", gridTemplateColumns: debtorCols, padding: "8px 28px", borderBottom: "1px solid #EDEBE6", alignItems: "center" }}>
        {!isMobile && <div style={{ display: "flex", alignItems: "center" }}>
          <Checkbox
            checked={filtered.length > 0 && filtered.every((d: any) => selectedIds.has(String(d.id || d.number)))}
            indeterminate={filtered.some((d: any) => selectedIds.has(String(d.id || d.number))) && !filtered.every((d: any) => selectedIds.has(String(d.id || d.number)))}
            onChange={() => {
              const allSel = filtered.every((d: any) => selectedIds.has(String(d.id || d.number)));
              setSelectedIds(allSel ? new Set() : new Set(filtered.map((d: any) => String(d.id || d.number))));
            }}
          />
        </div>}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <ColumnFilter label="КЛИЕНТ" options={uniqueClients} value={clientFilter} onChange={setClientFilter} />
          <ColumnFilter label="ЗАКАЗ" options={uniqueOrders} value={orderFilter} onChange={setOrderFilter} />
        </div>
        <div><ColumnFilter label="СТАТУС" options={uniqueStatuses} value={statusFilter} onChange={setStatusFilter} /></div>
        <div><AmountFilter label="СОГЛАСОВАНО" min={planMin} max={planMax} onChange={(mn, mx) => { setPlanMin(mn); setPlanMax(mx); }} /></div>
        <div><AmountFilter label="ОПЛАЧЕНО" min={paidMin} max={paidMax} onChange={(mn, mx) => { setPaidMin(mn); setPaidMax(mx); }} /></div>
        <div><AmountFilter label="ОЖИДАЕМ" min={debtMin} max={debtMax} onChange={(mn, mx) => { setDebtMin(mn); setDebtMax(mx); }} /></div>
        <div><PeriodFilter label="ДЕДЛАЙН" from={dlFrom} to={dlTo} onChange={(f, t) => { setDlFrom(f); setDlTo(t); }} align="right" /></div>
        {!isMobile && <div />}
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="Нет согласованных смет с задолженностью" />
      ) : (
        <>
          {filtered.map((d: any, i: number) => {
            const rowId = String(d.id || d.number || i);
            return isMobile ? (
              <RowCard key={i} onClick={() => navigate(`/orders/${d.number}`)}
                title={d.customer_name || "—"} sub={d.title}
                right={<span style={{ color: debtColor(d.debt, "in") }}>{fmt(d.debt)}</span>}
                rightSub={<>из {fmt(d.price_plan)}</>}
                badge={<><span style={{ fontSize: 11, color: "#6B6355" }}>{d.status_label || d.status}</span><DeadlinePill date={d.deadline} /></>}
                meta={<>оплачено <span style={{ color: "#4A7C59", fontFamily: MONO }}>{fmt(d.paid_total)}</span></>}
                trailing={<IconButton icon={LinkSimple} title="Связать с транзакцией" size={36} iconSize={15}
                  color={d.finance_tx_id ? "#4A7C59" : "#C8C0B0"} onClick={e => { e.stopPropagation(); setLinkItem(d); }} />}
              />
            ) : (
            <div
              key={i}
              onClick={() => navigate(`/orders/${d.number}`)}
              style={{
                display: "grid", gridTemplateColumns: debtorCols,
                padding: "13px 28px", borderBottom: "1px solid #F2EFE9",
                cursor: "pointer", alignItems: "center", transition: "background 0.1s",
                fontFamily: MONO, fontVariantNumeric: "tabular-nums",
                background: selectedIds.has(rowId) ? "#FFF8F5" : "transparent",
              }}
              onMouseEnter={(e) => { if (!selectedIds.has(rowId)) e.currentTarget.style.background = "#FAF8F5"; }}
              onMouseLeave={(e) => { if (!selectedIds.has(rowId)) e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ display: "flex", alignItems: "center" }}>
                <Checkbox checked={selectedIds.has(rowId)} onChange={() => toggleSelect(rowId)} />
              </div>
              <div style={{ fontFamily: SANS }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{d.customer_name || "—"}</div>
                <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>{d.title}</div>
              </div>
              <div style={{ fontSize: 12, color: "#6B6355", fontFamily: SANS }}>{d.status_label || d.status}</div>
              <div style={{ fontSize: 13, color: "#1A1A1A" }}>{fmt(d.price_plan)}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, color: "#4A7C59" }}>{fmt(d.paid_total)}</span>
                {d.paid_bank > 0 && <Bank size={11} style={{ color: "#4A7C59" }} />}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: debtColor(d.debt, "in") }}>{fmt(d.debt)}</div>
              <div><DeadlinePill date={d.deadline} /></div>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <IconButton icon={LinkSimple} title="Связать с транзакцией" size={24} iconSize={13}
                  color={d.finance_tx_id ? "#4A7C59" : "#C8C0B0"}
                  onClick={e => { e.stopPropagation(); setLinkItem(d); }} />
              </div>
            </div>
            );
          })}

          <div style={{
            display: "grid", gridTemplateColumns: debtorCols,
            padding: "10px 28px", borderTop: `2px solid ${POLARITY.in.rail}`,
            alignItems: "center", background: POLARITY.in.tint,
            fontFamily: MONO, fontVariantNumeric: "tabular-nums",
            ...(isMobile ? { display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 16px" } : null),
          }}>
            <div />
            <div style={{ fontSize: 11, color: "#A89070", fontFamily: SANS }}>{filtered.length} заказов</div>
            <div />
            <div style={{ fontSize: 12, color: "#6B6355", fontWeight: 500 }}>{fmt(totalPlan)}</div>
            <div style={{ fontSize: 12, color: "#4A7C59", fontWeight: 500 }}>{fmt(totalPaid)}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: debtColor(total, "in") }}>{fmt(total)}</div>
            <div /><div />
          </div>
        </>
      )}

      {/* Потенциальная выручка — заказы «Ждёт оплаты». Сознательно НЕ дебиторка
          (решение Юры 28.07.2026): счёт выставлен, но работа не началась — это
          ориентир «сколько получу, если дожму», а не долг клиента. */}
      {!!data?.settled?.length && (
        <div style={{ marginTop: 28, padding: "0 28px" }}>
          <div onClick={() => setSettledOpen(v => !v)}
            style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4, cursor: "pointer", userSelect: "none" }}>
            <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>РАСЧЁТЫ ЗАКРЫТЫ</span>
            <span style={{ fontSize: 11, color: "#C8C0B0" }}>
              · {data.settled_count} · не привязано <span style={{ fontFamily: MONO }}>{fmt(data.settled_unlinked_total)}</span> · {settledOpen ? "свернуть" : "показать"}
            </span>
          </div>
          {settledOpen && data.settled.map((s: any) => (
            <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
                                     padding: "9px 0", borderBottom: "1px solid #F2EFE9", fontSize: 12, flexWrap: "wrap" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "#1A1A1A", fontWeight: 500 }}>{s.customer_name || "—"} · <OrderLink id={s.id}>{s.title}</OrderLink></div>
                <div style={{ fontSize: 10, color: "#A89070", marginTop: 2 }}>
                  {s.status_label} · закрыто {String(s.settled_at || "").slice(0, 10)}{s.settled_note ? ` · ${s.settled_note}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                <span style={{ fontFamily: MONO, color: "#A89070" }}>{fmt(s.paid_total)} из {fmt(s.price_plan)}</span>
                <span style={{ fontFamily: MONO, color: "#6B6355" }}>не привязано {fmt(s.unlinked)}</span>
                <button type="button" onClick={() => unsettle.mutate(s.id)} disabled={unsettle.isPending}
                  style={{ fontSize: 10, color: "#8B3A3A", background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                  открыть
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!!data?.potential?.length && (
        <div style={{ marginTop: 28, padding: "0 28px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>ПОТЕНЦИАЛЬНАЯ ВЫРУЧКА</span>
            <span style={{ fontSize: 11, color: "#C8C0B0" }}>· {data.potential.length}</span>
          </div>
          <div style={{ fontSize: 11, color: "#A89070", marginBottom: 10 }}>
            Заказы со статусом «Ждёт оплаты»: счёт выставлен, работа не началась. Ориентир, а не долг — в дебиторку не входит.
          </div>
          {data.potential.map((p: any) => (
            <div key={p.id} onClick={() => navigate(`/orders/${p.id}`)}
              style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 120px 120px 130px", gap: 12,
                       alignItems: "center", padding: "9px 0", borderBottom: "1px solid #F2EFE9",
                       cursor: "pointer", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
              onMouseLeave={e => (e.currentTarget.style.background = "")}>
              <span style={{ fontSize: 13, color: "#1A1A1A", fontFamily: SANS, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
              <span style={{ fontSize: 12, color: "#6B6355", fontFamily: SANS, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.customer_name || "—"}</span>
              <span style={{ fontSize: 13, textAlign: "right" }}>{fmt(p.price_plan)}</span>
              <span style={{ fontSize: 12, textAlign: "right", color: p.paid_total ? "#4A7C59" : "#C8C0B0" }}>{p.paid_total ? fmt(p.paid_total) : "—"}</span>
              <span style={{ fontSize: 13, fontWeight: 600, textAlign: "right", color: "#B8860B" }}>{fmt(p.rest)}</span>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "10px 0", alignItems: "baseline" }}>
            <span style={{ fontSize: 11, color: "#A89070" }}>если дожать по оплате</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#B8860B", fontFamily: MONO }}>{fmt(data.potential_total)}</span>
          </div>
        </div>
      )}
    </>
  );
}

// ── Модал: добавить счёт в нераспределённые ───────────────────────────────

function AddReceivableModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [client, setClient] = useState("");
  const [inn, setInn] = useState("");
  const [invoiceNum, setInvoiceNum] = useState("");
  // Дата счёта по умолчанию — сегодня: счёт почти всегда заводится днём выставления.
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const { mutate, isPending } = useMutation({
    mutationFn: () => financeApi.createReceivable({
      client: client.trim(),
      inn: inn.trim() || undefined,
      invoice_num: invoiceNum.trim() || undefined,
      invoice_date: invoiceDate || undefined,
      amount: parseFloat(amount) || 0,
      note: note.trim() || undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["receivables"] }); onClose(); },
    onError: (e: any) => setError(e?.response?.data?.detail || "Не удалось сохранить"),
  });

  return (
    <Modal
      size="md"
      eyebrow="НОВЫЙ СЧЁТ"
      onClose={onClose}
      onCancel={onClose}
      onSave={() => mutate()}
      saveLabel="Добавить"
      saving={isPending}
      canSave={!!client.trim() && !!amount}
    >
        <div style={{ padding: "18px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>КЛИЕНТ *</div>
            <input value={client} onChange={e => setClient(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }}
              placeholder="ООО «Название»" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ИНН</div>
              <input value={inn} onChange={e => setInn(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>СУММА, ₽ *</div>
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }}
                placeholder="0" />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>№ СЧЁТА</div>
              <input value={invoiceNum} onChange={e => setInvoiceNum(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ДАТА СЧЁТА</div>
              <input type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>НАЗНАЧЕНИЕ</div>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
              style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none", resize: "vertical", fontFamily: "inherit" }} />
          </div>
        </div>
      {error && <div style={{ padding: "0 24px 12px", fontSize: 11, color: "#8B3A3A" }}>{error}</div>}
    </Modal>
  );
}

// ── Вкладка: нераспределённые счета (receivables из вики) ─────────────────

function UnallocatedTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["receivables"], queryFn: financeApi.receivables });
  const [editId, setEditId] = useState<number | null>(null);
  const [paidDraft, setPaidDraft] = useState("");
  const [linkItem, setLinkItem] = useState<any>(null);
  const [clientF, setClientF] = useState("");
  const [noteF, setNoteF] = useState("");
  const [invFrom, setInvFrom] = useState("");
  const [invTo, setInvTo] = useState("");
  const [paidMin, setPaidMin] = useState("");
  const [paidMax, setPaidMax] = useState("");
  const [debtMin, setDebtMin] = useState("");
  const [debtMax, setDebtMax] = useState("");
  const clearFilters = () => { setClientF(""); setNoteF(""); setInvFrom(""); setInvTo(""); setPaidMin(""); setPaidMax(""); setDebtMin(""); setDebtMax(""); };

  const update = useMutation({
    mutationFn: ({ id, paid }: { id: number; paid: number }) =>
      financeApi.updateReceivable(id, { paid }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["receivables"] }); setEditId(null); },
  });

  const linkRec = useMutation({
    mutationFn: ({ id, txId }: { id: number; txId: string | null }) =>
      financeApi.updateReceivable(id, { finance_tx_id: txId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["receivables"] }); setLinkItem(null); },
  });

  const items: any[] = data?.open_items || [];

  if (isLoading) return <Loading />;
  if (items.length === 0) return <EmptyState title="Нет нераспределённых счетов" />;

  const recCols = "2fr 2fr 120px 120px 120px 28px";
  const uniqueClients = [...new Set(items.map((r: any) => r.client).filter(Boolean))].sort() as string[];
  const uniqueNotes = [...new Set(items.map((r: any) => r.note).filter(Boolean))].sort() as string[];
  const hasFilters = !!(clientF || noteF || invFrom || invTo || paidMin || paidMax || debtMin || debtMax);
  const filtered = items.filter((r: any) => {
    if (clientF && r.client !== clientF) return false;
    if (noteF && r.note !== noteF) return false;
    if (invFrom && (!r.invoice_date || r.invoice_date.slice(0, 10) < invFrom)) return false;
    if (invTo && (!r.invoice_date || r.invoice_date.slice(0, 10) > invTo)) return false;
    if (paidMin && (r.paid || 0) < parseFloat(paidMin)) return false;
    if (paidMax && (r.paid || 0) > parseFloat(paidMax)) return false;
    if (debtMin && (r.debt || 0) < parseFloat(debtMin)) return false;
    if (debtMax && (r.debt || 0) > parseFloat(debtMax)) return false;
    return true;
  });

  return (
    <>
      {linkItem && (
        <LinkInTxModal
          title={linkItem.client}
          name={linkItem.client}
          amount={linkItem.debt}
          linkedTxId={linkItem.finance_tx_id}
          onLink={(txId) => linkRec.mutate({ id: linkItem.id, txId })}
          onClose={() => setLinkItem(null)}
        />
      )}
      {/* Проверка на дубли с заказами не отработала — молчать нельзя: экран без
          пометок читается как «дублей нет», и долг посчитается дважды */}
      {data?.duplicates_checked === false && (
        <div style={{ padding: "8px 28px", background: "#FAF8F5", borderBottom: "1px solid #EDEBE6", fontSize: 11, color: "#8B3A3A" }}>
          ⚠ Сверка с заказами не выполнена{data?.duplicates_error ? `: ${data.duplicates_error}` : ""} — пометки «похоже на заказ» сейчас не показываются.
        </div>
      )}
      <div style={{ padding: "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#6B6355" }}>{filtered.length} счетов</span>
          <button type="button" onClick={hasFilters ? clearFilters : undefined} style={{ fontSize: 10, color: hasFilters ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: hasFilters ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
            <X size={10} /> Сбросить
          </button>
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#4A7C59", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(data?.total_debt ?? 0)}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: recCols, padding: "6px 28px 6px", borderBottom: "1px solid #EDEBE6" }}>
        <div><ColumnFilter label="КЛИЕНТ" options={uniqueClients} value={clientF} onChange={setClientF} /></div>
        <div><ColumnFilter label="НАЗНАЧЕНИЕ" options={uniqueNotes} value={noteF} onChange={setNoteF} /></div>
        <div><PeriodFilter label="СЧЁТ" from={invFrom} to={invTo} onChange={(f, t) => { setInvFrom(f); setInvTo(t); }} /></div>
        <div><AmountFilter label="ОПЛАЧЕНО" min={paidMin} max={paidMax} onChange={(mn, mx) => { setPaidMin(mn); setPaidMax(mx); }} /></div>
        <div><AmountFilter label="ОСТАТОК" min={debtMin} max={debtMax} onChange={(mn, mx) => { setDebtMin(mn); setDebtMax(mx); }} align="right" /></div>
        <div />
      </div>

      {filtered.map((r: any) => (
        <div key={r.id}>
          <div
            onClick={() => { setEditId(editId === r.id ? null : r.id); setPaidDraft(String(r.paid ?? 0)); }}
            style={{
              display: "grid", gridTemplateColumns: recCols,
              padding: "11px 28px", borderBottom: "1px solid #F2EFE9",
              cursor: "pointer", alignItems: "center", transition: "background 0.1s",
              fontFamily: MONO, fontVariantNumeric: "tabular-nums",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
          >
            <div style={{ fontFamily: SANS }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{r.client}</div>
              {r.inn && <div style={{ fontSize: 10, color: "#A89070", marginTop: 1 }}>ИНН {r.inn}</div>}
              {/* Тот же долг может уже висеть на заказе — складывать нельзя, пока не сверил */}
              {r.duplicate_of && (
                <div title={`Долг по заказу: ${fmt(r.duplicate_of.debt)}. Счёт и заказ — один и тот же долг: сверь и разнеси, иначе посчитается дважды.`}
                  style={{ fontSize: 10, color: "#B8860B", marginTop: 2 }}>
                  ⚠ похоже на заказ {r.duplicate_of.number} · {r.duplicate_of.title}
                </div>
              )}
            </div>
            <div style={{ fontSize: 11, color: "#6B6355", paddingRight: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: SANS }}>
              {r.note || "—"}
            </div>
            <div style={{ fontSize: 11, color: "#A89070" }}>
              {r.invoice_num && <span>№{r.invoice_num}</span>}
              {r.invoice_date && <div style={{ fontSize: 10, marginTop: 1 }}>{fmtDate(r.invoice_date)}</div>}
            </div>
            <div style={{ fontSize: 13, color: "#4A7C59" }}>{r.paid > 0 ? fmt(r.paid) : "—"}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#4A7C59" }}>{fmt(r.debt)}</div>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <IconButton icon={LinkSimple} title="Связать с транзакцией" size={24} iconSize={13}
                color={r.finance_tx_id ? "#4A7C59" : "#C8C0B0"}
                onClick={e => { e.stopPropagation(); setLinkItem(r); }} />
            </div>
          </div>

          {editId === r.id && (
            <div style={{ padding: "10px 28px 12px", background: "#FAF8F5", borderBottom: "1px solid #EDEBE6", display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 11, color: "#A89070" }}>Отметить оплаченным:</div>
              <input
                type="number" value={paidDraft} onChange={e => setPaidDraft(e.target.value)}
                style={{ width: 120, border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none" }}
                placeholder="Сумма ₽"
              />
              <button type="button"
                onClick={() => update.mutate({ id: r.id, paid: parseFloat(paidDraft) || 0 })}
                style={{ padding: "5px 14px", border: "none", background: "#4A7C59", color: "#fff", fontSize: 11, cursor: "pointer", fontWeight: 600 }}
              >
                Сохранить
              </button>
              <button type="button" onClick={() => setEditId(null)}
                style={{ padding: "5px 10px", border: "1px solid #EDEBE6", background: "none", fontSize: 11, cursor: "pointer", color: "#A89070" }}>
                ✕
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

// ── Модал: связать обязательство с транзакцией ────────────────────────────

function LinkTxModal({ creditor, onClose }: { creditor: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"finance" | "zen">("finance");
  const [search, setSearch] = useState("");

  const { data: finTxs = [], isFetching: finLoading } = useQuery({
    queryKey: ["suggest-tx", creditor.id, tab],
    queryFn: () => financeApi.suggestTx(creditor.name, creditor.total),
    enabled: tab === "finance",
  });
  const { data: zenTxs = [], isFetching: zenLoading } = useQuery({
    queryKey: ["suggest-zen", creditor.id, tab],
    queryFn: () => zenmoneyApi.suggest(creditor.name, creditor.total),
    enabled: tab === "zen",
  });

  const link = useMutation({
    mutationFn: (data: { finance_tx_id?: string | null; zenmoney_tx_id?: string | null; paid?: number }) =>
      financeApi.updateCreditor(creditor.id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["creditors"] }); qc.invalidateQueries({ queryKey: ["fixed-obligations"] }); onClose(); },
  });

  const txs: any[] = tab === "finance" ? (finTxs as any[]) : (zenTxs as any[]);
  const loading = tab === "finance" ? finLoading : zenLoading;
  const linkedId = tab === "finance" ? creditor.finance_tx_id : creditor.zenmoney_tx_id;

  const filtered = search
    ? txs.filter((t: any) => {
        const label = ((t.counterparty || t.payee || "") + " " + (t.purpose || t.comment || "")).toLowerCase();
        return label.includes(search.toLowerCase());
      })
    : txs;

  function fmtAmt(n: number) {
    return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
  }

  return (
    <Modal size="md" eyebrow="ПРИВЯЗАТЬ ТРАНЗАКЦИЮ" onClose={onClose}>
        {/* Header */}
        <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid #F2EFE9" }}>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1A1A" }}>{creditor.name}</div>
            <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>{fmtAmt(creditor.total)} · долг {fmtAmt(creditor.debt)}</div>
          </div>
          {/* Source tabs */}
          <div style={{ display: "flex", gap: 0 }}>
            {([["finance", "ДДС (банк)"], ["zen", "Личные финансы"]] as const).map(([id, label]) => (
              <button type="button" key={id} onClick={() => setTab(id)}
                style={{
                  padding: "4px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", border: "1px solid",
                  borderColor: tab === id ? "#1A1A1A" : "#EDEBE6",
                  background: tab === id ? "#1A1A1A" : "transparent",
                  color: tab === id ? "#fff" : "#A89070", marginRight: -1,
                }}>{label}</button>
            ))}
          </div>
        </div>

        {/* Already linked */}
        {linkedId && (
          <div style={{ padding: "8px 20px", background: "#F2FDF5", borderBottom: "1px solid #D0EDD8", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 11, color: "#4A7C59" }}>
              <LinkSimple size={11} style={{ marginRight: 4 }} />
              Привязана транзакция
            </div>
            <button type="button"
              onClick={() => link.mutate(tab === "finance" ? { finance_tx_id: null, paid: 0 } : { zenmoney_tx_id: null, paid: 0 })}
              style={{ fontSize: 11, color: "#8B3A3A", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >Отвязать</button>
          </div>
        )}

        {/* Search */}
        <div style={{ padding: "8px 20px", borderBottom: "1px solid #F2EFE9" }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Поиск по контрагенту..."
            style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "5px 10px", fontSize: 12, outline: "none" }} />
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {loading && <Loading compact />}
          {!loading && filtered.length === 0 && <EmptyState compact title="Транзакции не найдены" />}
          {!loading && filtered.map((t: any) => {
            const isLinked = String(t.id) === String(linkedId);
            const label = t.counterparty || t.payee || t.purpose || t.comment || "—";
            const amt = t.amount ?? (t.outcome || 0);
            return (
              <div key={t.id}
                onClick={() => link.mutate(tab === "finance" ? { finance_tx_id: String(t.id), paid: amt } : { zenmoney_tx_id: String(t.id), paid: amt })}
                style={{
                  display: "grid", gridTemplateColumns: "80px 1fr 100px",
                  padding: "9px 20px", borderBottom: "1px solid #F2EFE9", cursor: "pointer",
                  background: isLinked ? "#F2FDF5" : "transparent", alignItems: "center", gap: 10,
                }}
                onMouseEnter={e => { if (!isLinked) e.currentTarget.style.background = "#FAF8F5"; }}
                onMouseLeave={e => { if (!isLinked) e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{ fontSize: 11, color: "#A89070" }}>{(t.date || "").slice(0, 10)}</div>
                <div style={{ fontSize: 12, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {label}
                  {t.purpose && t.counterparty && <div style={{ fontSize: 10, color: "#A89070", marginTop: 1 }}>{t.purpose}</div>}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#8B3A3A", textAlign: "right" }}>
                  −{fmtAmt(amt)}
                  {isLinked && <LinkSimple size={10} style={{ color: "#4A7C59", marginLeft: 4 }} />}
                </div>
              </div>
            );
          })}
        </div>
    </Modal>
  );
}

// ── Вкладка: кредиторы ─────────────────────────────────────────────────────

// ПЛАН · ФАКТ · ОСТАТОК: «оплачено» переехало в «факт» — деньги подрядчику чаще
// уходят расходом, чем отметкой оплаты (ТЗ обязательств 04.08.2026), а колонка
// «отклонение» ушла: при плане из сметы отклонение — это и есть остаток.
const creditorCols = "28px 1.8fr 1.5fr 110px 130px 110px 90px 28px";

// «Осталось потратить по заказам в работе» (ТЗ 03.09.2026, п.10): обязательства
// смет — план закупок за вычетом факта, прогноз, не долг. Долг перед человеком —
// сальдо лицевого счёта (LedgerTab). Незапущенные заказы и покрытые/признанные
// строки спрятаны за переключателями: по умолчанию видно только то, что ещё
// предстоит потратить.
function CreditorsTab() {
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [showUnstarted, setShowUnstarted] = useState(false);
  const [showSettled, setShowSettled] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [linkItem, setLinkItem] = useState<any>(null);
  // Какую плашку «закрыть по …» открыли: завершённые (в «Мы должны»), отменённые
  // и архивные (во вкладке «План»). Одно состояние, не три булевых.
  const [staleKind, setStaleKind] = useState<"completed" | "cancelled" | "archived" | "internal" | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [contragentFilter, setContragentFilter] = useState("");
  const [descFilter, setDescFilter] = useState("");
  const [cPlanMin, setCPlanMin] = useState("");
  const [cPlanMax, setCPlanMax] = useState("");
  const [cPaidMin, setCPaidMin] = useState("");
  const [cPaidMax, setCPaidMax] = useState("");
  const [varMin, setVarMin] = useState("");
  const [varMax, setVarMax] = useState("");
  const [cDebtMin, setCDebtMin] = useState("");
  const [cDebtMax, setCDebtMax] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const clearFilters = () => { setContragentFilter(""); setDescFilter(""); setCPlanMin(""); setCPlanMax(""); setCPaidMin(""); setCPaidMax(""); setVarMin(""); setVarMax(""); setCDebtMin(""); setCDebtMax(""); setDueFrom(""); setDueTo(""); setSelectedIds(new Set()); };
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const { data, isLoading } = useQuery({
    queryKey: ["creditors", { include_unstarted: showUnstarted }],
    queryFn: () => financeApi.creditors(undefined, { include_unstarted: showUnstarted }),
  });

  // Массовые действия к выделению. Чекбоксы и «выделить всё» были с самого
  // начала, но действий к ним не было ни одного — выделил 12 обязательств и
  // мог только посмотреть на сумму. Цикл по существующим ручкам — тот же
  // приём, что bulkDelete в списке заказов.
  const [bulkAction, setBulkAction] = useState<"close" | "delete" | null>(null);
  const bulkMutation = useMutation({
    mutationFn: async ({ ids, action, reason }: { ids: string[]; action: "close" | "delete"; reason?: "manual" | "recognized" }) => {
      // Закрытие — одним запросом, всё или ничего; причину (списать / признать
      // долгом) и дельту сальдо показывает ObligationsConfirmModal. Удаление —
      // по одному: строка, по которой прошли деньги, ответит 409 и цикл встанет.
      if (action === "close") { await financeApi.closeCreditors(ids, reason ?? "manual"); return; }
      for (const id of ids) await financeApi.deleteCreditor(id);
    },
    onSuccess: () => {
      setBulkAction(null);
      setBulkError(null);
      setSelectedIds(new Set());
      qc.invalidateQueries({ queryKey: ["creditors"] });
      qc.invalidateQueries({ queryKey: ["orders-v2"] });
      qc.invalidateQueries({ queryKey: ["ledger-balances"] });
      qc.invalidateQueries({ queryKey: ["ledger"] });
    },
    onError: (e: any) => {
      setBulkAction(null);
      const d = e?.response?.data?.detail;
      setBulkError(d?.message || "Не удалось выполнить — ничего не изменено");
      qc.invalidateQueries({ queryKey: ["creditors"] });
    },
  });

  // scope с бэка: debt — живые заказы (производство, завершённые) и ручные;
  // plan — незапущенные (приходят только с include_unstarted). covered/recognized —
  // остатка нет или долг сверен в лицевом счёте: показываем по переключателю.
  const allItems: any[] = data?.items || [];
  const hiddenSettled = allItems.filter((c: any) => (c.covered || c.recognized) && !showSettled).length;
  const items: any[] = allItems.filter((c: any) => showSettled || !(c.covered || c.recognized));
  const uniqueContragents = useMemo(() => [...new Set(items.map((c: any) => c.name).filter(Boolean))].sort() as string[], [items]);
  const uniqueDescriptions = useMemo(() => [...new Set(items.map((c: any) => c.description).filter(Boolean))].sort() as string[], [items]);
  const { sort, toggle: toggleSort, apply: applySort } = useTableSort();
  const SORT_GETTERS: Record<string, (c: any) => any> = {
    name: (c) => c.name,
    description: (c) => c.description || null,
    plan: (c) => (c.amount_plan ?? c.total) || 0,
    fact: (c) => (c.fact ?? c.paid) || 0,
    debt: (c) => c.debt || 0,
    due: (c) => c.due_date || null,
  };
  const filteredItems = useMemo(() => {
    let r = items;
    if (contragentFilter) r = r.filter((c: any) => c.name === contragentFilter);
    if (descFilter) r = r.filter((c: any) => c.description === descFilter);
    if (cPlanMin) r = r.filter((c: any) => ((c.amount_plan ?? c.total) || 0) >= parseFloat(cPlanMin));
    if (cPlanMax) r = r.filter((c: any) => ((c.amount_plan ?? c.total) || 0) <= parseFloat(cPlanMax));
    if (cPaidMin) r = r.filter((c: any) => ((c.fact ?? c.paid) || 0) >= parseFloat(cPaidMin));
    if (cPaidMax) r = r.filter((c: any) => ((c.fact ?? c.paid) || 0) <= parseFloat(cPaidMax));
    if (cDebtMin) r = r.filter((c: any) => (c.debt || 0) >= parseFloat(cDebtMin));
    if (cDebtMax) r = r.filter((c: any) => (c.debt || 0) <= parseFloat(cDebtMax));
    if (dueFrom) r = r.filter((c: any) => c.due_date && c.due_date.slice(0, 10) >= dueFrom);
    if (dueTo) r = r.filter((c: any) => c.due_date && c.due_date.slice(0, 10) <= dueTo);
    return applySort(r, SORT_GETTERS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, contragentFilter, descFilter, cPlanMin, cPlanMax, cPaidMin, cPaidMax, varMin, varMax, cDebtMin, cDebtMax, dueFrom, dueTo, sort]);

  // Итоги — по видимым строкам: серверные спорили бы с включённым фильтром
  // («сумма строк ≠ итог», code_rules 02.08).
  const totalOwed = filteredItems.reduce((s: number, c: any) => s + ((c.amount_plan ?? c.total) || 0), 0);
  const totalPaid = filteredItems.reduce((s: number, c: any) => s + ((c.fact ?? c.paid) || 0), 0);
  const totalDebt = filteredItems.reduce((s: number, c: any) => s + (c.debt || 0), 0);

  const closeStale = useMutation({
    mutationFn: ({ kind, ids }: { kind: string; ids: string[] }) => financeApi.closeStale({ kinds: [kind], only_ids: ids }),
    onSuccess: () => {
      setStaleKind(null);
      qc.invalidateQueries({ queryKey: ["creditors"] });
      qc.invalidateQueries({ queryKey: ["orders-v2"] });
      qc.invalidateQueries({ queryKey: ["ledger"] });
    },
  });
  // Плашки «неактуальное»: в «Мы должны» — завершённые заказы, во вкладке «План» —
  // отменённые и архивные. Бэк отдаёт stale[kind] = {count, total, orders[]}.
  const STALE_UI: Record<string, { label: string; intro: string; eyebrow: string }> = {
    completed: { eyebrow: "ЗАКРЫТЬ ПО ЗАВЕРШЁННЫМ", label: "завершённым",
      intro: "Заказы сданы и оплачены, а обязательства по их сметам открыты — план, по которому деньги уже прошли расходами. Закрыть — признать расчёты законченными: остатки спишутся. Вернёшь заказ в работу — переоткроются." },
    cancelled: { eyebrow: "ЗАКРЫТЬ ПО ОТМЕНЁННЫМ", label: "отменённым",
      intro: "Заказы отменены, подрядчикам по ним ничего не заказано, а план сметы всё ещё начисляется в их сальдо. Закрыть — снять его из «Расчётов с подрядчиками». Сними галочку, если реально должны." },
    archived: { eyebrow: "ЗАКРЫТЬ ПО АРХИВНЫМ", label: "архивным",
      intro: "Заказы в архиве, а обязательства по их сметам открыты и начисляются подрядчикам полным планом. Закрыть — снять из сальдо; вернёшь заказ из архива — переоткроются." },
    // Резерв 5/10/15 %, наценка, округление — подушка внутри цены, никому не должны.
    // Утверждение таких обязательств больше не создаёт; эти — из старых смет.
    internal: { eyebrow: "ВНУТРЕННИЕ СТРОКИ СМЕТ", label: "внутренним строкам (резерв, наценка)",
      intro: "Строки без получателя денег — резерв на непредвиденное, наценка, округление. В себестоимости остаются, а обязательством быть не должны: их никто не ждёт. Закрыть — убрать из плана трат; сальдо подрядчиков не изменится." },
  };
  const staleKinds = showUnstarted ? ["completed", "cancelled", "archived", "internal"] : ["completed", "internal"];
  const toUnpaid = (c: any): Unpaid => ({
    id: c.id, name: c.description || c.name, plan: c.amount_plan ?? c.total, fact: c.fact ?? c.paid,
    debt: c.debt, ambiguous: c.ambiguous, recognized: c.recognized, recognized_amount: c.recognized_amount,
    order: c.order_number ? `${c.order_number} · ${c.order_title}` : undefined,
  });
  const staleItems: Unpaid[] = staleKind
    ? allItems.filter((c: any) => (staleKind === "internal" ? c.no_payee && !(c.fact > 0) : c.stale_kind === staleKind)
                                  && (c.status === "open" || c.status === "partial")).map(toUnpaid)
    : [];
  const STALE_REASON: Record<string, string> = { completed: "order_completed", cancelled: "order_cancelled", archived: "order_archived", internal: "internal" };
  const selectedItems: Unpaid[] = allItems.filter((c: any) => selectedIds.has(String(c.id))).map(toUnpaid);

  if (isLoading) return <Loading />;

  return (
    <>
      {addOpen && <AddCreditorModal onClose={() => setAddOpen(false)} />}
      {editItem && <PayCreditorModal item={editItem} onClose={() => setEditItem(null)} />}
      {linkItem && <LinkTxModal creditor={linkItem} onClose={() => setLinkItem(null)} />}
      {bulkAction === "delete" && (
        <ConfirmModal
          message={`Удалить ${selectedIds.size} обязательств(а) безвозвратно? Расходы и платежи не затрагиваются — удаляется только строка плана.`}
          confirmLabel={bulkMutation.isPending ? "Выполняем..." : "Удалить"}
          onConfirm={() => bulkMutation.mutate({ ids: [...selectedIds], action: "delete" })}
          onCancel={() => setBulkAction(null)}
        />
      )}
      {bulkAction === "close" && (
        <ObligationsConfirmModal
          eyebrow="ЗАКРЫТЬ ВЫБРАННЫЕ" saveLabel="Закрыть"
          intro={<>Выбрано строк: <b>{selectedItems.length}</b>. Закрытие говорит «эта плановая строка больше не ждёт
            денег». Что при этом происходит с долгом перед мастером — выбери ниже; как изменится его сальдо, видно
            до кнопки.</>}
          items={selectedItems} total={selectedItems.reduce((s, i) => s + i.debt, 0)} saving={bulkMutation.isPending}
          reasonChoice
          onConfirm={(ids, reason) => bulkMutation.mutate({ ids, action: "close", reason })}
          onCancel={() => setBulkAction(null)}
        />
      )}
      {staleKind && (
        <ObligationsConfirmModal
          eyebrow={STALE_UI[staleKind].eyebrow} saveLabel="Закрыть"
          intro={STALE_UI[staleKind].intro}
          items={staleItems} total={data?.stale?.[staleKind]?.total ?? 0} saving={closeStale.isPending}
          previewReason={STALE_REASON[staleKind]}
          onConfirm={ids => closeStale.mutate({ kind: staleKind, ids })}
          onCancel={() => setStaleKind(null)}
        />
      )}

      {(data?.looks_done?.length ?? 0) > 0 && (
        <div style={{ margin: isMobile ? "10px 16px 0" : "12px 28px 0", padding: "11px 14px", background: "#F3F7F4",
                      borderLeft: "3px solid #4A7C59", fontSize: 12, color: "#6B6355", lineHeight: 1.5 }}>
          <div style={{ marginBottom: 6 }}>
            <b style={{ color: "#4A7C59" }}>Похоже, завершены:</b> оплачены целиком, а статус ещё «в производстве».
            Завершение закроет расчёты по ним; открытый остаток сметы спишется или останется долгом — решишь в окне.
          </div>
          {data.looks_done.map((o: any) => (
            <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0",
                                     borderTop: "1px solid #DCE8DF", flexWrap: "wrap" }}>
              <span style={{ flex: 1, minWidth: 160 }}>
                <OrderLink id={o.id}>{o.title}</OrderLink>
                <span style={{ color: "#A89070" }}> · оплачено {fmt(o.paid_total)}{o.open_rest > 0 ? ` · по смете открыто ${fmt(o.open_rest)}` : ""}</span>
              </span>
              <CompleteOrderButton orderId={o.id} />
            </div>
          ))}
        </div>
      )}

      <div style={{ margin: isMobile ? "10px 16px 0" : "12px 28px 0", padding: "11px 14px", background: "#FBF7EF",
                    borderLeft: "3px solid #B8860B", fontSize: 12, color: "#6B6355", lineHeight: 1.5,
                    display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        <span>
          План закупок и работ из утверждённых смет за вычетом факта — <b style={{ color: "#B8860B" }}>прогноз, не долг</b>.
          Сколько мы должны каждому человеку — во вкладке «Мы должны» (лицевые счета).
        </span>
        <span style={{ display: "flex", gap: 14, whiteSpace: "nowrap" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontSize: 11 }}>
            <input type="checkbox" checked={showUnstarted} onChange={e => { setShowUnstarted(e.target.checked); setSelectedIds(new Set()); }}
                   style={{ accentColor: "#E8592A" }} />
            незапущенные заказы
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontSize: 11 }}>
            <input type="checkbox" checked={showSettled} onChange={e => { setShowSettled(e.target.checked); setSelectedIds(new Set()); }}
                   style={{ accentColor: "#E8592A" }} />
            покрытые и признанные{hiddenSettled > 0 ? ` (${hiddenSettled})` : ""}
          </label>
        </span>
      </div>

      {(data?.double_sets?.length ?? 0) > 0 && (
        <div style={{ margin: isMobile ? "10px 16px 0" : "12px 28px 0", padding: "11px 14px", background: "#FBF3F3",
                      borderLeft: "3px solid #8B3A3A", fontSize: 12, color: "#6B6355", lineHeight: 1.5 }}>
          <b style={{ color: "#8B3A3A" }}>Двойной комплект обязательств:</b> открытые строки одного заказа пришли из разных
          смет — проверить, какая версия живая.
          {data.double_sets.map((d: any) => (
            <div key={d.order_id} style={{ marginTop: 4 }}>
              <OrderLink id={d.order_id}>{d.title}</OrderLink>
              {": "}{d.sets.map((s: any) => `${s.title || "без названия"} (${s.status}, ${s.count} на ${fmt(s.total)})`).join(" · ")}
            </div>
          ))}
        </div>
      )}
      {(data?.double_accrual?.length ?? 0) > 0 && (
        <div style={{ margin: isMobile ? "10px 16px 0" : "12px 28px 0", padding: "11px 14px", background: "#FBF3F3",
                      borderLeft: "3px solid #8B3A3A", fontSize: 12, color: "#6B6355", lineHeight: 1.5 }}>
          <b style={{ color: "#8B3A3A" }}>Похоже на двойное начисление:</b> ручная проводка лицевого счёта по заказу
          без привязки к строке, а в заказе открыта строка на ту же сумму — сальдо считает обе.
          {" "}{data.double_accrual.slice(0, 4).map((d: any) => `${d.master_name} ${fmt(d.amount)} (${d.order_number})`).join("; ")}
          {data.double_accrual.length > 4 ? ` и ещё ${data.double_accrual.length - 4}` : ""}. Сверить с фин-агентом.
        </div>
      )}

      {staleKinds.map(kind => {
        const st = data?.stale?.[kind];
        if (!st || !st.count) return null;
        return (
          <div key={kind} style={{ margin: isMobile ? "10px 16px 0" : "12px 28px 0", padding: "11px 14px", background: "#FBF7EF",
                        borderLeft: "3px solid #B8860B", display: "flex", alignItems: "center",
                        justifyContent: "space-between", gap: 16, flexWrap: isMobile ? "wrap" : undefined }}>
            <div style={{ fontSize: 12, color: "#6B6355", lineHeight: 1.5 }}>
              По {STALE_UI[kind].label} заказам открыто <b>{st.count} строк на {fmt(st.total)}</b>
              {st.orders?.length ? <> — {st.orders.slice(0, 3).map((o: any) => o.title).join(", ")}{st.orders.length > 3 ? ` и ещё ${st.orders.length - 3}` : ""}</> : null}.
            </div>
            <button type="button" onClick={() => setStaleKind(kind as any)}
              style={{ fontSize: 11, color: "#B8860B", background: "none", border: "1px solid #B8860B",
                       padding: isMobile ? "9px 12px" : "5px 11px", cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit" }}>
              Закрыть
            </button>
          </div>
        );
      })}

      {(() => {
        const hasFilters = !!(contragentFilter || descFilter || cPlanMin || cPlanMax || cPaidMin || cPaidMax || varMin || varMax || cDebtMin || cDebtMax || dueFrom || dueTo);
        const canClear = hasFilters || selectedIds.size > 0;
        const selDebt = filteredItems.filter((c: any) => selectedIds.has(String(c.id))).reduce((s: number, c: any) => s + (c.debt || 0), 0);
        return (
          <div style={{ padding: isMobile ? "8px 16px" : "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0, flexWrap: isMobile ? "wrap" : undefined, gap: isMobile ? 6 : 0 }}>
            <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#6B6355", alignItems: "center" }}>
              {selectedIds.size > 0 && <span style={{ color: "#E8592A", fontWeight: 600 }}>Выбрано {selectedIds.size}</span>}
              {selectedIds.size > 0 && selDebt > 0 && <span style={{ color: "#8B3A3A" }}>{fmt(selDebt)}</span>}
              {selectedIds.size > 0 && (
                <>
                  <button type="button" onClick={() => setBulkAction("close")}
                    style={{ fontSize: 11, padding: "3px 10px", border: "1px solid #4A7C59", background: "none",
                             color: "#4A7C59", cursor: "pointer", fontFamily: "inherit" }}>
                    Закрыть выбранные
                  </button>
                  <button type="button" onClick={() => setBulkAction("delete")}
                    style={{ fontSize: 11, padding: "3px 10px", border: "1px solid #8B3A3A", background: "none",
                             color: "#8B3A3A", cursor: "pointer", fontFamily: "inherit" }}>
                    Удалить выбранные
                  </button>
                </>
              )}
              {selectedIds.size === 0 && <span>{filteredItems.length} записей</span>}
              {bulkError && <span style={{ color: "#8B3A3A" }}>{bulkError}</span>}
            </div>
            <button type="button" onClick={canClear ? clearFilters : undefined} style={{ fontSize: 10, color: canClear ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: canClear ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
              <X size={10} /> Сбросить
            </button>
          </div>
        );
      })()}

      <div style={isMobile ? M.filterRow : { display: "grid", gridTemplateColumns: creditorCols, padding: "8px 28px", borderBottom: "1px solid #EDEBE6", alignItems: "center" }}>
        {!isMobile && <div style={{ display: "flex", alignItems: "center" }}>
          <Checkbox
            checked={filteredItems.length > 0 && filteredItems.every((c: any) => selectedIds.has(String(c.id)))}
            indeterminate={filteredItems.some((c: any) => selectedIds.has(String(c.id))) && !filteredItems.every((c: any) => selectedIds.has(String(c.id)))}
            onChange={() => {
              const allSel = filteredItems.every((c: any) => selectedIds.has(String(c.id)));
              setSelectedIds(allSel ? new Set() : new Set(filteredItems.map((c: any) => String(c.id))));
            }}
          />
        </div>}
        <div><ColumnFilter label="КОНТРАГЕНТ" options={uniqueContragents} value={contragentFilter} onChange={setContragentFilter} sort={{ colKey: "name", sort, onToggle: toggleSort }} /></div>
        <div><ColumnFilter label="ЗА ЧТО" options={uniqueDescriptions} value={descFilter} onChange={setDescFilter} sort={{ colKey: "description", sort, onToggle: toggleSort }} /></div>
        <div><AmountFilter label="ПЛАН" min={cPlanMin} max={cPlanMax} onChange={(mn, mx) => { setCPlanMin(mn); setCPlanMax(mx); }} sort={{ colKey: "plan", sort, onToggle: toggleSort }} /></div>
        <div><AmountFilter label="ФАКТ" min={cPaidMin} max={cPaidMax} onChange={(mn, mx) => { setCPaidMin(mn); setCPaidMax(mx); }} sort={{ colKey: "fact", sort, onToggle: toggleSort }} /></div>
        <div><AmountFilter label="ОСТАТОК" min={cDebtMin} max={cDebtMax} onChange={(mn, mx) => { setCDebtMin(mn); setCDebtMax(mx); }} sort={{ colKey: "debt", sort, onToggle: toggleSort }} /></div>
        <div><PeriodFilter label="СРОК" from={dueFrom} to={dueTo} onChange={(f, t) => { setDueFrom(f); setDueTo(t); }} align="right" /></div>
        {!isMobile && <div />}
      </div>

      {filteredItems.length === 0 ? (
        <EmptyState title="Тратить по заказам в работе больше нечего" hint={hiddenSettled > 0 ? `покрытых и признанных строк: ${hiddenSettled}` : undefined} />
      ) : (
        <>
          {filteredItems.map((c: any, i: number) => {
            const rowId = String(c.id);
            return isMobile ? (
              <RowCard key={i} onClick={() => setEditItem(c)}
                title={c.name}
                sub={<>{c.order_title ? <OrderLink id={c.order_id}>{c.order_title}</OrderLink> : c.estimate_item_title ? `← Смета: ${c.estimate_item_title}` : null}
                  {c.order_status === "completed" && <span style={{ marginLeft: 6, color: "#B8860B" }}>· заказ завершён</span>}</>}
                right={<span style={{ color: c.debt > 0 ? "#B8860B" : POLARITY.neutral.color }}>{c.recognized ? "признано" : c.debt > 0 ? fmt(c.debt) : "покрыто"}</span>}
                rightSub={<>план {fmt(c.amount_plan ?? c.total)}</>}
                badge={<>
                  {(c.fact ?? c.paid) > 0 && <span style={{ fontSize: 11, color: "#4A7C59", fontFamily: MONO }}>факт {fmt(c.fact ?? c.paid)}</span>}
                  {c.ambiguous && <span style={{ fontSize: 10, color: "#B8860B" }}>≈ похоже, закрыто</span>}
                  {c.scope === "plan" && <span style={{ fontSize: 10, color: "#A89070" }}>заказ не запущен</span>}
                  <DeadlinePill date={c.due_date} />
                </>}
                meta={c.description || undefined}
                trailing={<IconButton icon={LinkSimple} title="Связать с транзакцией" size={36} iconSize={15}
                  color={(c.finance_tx_id || c.zenmoney_tx_id) ? "#4A7C59" : "#C8C0B0"} onClick={e => { e.stopPropagation(); setLinkItem(c); }} />}
              />
            ) : (
            <div
              key={i}
              onClick={() => setEditItem(c)}
              style={{
                display: "grid", gridTemplateColumns: creditorCols,
                padding: "13px 28px", borderBottom: "1px solid #F2EFE9",
                cursor: "pointer", alignItems: "center", transition: "background 0.1s",
                fontFamily: MONO, fontVariantNumeric: "tabular-nums",
                background: selectedIds.has(rowId) ? "#FFF8F5" : "transparent",
              }}
              onMouseEnter={(e) => { if (!selectedIds.has(rowId)) e.currentTarget.style.background = "#FAF8F5"; }}
              onMouseLeave={(e) => { if (!selectedIds.has(rowId)) e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ display: "flex", alignItems: "center" }}>
                <Checkbox checked={selectedIds.has(rowId)} onChange={() => toggleSelect(rowId)} />
              </div>
              <div style={{ fontFamily: SANS }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{c.name}</div>
                {(c.order_title || c.estimate_item_title) && (
                  <div style={{ fontSize: 10, color: "#A89070", marginTop: 2 }}>
                    {c.order_title
                      ? <OrderLink id={c.order_id}>{c.order_title}</OrderLink>
                      : `← Смета: ${c.estimate_item_title}`}
                    {c.order_status === "completed" && (
                      <span style={{ marginLeft: 6, color: "#B8860B" }}>· заказ завершён</span>
                    )}
                    {c.scope === "plan" && (
                      <span style={{ marginLeft: 6, color: "#A89070" }}>· заказ не запущен</span>
                    )}
                    {c.set_title && (
                      <span style={{ marginLeft: 6, color: "#C8C0B0" }} title="Из какой сметы строка">· {c.set_title}</span>
                    )}
                    {c.no_payee && (
                      <span style={{ marginLeft: 6, color: "#B8860B" }} title="Строка сметы без получателя денег: резерв, наценка. Обязательство лишнее — закрой плашкой выше">· без получателя</span>
                    )}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 12, color: "#6B6355", paddingRight: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: SANS }}>
                {c.description || "—"}
              </div>
              <div style={{ fontSize: 13, color: "#6B6355" }}>{fmt(c.amount_plan ?? c.total)}</div>
              <div>
                <div style={{ fontSize: 13, color: (c.fact ?? c.paid) > 0 ? "#4A7C59" : "#C8C0B0" }}>
                  {(c.fact ?? c.paid) > 0 ? fmt(c.fact ?? c.paid) : "—"}
                </div>
                {c.fact_by_name > 0 && (
                  <div style={{ fontSize: 9, color: "#A89070", fontFamily: SANS, marginTop: 1 }}>по расходам</div>
                )}
                {c.fact_ledger > 0 && (
                  <div style={{ fontSize: 9, color: "#A89070", fontFamily: SANS, marginTop: 1 }}>по лицевому счёту</div>
                )}
                {c.ambiguous && (
                  <div title={`Расходов той же категории по заказу: ${fmt(c.bucket_hint)}. Автоматически не засчитываем — у строки нет подрядчика.`}
                    style={{ fontSize: 9, color: "#B8860B", fontFamily: SANS, marginTop: 1 }}>
                    ≈ похоже, закрыто
                  </div>
                )}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700,
                            // Золото — НЕ упущение: остаток плана закупок это ещё не долг
                            // (CLAUDE.md, 04.08.2026; ТЗ 03.09.2026). Долг — сальдо лицевого счёта.
                            color: c.debt > 0 ? "#B8860B" : POLARITY.neutral.color }}>
                {c.recognized
                  ? <span title={`Ручное начисление лицевого счёта: ${fmt(c.recognized_amount)}. Долг сверен там.`}
                          style={{ fontSize: 11, color: "#4A7C59", fontFamily: SANS }}>признано</span>
                  : c.debt > 0 ? fmt(c.debt) : <span style={{ fontSize: 11, fontFamily: SANS }}>покрыто</span>}
              </div>
              <div><DeadlinePill date={c.due_date} /></div>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <IconButton icon={LinkSimple} title="Связать с транзакцией" size={24} iconSize={13}
                  color={(c.finance_tx_id || c.zenmoney_tx_id) ? "#4A7C59" : "#C8C0B0"}
                  onClick={e => { e.stopPropagation(); setLinkItem(c); }} />
              </div>
            </div>
            );
          })}

          <div style={{
            display: "grid", gridTemplateColumns: creditorCols,
            padding: "10px 28px", borderTop: `2px solid ${POLARITY.out.rail}`,
            alignItems: "center", background: POLARITY.out.tint,
            fontFamily: MONO, fontVariantNumeric: "tabular-nums",
            ...(isMobile ? { display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 16px" } : null),
          }}>
            <div />
            <div style={{ fontSize: 11, color: "#A89070", fontFamily: SANS }}>{filteredItems.length} записей</div>
            <div />
            <div style={{ fontSize: 12, color: "#6B6355", fontWeight: 500 }}>{fmt(totalOwed)}</div>
            <div style={{ fontSize: 12, color: "#4A7C59", fontWeight: 500 }}>{fmt(totalPaid)}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#B8860B" }}>{fmt(totalDebt)}</div>
            <div /><div />
          </div>
        </>
      )}
    </>
  );
}

// ── Постоянные обязательства ────────────────────────────────────────────────

function AddFixedModal({ item, onClose }: { item?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(item?.name ?? "");
  const [amount, setAmount] = useState(item ? String(item.amount) : "");
  const [payDay, setPayDay] = useState(item?.pay_day ? String(item.pay_day) : "");
  const [note, setNote] = useState(item?.note ?? "");
  const [active, setActive] = useState(item ? !!item.active : true);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Раньше у этих мутаций не было onError вовсе: на 400 окно просто не закрывалось,
  // кнопка отвисала, и никакого объяснения не появлялось.
  const [error, setError] = useState("");

  const { mutate, isPending } = useMutation({
    mutationFn: () => {
      const data = {
        name: name.trim(),
        amount: parseFloat(amount) || 0,
        pay_day: payDay ? parseInt(payDay) : undefined,
        note: note.trim() || undefined,
      };
      return item
        ? financeApi.updateFixedObligation(item.id, { ...data, active: active ? 1 : 0 })
        : financeApi.createFixedObligation(data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fixed-obligations"] });
      onClose();
    },
    onError: (e: any) => setError(e?.response?.data?.detail || "Не удалось сохранить"),
  });

  const { mutate: remove, isPending: removing } = useMutation({
    mutationFn: () => financeApi.deleteFixedObligation(item.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fixed-obligations"] });
      onClose();
    },
  });

  return (
    <>
    <Modal
      size="md"
      eyebrow={item ? "ПОСТОЯННОЕ ОБЯЗАТЕЛЬСТВО" : "НОВОЕ ПОСТОЯННОЕ ОБЯЗАТЕЛЬСТВО"}
      onClose={onClose}
      onCancel={onClose}
      onSave={() => mutate()}
      saveLabel={item ? "Сохранить" : "Добавить"}
      saving={isPending}
      canSave={!!name.trim() && !!amount}
    >
      <div style={{ padding: "18px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>НАЗВАНИЕ *</div>
          <input
            value={name} onChange={e => setName(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }}
            placeholder="Аренда цеха"
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>СУММА В МЕСЯЦ, ₽ *</div>
            <input
              type="number" value={amount} onChange={e => setAmount(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }}
              placeholder="50000"
            />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ДЕНЬ ОПЛАТЫ (1–28)</div>
            <input
              type="number" min={1} max={28} value={payDay} onChange={e => setPayDay(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none" }}
              placeholder="5"
            />
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ЗАМЕТКА</div>
          <textarea
            value={note} onChange={e => setNote(e.target.value)} rows={2}
            style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none", resize: "vertical", fontFamily: "inherit" }}
            placeholder="Помещение на Остужева..."
          />
        </div>
        {item && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#6B6355", cursor: "pointer" }}>
              <Checkbox checked={active} onChange={() => setActive(!active)} />
              Активно (создаётся каждый месяц)
            </label>
            <button type="button"
              onClick={() => setConfirmRemove(true)}
              disabled={removing}
              style={{ fontSize: 11, color: "#8B3A3A", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              Удалить
            </button>
          </div>
        )}
      </div>
      {error && <div style={{ padding: "0 24px 12px", fontSize: 11, color: "#8B3A3A" }}>{error}</div>}
    </Modal>
    {confirmRemove && (
      <ConfirmModal
        message="Удалить постоянное обязательство? История оплат прошлых месяцев сохранится."
        confirmLabel="Удалить"
        onConfirm={() => { setConfirmRemove(false); remove(); }}
        onCancel={() => setConfirmRemove(false)}
      />
    )}
    </>
  );
}

const fixedCols = "1.8fr 1.6fr 110px 70px 110px 110px 90px 28px";

function FixedTab() {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const [editTemplate, setEditTemplate] = useState<any>(null);
  const [payItem, setPayItem] = useState<any>(null);
  const [linkItem, setLinkItem] = useState<any>(null);
  const [nameF, setNameF] = useState("");
  const [amtMin, setAmtMin] = useState("");
  const [amtMax, setAmtMax] = useState("");
  const [fPaidMin, setFPaidMin] = useState("");
  const [fPaidMax, setFPaidMax] = useState("");
  const [fDebtMin, setFDebtMin] = useState("");
  const [fDebtMax, setFDebtMax] = useState("");
  const clearFilters = () => { setNameF(""); setAmtMin(""); setAmtMax(""); setFPaidMin(""); setFPaidMax(""); setFDebtMin(""); setFDebtMax(""); };
  const { data, isLoading } = useQuery({
    queryKey: ["fixed-obligations", month],
    queryFn: () => financeApi.fixedObligations(month),
  });

  const items: any[] = data?.items || [];
  const totals = data?.totals || { plan_month: 0, paid_month: 0, debt_month: 0 };

  // Экземпляр месяца → объект для существующих модалок оплаты/привязки
  const toCreditor = (f: any) => ({
    id: f.creditor_id, name: f.name, total: f.month_total, paid: f.paid,
    debt: f.debt, description: f.note, due_date: f.due_date, status: f.status,
    finance_tx_id: f.finance_tx_id, zenmoney_tx_id: f.zenmoney_tx_id,
  });

  const monthOptions = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    });
  }, []);

  if (isLoading) return <Loading />;

  return (
    <>
      {editTemplate && <AddFixedModal item={editTemplate} onClose={() => setEditTemplate(null)} />}
      {payItem && <PayCreditorModal item={payItem} onClose={() => setPayItem(null)} />}
      {linkItem && <LinkTxModal creditor={linkItem} onClose={() => setLinkItem(null)} />}

      {(() => {
        const uniqueNames = [...new Set(items.map((f: any) => f.name).filter(Boolean))].sort() as string[];
        const hasFilters = !!(nameF || amtMin || amtMax || fPaidMin || fPaidMax || fDebtMin || fDebtMax);
        const filtered = items.filter((f: any) => {
          if (nameF && f.name !== nameF) return false;
          const amt = (f.month_total ?? f.amount) || 0;
          if (amtMin && amt < parseFloat(amtMin)) return false;
          if (amtMax && amt > parseFloat(amtMax)) return false;
          if (fPaidMin && (f.paid || 0) < parseFloat(fPaidMin)) return false;
          if (fPaidMax && (f.paid || 0) > parseFloat(fPaidMax)) return false;
          if (fDebtMin && (f.debt || 0) < parseFloat(fDebtMin)) return false;
          if (fDebtMax && (f.debt || 0) > parseFloat(fDebtMax)) return false;
          return true;
        });
        return (
      <>
      <div style={{ padding: "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#6B6355" }}>{filtered.length} постоянных · нагрузка {fmt(totals.plan_month)}/мес</span>
          <button type="button" onClick={hasFilters ? clearFilters : undefined} style={{ fontSize: 10, color: hasFilters ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: hasFilters ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
            <X size={10} /> Сбросить
          </button>
        </div>
        <select
          value={month} onChange={e => setMonth(e.target.value)}
          style={{ fontSize: 12, border: "1px solid #EDEBE6", background: "none", color: "#1A1A1A", padding: "4px 8px", cursor: "pointer", outline: "none" }}
        >
          {monthOptions.map(m => (
            <option key={m} value={m}>
              {new Date(m + "-01").toLocaleDateString("ru-RU", { month: "long", year: "numeric" })}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: fixedCols, padding: "8px 28px", borderBottom: "1px solid #EDEBE6", alignItems: "center" }}>
        <div><ColumnFilter label="НАЗВАНИЕ" options={uniqueNames} value={nameF} onChange={setNameF} /></div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ЗАМЕТКА</div>
        <div><AmountFilter label="СУММА/МЕС" min={amtMin} max={amtMax} onChange={(mn, mx) => { setAmtMin(mn); setAmtMax(mx); }} /></div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ДЕНЬ</div>
        <div><AmountFilter label="ОПЛАЧЕНО" min={fPaidMin} max={fPaidMax} onChange={(mn, mx) => { setFPaidMin(mn); setFPaidMax(mx); }} /></div>
        <div><AmountFilter label="ОСТАТОК" min={fDebtMin} max={fDebtMax} onChange={(mn, mx) => { setFDebtMin(mn); setFDebtMax(mx); }} /></div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ШАБЛОН</div>
        <div />
      </div>

      {filtered.length === 0 ? (
        <EmptyState title={hasFilters ? "Ничего не найдено" : "Нет постоянных обязательств"} hint={hasFilters ? undefined : "Добавь регулярные расходы: аренда, зарплаты, подписки"} />
      ) : (
        <>
          {filtered.map((f: any, i: number) => (
            <div
              key={i}
              onClick={() => f.creditor_id && setPayItem(toCreditor(f))}
              style={{
                display: "grid", gridTemplateColumns: fixedCols,
                padding: "13px 28px", borderBottom: "1px solid #F2EFE9",
                cursor: f.creditor_id ? "pointer" : "default", alignItems: "center",
                fontFamily: MONO, fontVariantNumeric: "tabular-nums",
                opacity: f.active ? 1 : 0.45,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#FAF8F5"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ fontFamily: SANS }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{f.name}</div>
                {!f.active && <div style={{ fontSize: 10, color: "#A89070", marginTop: 2 }}>выключено</div>}
              </div>
              <div style={{ fontSize: 12, color: "#6B6355", paddingRight: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: SANS }}>
                {f.note || "—"}
              </div>
              <div style={{ fontSize: 13, color: "#6B6355" }}>{fmt(f.month_total ?? f.amount)}</div>
              <div style={{ fontSize: 12, color: deadlineColor(f.due_date) }}>{f.pay_day ? `до ${f.pay_day}-го` : "—"}</div>
              <div style={{ fontSize: 13, color: "#4A7C59" }}>{f.paid > 0 ? fmt(f.paid) : "—"}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: f.creditor_id == null ? "#C8C0B0" : f.debt > 0 ? "#8B3A3A" : "#4A7C59" }}>
                {f.creditor_id == null ? "—" : f.debt > 0 ? fmt(f.debt) : "Закрыт"}
              </div>
              <div>
                <button type="button"
                  onClick={e => { e.stopPropagation(); setEditTemplate(f); }}
                  style={{ fontSize: 11, color: "#A89070", background: "none", border: "1px solid #EDEBE6", padding: "3px 8px", cursor: "pointer" }}
                >
                  Изменить
                </button>
              </div>
              <div style={{ display: "flex", justifyContent: "center" }}>
                {f.creditor_id && (
                  <IconButton icon={LinkSimple} title="Связать с транзакцией" size={24} iconSize={13}
                    color={(f.finance_tx_id || f.zenmoney_tx_id) ? "#4A7C59" : "#C8C0B0"}
                    onClick={e => { e.stopPropagation(); setLinkItem(toCreditor(f)); }} />
                )}
              </div>
            </div>
          ))}

          <div style={{
            display: "grid", gridTemplateColumns: fixedCols,
            padding: "10px 28px", borderTop: `2px solid ${POLARITY.out.rail}`,
            alignItems: "center", background: POLARITY.out.tint,
            fontFamily: MONO, fontVariantNumeric: "tabular-nums",
          }}>
            <div style={{ fontSize: 11, color: "#A89070", fontFamily: SANS }}>ИТОГО В МЕСЯЦ</div>
            <div />
            <div style={{ fontSize: 12, color: "#6B6355", fontWeight: 500 }}>{fmt(totals.plan_month)}</div>
            <div />
            <div style={{ fontSize: 12, color: "#4A7C59", fontWeight: 500 }}>{fmt(totals.paid_month)}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: totals.debt_month > 0 ? "#8B3A3A" : "#4A7C59" }}>{fmt(totals.debt_month)}</div>
            <div /><div />
          </div>
        </>
      )}
      </>
        );
      })()}
    </>
  );
}

// ── Главная страница ────────────────────────────────────────────────────────

/** Сальдо по всем подрядчикам одним экраном (GET /api/ledger/balances).
 *
 *  Рядом с «Мы должны» намеренно: там обязательства по сметам — ПЛАН закупок,
 *  здесь лицевой счёт — сколько мы должны мастеру НА САМОМ ДЕЛЕ, с учётом
 *  выданных авансов, зачётов и оплат за него третьим лицам. Две разные цифры,
 *  и вторую до сих пор можно было увидеть только по одному подрядчику за раз. */
function LedgerTab() {
  const navigate = useNavigate();
  const { data, isLoading, error, isError } = useQuery({
    queryKey: ["ledger-balances"],
    queryFn: () => ledgerApi.balances(),
  });
  if (isError) return <QueryError error={error} what="сальдо подрядчиков" />;
  if (isLoading) return <Loading />;
  const items: any[] = data?.items ?? [];
  if (!items.length) return <EmptyState compact title="Никому не должны" hint="и авансов у мастеров нет" />;
  // Три состояния сальдо с бэка (ТЗ 03.09.2026, п.6): we_owe — долг, advance —
  // настоящий аванс (явно помечен), unallocated — минус без начислений: дырка в
  // разноске, не деньги. Последнее — ниже и мельче, в суммы не идёт.
  const owe = items.filter((m: any) => m.state === "we_owe");
  const adv = items.filter((m: any) => m.state === "advance");
  const unalloc = items.filter((m: any) => m.state === "unallocated");

  const COLS = "1.6fr 110px 110px 110px 100px 120px 120px";
  const head: React.CSSProperties = { fontSize: 10, color: "#A89070", letterSpacing: "0.04em", textAlign: "right" };
  const cell: React.CSSProperties = { fontSize: 12, textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" };

  const rows = (list: any[]) => list.map((m: any) => (
    <div key={m.master_id} onClick={() => navigate(`/wiki/contractors/${m.master_id}`)}
      style={{ display: "grid", gridTemplateColumns: COLS, gap: "0 14px", padding: "10px 0",
               borderBottom: "1px solid #F7F5F1", cursor: "pointer", alignItems: "baseline" }}
      onMouseEnter={e => { e.currentTarget.style.background = "#FAF8F5"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
      <span style={{ fontSize: 13, color: "#1A1A1A" }}>
        {m.name}
        {m.role && <span style={{ fontSize: 10, color: "#A89070" }}> · {m.role}</span>}
      </span>
      <span style={{ ...cell, color: "#6B6355" }}>
        {fmt(m.accrued)}
        {m.plan_open > 0 && (
          <div title="Из начисленного — план открытых строк смет (прикидка до сверки)"
               style={{ fontSize: 9, color: "#B8860B", fontFamily: SANS }}>план {fmt(m.plan_open)}</div>
        )}
      </span>
      <span style={{ ...cell, color: "#6B6355" }}>
        {fmt(m.paid + (m.advance || 0))}
        {m.advance > 0 && <div style={{ fontSize: 9, color: "#4A7C59", fontFamily: SANS }}>аванс {fmt(m.advance)}</div>}
      </span>
      <span style={{ ...cell, color: m.third_party ? "#6B6355" : "#C8C0B0" }}>{m.third_party ? fmt(m.third_party) : "—"}</span>
      <span style={{ ...cell, color: m.offset ? "#6B6355" : "#C8C0B0" }}>{m.offset ? fmt(m.offset) : "—"}</span>
      <span style={{ ...cell, color: m.accepted ? "#A89070" : "#C8C0B0" }}>{m.accepted ? fmt(m.accepted) : "—"}</span>
      <span style={{ ...cell, fontWeight: 700,
        color: m.state === "we_owe" ? "#8B3A3A" : m.state === "advance" ? "#4A7C59" : "#A89070" }}>
        {fmt(m.balance)}
      </span>
    </div>
  ));
  const headRow = (
    <div style={{ display: "grid", gridTemplateColumns: COLS, gap: "0 14px", padding: "8px 0",
                  borderBottom: "1px solid #EDEBE6" }}>
      <span style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>ПОДРЯДЧИК</span>
      <span style={head}>НАЧИСЛЕНО</span>
      <span style={head}>ВЫПЛАЧЕНО</span>
      <span style={head}>ЗА НЕГО</span>
      <span style={head}>ЗАЧТЕНО</span>
      <span style={{ ...head }} title="Работы приняты, но закрыты авансом или зачётом либо ещё не оплачены. В сальдо не входит.">ПРИНЯТО</span>
      <span style={head}>САЛЬДО</span>
    </div>
  );

  return (
    <div style={{ padding: "0 28px 40px" }}>
      <div style={{ margin: "12px 0 0", padding: "11px 14px", background: "#FAF8F5",
                    borderLeft: "3px solid #EDEBE6", fontSize: 12, color: "#6B6355", lineHeight: 1.5 }}>
        Долг перед человеком — одно число: сальдо лицевого счёта. Начислено (сверенные суммы
        и план открытых строк смет) минус выплачено, зачтено и оплачено за него. Плюс — мы
        должны мастеру, минус — у него наш аванс. «Осталось потратить» — соседняя вкладка,
        это прогноз по сметам, не долг.
      </div>

      <div style={{ display: "flex", gap: 36, margin: "18px 0 14px", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>МЫ ДОЛЖНЫ</div>
          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO, color: "#8B3A3A" }}>{fmt(data?.we_owe)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>АВАНСЫ У МАСТЕРОВ</div>
          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO, color: "#4A7C59" }}>{fmt(data?.they_owe)}</div>
        </div>
        {(data?.unallocated_total ?? 0) > 0 && (
          <div title="Выплачено больше, чем начислено, и аванс не помечен — работа не заведена. Это дырка в разноске, не деньги.">
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>ТРЕБУЕТ РАЗНОСКИ</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO, color: "#A89070" }}>{fmt(data?.unallocated_total)}</div>
          </div>
        )}
      </div>

      {owe.length > 0 ? (<>{headRow}{rows(owe)}</>) : (
        <div style={{ padding: "14px 0", fontSize: 12, color: "#6B6355" }}>Долгов перед подрядчиками нет.</div>
      )}

      {adv.length > 0 && (
        <>
          <div style={{ fontSize: 10, color: "#4A7C59", letterSpacing: "0.04em", margin: "24px 0 0" }}>АВАНСЫ У МАСТЕРОВ — деньги отданы вперёд, работа впереди</div>
          {headRow}{rows(adv)}
        </>
      )}

      {unalloc.length > 0 && (
        <>
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em", margin: "24px 0 0" }}>
            ТРЕБУЕТ РАЗНОСКИ — выплачено, работа не заведена
          </div>
          <div style={{ fontSize: 11, color: "#A89070", margin: "4px 0 0", lineHeight: 1.5 }}>
            Минус без начислений — не аванс: работы сделаны и оплачены, а начисление не завели. Заведи
            начисление в карточке подрядчика или пометь выплату авансом.
          </div>
          {headRow}{rows(unalloc)}
        </>
      )}
    </div>
  );
}


export default function Debtors() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"debtors" | "unallocated" | "creditors" | "ledger" | "fixed">("debtors");
  const [addCreditorOpen, setAddCreditorOpen] = useState(false);
  const [addReceivableOpen, setAddReceivableOpen] = useState(false);
  const [addFixedOpen, setAddFixedOpen] = useState(false);

  const { data: debtData } = useQuery({ queryKey: ["debtors"], queryFn: financeApi.debtors });
  const { data: credData } = useQuery({ queryKey: ["creditors"], queryFn: () => financeApi.creditors() });
  const { data: recData }  = useQuery({ queryKey: ["receivables"], queryFn: financeApi.receivables });
  const { data: ledData }  = useQuery({ queryKey: ["ledger-balances"], queryFn: () => ledgerApi.balances() });

  // В сальдо идут только долги по ЗАКАЗАМ: счета из вики — параллельный учёт
  // тех же денег (Ануш ORD-015, Винзавод/Мирра), сложение считало их дважды.
  // Счета показываем отдельной подписью и на своей вкладке (решение Юры 04.08.2026).
  const receivable = debtData?.total ?? 0;
  const unallocated = recData?.total_debt ?? 0;
  // «Мы должны» — ОДНО число на человека: сальдо лицевого счёта (ТЗ 03.09.2026).
  // Обязательства смет — план закупок, они рядом золотом и в сальдо не входят:
  // начисления лицевого счёта строятся из тех же строк, складывать — считать дважды.
  const payable    = ledData?.we_owe ?? 0;
  const planRest   = credData?.plan_rest_total ?? 0;
  const openRecCount = recData?.open_items?.length ?? 0;

  const TABS = [
    { id: "debtors",     label: "Нам должны" },
    // Лицевые счета: реальный долг мастеру с учётом авансов, зачётов и оплат за него.
    { id: "ledger",      label: "Мы должны" },
    // Обязательства смет по заказам в работе — прогноз трат, не долг.
    { id: "creditors",   label: "Осталось потратить" },
    { id: "fixed",       label: "Постоянные" },
    { id: "unallocated", label: openRecCount > 0 ? `Нераспределённые (${openRecCount})` : "Нераспределённые" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>

      {/* Header */}
      <div style={{ padding: isMobile ? "16px 16px 0" : "24px 28px 0", borderBottom: "1px solid #EDEBE6", flexShrink: 0 }}>
        <div style={{ ...T.pageTitle, fontSize: isMobile ? 22 : 26, marginBottom: 16 }}>Обязательства</div>

        {/* Сигнатура «весы обязательств»: входящий поток · чистая позиция · исходящий */}
        <div style={{
          display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr auto 1fr", alignItems: "stretch",
          border: "1px solid #EDEBE6", marginBottom: isMobile ? 14 : 20,
        }}>
          {/* Нам должны — деньги входят */}
          <div style={{ borderLeft: `3px solid ${POLARITY.in.rail}`, background: POLARITY.in.tint, padding: isMobile ? "12px 14px" : "14px 18px" }}>
            <div style={{ ...T.sectionLabel, color: POLARITY.in.color, display: "flex", alignItems: "center", gap: 6 }}>
              Нам должны <span style={{ fontSize: 13 }}>→</span>
            </div>
            <div style={{ ...T.hero, color: POLARITY.in.color, marginTop: 6 }}>{fmt(receivable)}</div>
            {unallocated > 0 && (
              <button type="button" onClick={() => setTab("unallocated")}
                title="Счета из вики: тот же клиент может быть и в заказах — сверь, прежде чем складывать"
                style={{ marginTop: 4, padding: 0, background: "none", border: "none", cursor: "pointer",
                         fontSize: 11, color: "#A89070", fontFamily: "inherit", textAlign: "left" }}>
                + счета, ещё не разнесённые по заказам: {fmt(unallocated)}
              </button>
            )}
          </div>

          {/* Чистая позиция */}
          {(() => {
            const net = receivable - payable;
            const c = net >= 0 ? POLARITY.in.color : POLARITY.out.color;
            return (
              <div style={{ padding: isMobile ? "10px 16px" : "14px 24px", textAlign: "center", borderLeft: isMobile ? "none" : "1px solid #EDEBE6", borderRight: isMobile ? "none" : "1px solid #EDEBE6", borderTop: isMobile ? "1px solid #EDEBE6" : "none", display: "flex", flexDirection: "column", justifyContent: "center", minWidth: isMobile ? 0 : 160, gridColumn: isMobile ? "1 / -1" : undefined, gridRow: isMobile ? 2 : undefined }}>
                <div style={{ ...T.colLabel }}>Чистая позиция</div>
                <div style={{ ...T.num, fontSize: 20, fontWeight: 700, color: c, marginTop: 6 }}>
                  {net >= 0 ? "+" : "−"}{fmt(Math.abs(net))}
                </div>
              </div>
            );
          })()}

          {/* Мы должны — деньги выходят */}
          <div style={{ borderRight: `3px solid ${POLARITY.out.rail}`, background: POLARITY.out.tint, padding: isMobile ? "12px 14px" : "14px 18px", textAlign: "right", gridRow: isMobile ? 1 : undefined, gridColumn: isMobile ? 2 : undefined }}>
            <div style={{ ...T.sectionLabel, color: POLARITY.out.color, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
              <span style={{ fontSize: 13 }}>←</span> Мы должны
            </div>
            <div style={{ ...T.hero, color: POLARITY.out.color, marginTop: 6 }}>{fmt(payable)}</div>
            {planRest > 0 && (
              <button type="button" onClick={() => setTab("creditors")}
                title="План закупок и работ по заказам в производстве за вычетом факта. Прогноз, не долг: в сальдо не входит"
                style={{ marginTop: 4, padding: 0, background: "none", border: "none", cursor: "pointer",
                         fontSize: 11, color: "#B8860B", fontFamily: "inherit", textAlign: "right" }}>
                + осталось потратить по заказам в работе: {fmt(planRest)}
              </button>
            )}
          </div>
        </div>

        {/* Tabs — активная тонируется в свой полярный цвет */}
        <div style={{ display: "flex", gap: isMobile ? 18 : 24, ...(isMobile ? M.tabStrip : null) }}>
          {TABS.map((t) => {
            const pol = POLARITY[TAB_POLARITY[t.id]];
            const active = tab === t.id;
            return (
              <button type="button"
                key={t.id}
                onClick={() => setTab(t.id as any)}
                style={{
                  fontSize: 13, padding: "0 0 12px",
                  border: "none", background: "none", cursor: "pointer",
                  color: active ? pol.color : "#A89070",
                  fontWeight: active ? 700 : 400,
                  borderBottom: active ? `2px solid ${pol.rail}` : "2px solid transparent",
                  marginBottom: -1, transition: "color 0.15s",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Modals */}
      {addCreditorOpen && <AddCreditorModal onClose={() => setAddCreditorOpen(false)} />}
      {addReceivableOpen && <AddReceivableModal onClose={() => setAddReceivableOpen(false)} />}
      {addFixedOpen && <AddFixedModal onClose={() => setAddFixedOpen(false)} />}

      {/* Toolbar */}
      <div style={{ padding: isMobile ? "10px 16px" : "12px 28px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "flex-end", flexShrink: 0 }}>
        {(() => {
          const onAdd = {
            debtors: () => navigate("/orders"),
            creditors: () => setAddCreditorOpen(true),
            fixed: () => setAddFixedOpen(true),
            unallocated: () => setAddReceivableOpen(true),
            // Расчёты — сводка только на чтение: аванс, зачёт и оплату за подрядчика
            // заводят в его карточке, чтобы оба входа писали одну строку.
            ledger: null,
          }[tab];
          if (!onAdd) return null;
          return (
            <Button variant="primary" size="sm" onClick={onAdd}>
              <Plus size={13} weight="bold" /> Добавить
            </Button>
          );
        })()}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {tab === "debtors" && <DebtorsTab />}
        {tab === "unallocated" && <HScroll><UnallocatedTab /></HScroll>}
        {tab === "creditors" && <CreditorsTab />}
        {tab === "ledger" && <HScroll><LedgerTab /></HScroll>}
        {tab === "fixed" && <HScroll><FixedTab /></HScroll>}
      </div>
    </div>
  );
}
