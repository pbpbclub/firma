import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { financeApi, zenmoneyApi, ordersApi } from "../api";
import { useNavigate } from "react-router-dom";
import { Bank, X, Check, Plus, LinkSimple } from "@phosphor-icons/react";
import { ColumnFilter } from "../components/TableFilters";
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

function fmt(n: number) {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
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
            <button onClick={() => onLink(null)}
              style={{ fontSize: 11, color: "#8B3A3A", background: "none", border: "none", cursor: "pointer", padding: 0 }}>Отвязать</button>
          </div>
        )}

        <div style={{ padding: "8px 20px", borderBottom: "1px solid #F2EFE9" }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Поиск по контрагенту..."
            style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "5px 10px", fontSize: 12, outline: "none" }} />
        </div>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {loading && <div style={{ padding: 32, textAlign: "center", color: "#A89070", fontSize: 12 }}>Загружаем...</div>}
          {!loading && filtered.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "#C8C0B0", fontSize: 12 }}>Транзакции не найдены</div>}
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
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", width: 440, padding: 28, boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A" }}>Новое обязательство</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070" }}><X size={18} /></button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button onClick={onClose} style={{ padding: "7px 16px", border: "1px solid #EDEBE6", background: "none", fontSize: 12, cursor: "pointer", color: "#6B6355" }}>
            Отмена
          </button>
          <button
            disabled={!name.trim() || !total || isPending}
            onClick={() => mutate()}
            style={{ padding: "7px 16px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600, opacity: !name.trim() || !total ? 0.4 : 1 }}
          >
            Добавить
          </button>
        </div>
      </div>
    </div>
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["creditors"] }); onClose(); },
  });

  const close = useMutation({
    mutationFn: () => financeApi.updateCreditor(item.id, { status: "closed" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["creditors"] }); onClose(); },
  });

  const del = useMutation({
    mutationFn: () => financeApi.deleteCreditor(item.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["creditors"] }); onClose(); },
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", width: 440, padding: 28, boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A" }}>{item.name}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070" }}><X size={18} /></button>
        </div>

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
          <button
            onClick={() => del.mutate()}
            style={{ padding: "7px 12px", border: "1px solid #EDEBE6", background: "none", fontSize: 11, cursor: "pointer", color: "#8B3A3A" }}
          >
            Удалить
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => close.mutate()}
              style={{ padding: "7px 12px", border: "1px solid #4A7C59", background: "none", fontSize: 11, cursor: "pointer", color: "#4A7C59", display: "flex", alignItems: "center", gap: 4 }}
            >
              <Check size={12} /> Закрыть долг
            </button>
            <button
              onClick={() => update.mutate({ paid: parseFloat(paid) || 0, total: parseFloat(total) || 0, description: desc || undefined, due_date: dueDate || undefined })}
              style={{ padding: "7px 16px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600 }}
            >
              Сохранить
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Вкладка: дебиторка ─────────────────────────────────────────────────────

const debtorCols = "28px 2fr 1fr 130px 150px 130px 100px 28px";

function DebtorsTab() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["debtors"], queryFn: financeApi.debtors });
  const [statusFilter, setStatusFilter] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [orderFilter, setOrderFilter] = useState("");
  const [linkItem, setLinkItem] = useState<any>(null);
  const clearFilters = () => { setStatusFilter(""); setClientFilter(""); setOrderFilter(""); setSelectedIds(new Set()); };
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
    return r;
  }, [items, statusFilter, clientFilter, orderFilter]);

  const total     = filtered.reduce((s: number, r: any) => s + (r.debt || 0), 0);
  const totalPlan = filtered.reduce((s: number, r: any) => s + (r.price_plan || 0), 0);
  const totalPaid = filtered.reduce((s: number, r: any) => s + (r.paid_total || 0), 0);

  const linkOrder = useMutation({
    mutationFn: ({ id, txId }: { id: string; txId: string | null }) =>
      ordersApi.update(id, { finance_tx_id: txId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["debtors"] }); setLinkItem(null); },
  });

  if (isLoading) return <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>;

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
        const hasFilters = !!(statusFilter || clientFilter || orderFilter);
        const canClear = hasFilters || selectedIds.size > 0;
        const selDebt = filtered.filter((d: any) => selectedIds.has(String(d.id || d.number))).reduce((s: number, d: any) => s + (d.debt || 0), 0);
        return (
          <div style={{ padding: "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
            <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#6B6355", alignItems: "center" }}>
              {selectedIds.size > 0 && <span style={{ color: "#E8592A", fontWeight: 600 }}>Выбрано {selectedIds.size}</span>}
              {selectedIds.size > 0 && selDebt > 0 && <span style={{ color: "#E8592A" }}>долг {fmt(selDebt)}</span>}
              {selectedIds.size === 0 && <span>{filtered.length} позиций</span>}
              {selectedIds.size === 0 && hasFilters && total > 0 && <span style={{ color: "#E8592A" }}>долг {fmt(total)}</span>}
            </div>
            <button onClick={canClear ? clearFilters : undefined} style={{ fontSize: 10, color: canClear ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: canClear ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
              <X size={10} /> Сбросить
            </button>
          </div>
        );
      })()}

      <div style={{ display: "grid", gridTemplateColumns: debtorCols, padding: "8px 28px", borderBottom: "1px solid #EDEBE6", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <Checkbox
            checked={filtered.length > 0 && filtered.every((d: any) => selectedIds.has(String(d.id || d.number)))}
            indeterminate={filtered.some((d: any) => selectedIds.has(String(d.id || d.number))) && !filtered.every((d: any) => selectedIds.has(String(d.id || d.number)))}
            onChange={() => {
              const allSel = filtered.every((d: any) => selectedIds.has(String(d.id || d.number)));
              setSelectedIds(allSel ? new Set() : new Set(filtered.map((d: any) => String(d.id || d.number))));
            }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <ColumnFilter label="КЛИЕНТ" options={uniqueClients} value={clientFilter} onChange={setClientFilter} />
          <ColumnFilter label="ЗАКАЗ" options={uniqueOrders} value={orderFilter} onChange={setOrderFilter} />
        </div>
        <div><ColumnFilter label="СТАТУС" options={uniqueStatuses} value={statusFilter} onChange={setStatusFilter} /></div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>СОГЛАСОВАНО</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ОПЛАЧЕНО</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ОЖИДАЕМ</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ДЕДЛАЙН</div>
        <div />
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>
          Нет согласованных смет с задолженностью
        </div>
      ) : (
        <>
          {filtered.map((d: any, i: number) => {
            const rowId = String(d.id || d.number || i);
            return (
            <div
              key={i}
              onClick={() => navigate(`/orders/${d.number}`)}
              style={{
                display: "grid", gridTemplateColumns: debtorCols,
                padding: "13px 28px", borderBottom: "1px solid #F2EFE9",
                cursor: "pointer", alignItems: "center", transition: "background 0.1s",
                background: selectedIds.has(rowId) ? "#FFF8F5" : "transparent",
              }}
              onMouseEnter={(e) => { if (!selectedIds.has(rowId)) e.currentTarget.style.background = "#FAF8F5"; }}
              onMouseLeave={(e) => { if (!selectedIds.has(rowId)) e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ display: "flex", alignItems: "center" }}>
                <Checkbox checked={selectedIds.has(rowId)} onChange={() => toggleSelect(rowId)} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{d.customer_name || "—"}</div>
                <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>{d.title}</div>
              </div>
              <div style={{ fontSize: 12, color: "#6B6355" }}>{d.status_label || d.status}</div>
              <div style={{ fontSize: 13, color: "#1A1A1A" }}>{fmt(d.price_plan)}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, color: "#4A7C59" }}>{fmt(d.paid_total)}</span>
                {d.paid_bank > 0 && <Bank size={11} style={{ color: "#4A7C59" }} />}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#E8592A" }}>{fmt(d.debt)}</div>
              <div style={{ fontSize: 12, color: deadlineColor(d.deadline) }}>{fmtDate(d.deadline)}</div>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <button
                  onClick={e => { e.stopPropagation(); setLinkItem(d); }}
                  title="Связать с транзакцией"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex", color: d.finance_tx_id ? "#4A7C59" : "#C8C0B0" }}
                  onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
                  onMouseLeave={e => (e.currentTarget.style.color = d.finance_tx_id ? "#4A7C59" : "#C8C0B0")}
                >
                  <LinkSimple size={13} />
                </button>
              </div>
            </div>
            );
          })}

          <div style={{
            display: "grid", gridTemplateColumns: debtorCols,
            padding: "10px 28px", borderTop: "1px solid #EDEBE6",
            alignItems: "center", background: "#FAF8F5",
          }}>
            <div />
            <div style={{ fontSize: 11, color: "#A89070" }}>{filtered.length} заказов</div>
            <div />
            <div style={{ fontSize: 12, color: "#6B6355", fontWeight: 500 }}>{fmt(totalPlan)}</div>
            <div style={{ fontSize: 12, color: "#4A7C59", fontWeight: 500 }}>{fmt(totalPaid)}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#E8592A" }}>{fmt(total)}</div>
            <div /><div />
          </div>
        </>
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
  const [invoiceDate, setInvoiceDate] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

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
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", width: 440, padding: 28, boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A" }}>Новый счёт</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#A89070" }}><X size={18} /></button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button onClick={onClose} style={{ padding: "7px 16px", border: "1px solid #EDEBE6", background: "none", fontSize: 12, cursor: "pointer", color: "#6B6355" }}>Отмена</button>
          <button disabled={!client.trim() || !amount || isPending}
            onClick={() => mutate()}
            style={{ padding: "7px 16px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600, opacity: !client.trim() || !amount ? 0.4 : 1 }}>
            Добавить
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Вкладка: нераспределённые счета (receivables из вики) ─────────────────

function UnallocatedTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["receivables"], queryFn: financeApi.receivables });
  const [editId, setEditId] = useState<number | null>(null);
  const [paidDraft, setPaidDraft] = useState("");
  const [linkItem, setLinkItem] = useState<any>(null);

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

  if (isLoading) return <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>;
  if (items.length === 0) return <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Нет нераспределённых счетов</div>;

  const recCols = "2fr 2fr 120px 120px 120px 28px";

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
      <div style={{ padding: "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 11, color: "#6B6355" }}>{items.length} счетов</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#4A7C59" }}>{fmt(data?.total_debt ?? 0)}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: recCols, padding: "6px 28px 6px", borderBottom: "1px solid #EDEBE6" }}>
        {["КЛИЕНТ", "НАЗНАЧЕНИЕ", "СЧЁТ", "ОПЛАЧЕНО", "ОСТАТОК", ""].map(h => (
          <div key={h} style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>{h}</div>
        ))}
      </div>

      {items.map((r: any) => (
        <div key={r.id}>
          <div
            onClick={() => { setEditId(editId === r.id ? null : r.id); setPaidDraft(String(r.paid ?? 0)); }}
            style={{
              display: "grid", gridTemplateColumns: recCols,
              padding: "11px 28px", borderBottom: "1px solid #F2EFE9",
              cursor: "pointer", alignItems: "center", transition: "background 0.1s",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{r.client}</div>
              {r.inn && <div style={{ fontSize: 10, color: "#A89070", marginTop: 1 }}>ИНН {r.inn}</div>}
            </div>
            <div style={{ fontSize: 11, color: "#6B6355", paddingRight: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.note || "—"}
            </div>
            <div style={{ fontSize: 11, color: "#A89070" }}>
              {r.invoice_num && <span>№{r.invoice_num}</span>}
              {r.invoice_date && <div style={{ fontSize: 10, marginTop: 1 }}>{fmtDate(r.invoice_date)}</div>}
            </div>
            <div style={{ fontSize: 13, color: "#4A7C59" }}>{r.paid > 0 ? fmt(r.paid) : "—"}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#4A7C59" }}>{fmt(r.debt)}</div>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <button
                onClick={e => { e.stopPropagation(); setLinkItem(r); }}
                title="Связать с транзакцией"
                style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex", color: r.finance_tx_id ? "#4A7C59" : "#C8C0B0" }}
                onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
                onMouseLeave={e => (e.currentTarget.style.color = r.finance_tx_id ? "#4A7C59" : "#C8C0B0")}
              >
                <LinkSimple size={13} />
              </button>
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
              <button
                onClick={() => update.mutate({ id: r.id, paid: parseFloat(paidDraft) || 0 })}
                style={{ padding: "5px 14px", border: "none", background: "#4A7C59", color: "#fff", fontSize: 11, cursor: "pointer", fontWeight: 600 }}
              >
                Сохранить
              </button>
              <button onClick={() => setEditId(null)}
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["creditors"] }); onClose(); },
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
              <button key={id} onClick={() => setTab(id)}
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
            <button
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
          {loading && <div style={{ padding: 32, textAlign: "center", color: "#A89070", fontSize: 12 }}>Загружаем...</div>}
          {!loading && filtered.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "#C8C0B0", fontSize: 12 }}>Транзакции не найдены</div>}
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

const creditorCols = "28px 1.8fr 1.6fr 110px 110px 110px 110px 90px 28px";

function CreditorsTab() {
  const [addOpen, setAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [linkItem, setLinkItem] = useState<any>(null);
  const [contragentFilter, setContragentFilter] = useState("");
  const clearFilters = () => { setContragentFilter(""); setSelectedIds(new Set()); };
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const { data, isLoading } = useQuery({ queryKey: ["creditors"], queryFn: () => financeApi.creditors() });

  const items: any[] = data?.items || [];
  const totalDebt = data?.total_debt ?? 0;
  const totalOwed = data?.total_owed ?? 0;
  const totalPaid = data?.total_paid ?? 0;
  const uniqueContragents = useMemo(() => [...new Set(items.map((c: any) => c.name).filter(Boolean))].sort() as string[], [items]);
  const filteredItems = contragentFilter ? items.filter((c: any) => c.name === contragentFilter) : items;

  if (isLoading) return <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>;

  return (
    <>
      {addOpen && <AddCreditorModal onClose={() => setAddOpen(false)} />}
      {editItem && <PayCreditorModal item={editItem} onClose={() => setEditItem(null)} />}
      {linkItem && <LinkTxModal creditor={linkItem} onClose={() => setLinkItem(null)} />}

      {(() => {
        const hasFilters = !!contragentFilter;
        const canClear = hasFilters || selectedIds.size > 0;
        const selDebt = filteredItems.filter((c: any) => selectedIds.has(String(c.id))).reduce((s: number, c: any) => s + (c.debt || 0), 0);
        return (
          <div style={{ padding: "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
            <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#6B6355", alignItems: "center" }}>
              {selectedIds.size > 0 && <span style={{ color: "#E8592A", fontWeight: 600 }}>Выбрано {selectedIds.size}</span>}
              {selectedIds.size > 0 && selDebt > 0 && <span style={{ color: "#8B3A3A" }}>{fmt(selDebt)}</span>}
              {selectedIds.size === 0 && <span>{filteredItems.length} записей</span>}
            </div>
            <button onClick={canClear ? clearFilters : undefined} style={{ fontSize: 10, color: canClear ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: canClear ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
              <X size={10} /> Сбросить
            </button>
          </div>
        );
      })()}

      <div style={{ display: "grid", gridTemplateColumns: creditorCols, padding: "8px 28px", borderBottom: "1px solid #EDEBE6", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <Checkbox
            checked={filteredItems.length > 0 && filteredItems.every((c: any) => selectedIds.has(String(c.id)))}
            indeterminate={filteredItems.some((c: any) => selectedIds.has(String(c.id))) && !filteredItems.every((c: any) => selectedIds.has(String(c.id)))}
            onChange={() => {
              const allSel = filteredItems.every((c: any) => selectedIds.has(String(c.id)));
              setSelectedIds(allSel ? new Set() : new Set(filteredItems.map((c: any) => String(c.id))));
            }}
          />
        </div>
        <div><ColumnFilter label="КОНТРАГЕНТ" options={uniqueContragents} value={contragentFilter} onChange={setContragentFilter} /></div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ЗА ЧТО</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ПЛАН</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ОПЛАЧЕНО</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ОТКЛОНЕНИЕ</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ОСТАТОК</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>СРОК</div>
        <div />
      </div>

      {filteredItems.length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>
          Нет открытых обязательств
        </div>
      ) : (
        <>
          {filteredItems.map((c: any, i: number) => {
            const rowId = String(c.id);
            return (
            <div
              key={i}
              onClick={() => setEditItem(c)}
              style={{
                display: "grid", gridTemplateColumns: creditorCols,
                padding: "13px 28px", borderBottom: "1px solid #F2EFE9",
                cursor: "pointer", alignItems: "center", transition: "background 0.1s",
                background: selectedIds.has(rowId) ? "#FFF8F5" : "transparent",
              }}
              onMouseEnter={(e) => { if (!selectedIds.has(rowId)) e.currentTarget.style.background = "#FAF8F5"; }}
              onMouseLeave={(e) => { if (!selectedIds.has(rowId)) e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ display: "flex", alignItems: "center" }}>
                <Checkbox checked={selectedIds.has(rowId)} onChange={() => toggleSelect(rowId)} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{c.name}</div>
                {c.estimate_item_title && (
                  <div style={{ fontSize: 10, color: "#A89070", marginTop: 2 }}>← Смета: {c.estimate_item_title}</div>
                )}
              </div>
              <div style={{ fontSize: 12, color: "#6B6355", paddingRight: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.description || "—"}
              </div>
              <div style={{ fontSize: 13, color: "#6B6355" }}>{fmt(c.amount_plan ?? c.total)}</div>
              <div style={{ fontSize: 13, color: "#4A7C59" }}>{c.paid > 0 ? fmt(c.paid) : "—"}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: c.variance == null ? "#C8C0B0" : c.variance > 0 ? "#8B3A3A" : c.variance < 0 ? "#4A7C59" : "#A89070" }}>
                {c.variance == null ? "—" : c.variance === 0 ? "0 ₽" : `${c.variance > 0 ? "+" : "−"}${fmt(Math.abs(c.variance))}`}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: c.debt > 0 ? "#8B3A3A" : "#4A7C59" }}>
                {c.debt > 0 ? fmt(c.debt) : "Закрыт"}
              </div>
              <div style={{ fontSize: 12, color: deadlineColor(c.due_date) }}>{fmtDate(c.due_date)}</div>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <button
                  onClick={e => { e.stopPropagation(); setLinkItem(c); }}
                  title="Связать с транзакцией"
                  style={{
                    background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex",
                    color: (c.finance_tx_id || c.zenmoney_tx_id) ? "#4A7C59" : "#C8C0B0",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
                  onMouseLeave={e => (e.currentTarget.style.color = (c.finance_tx_id || c.zenmoney_tx_id) ? "#4A7C59" : "#C8C0B0")}
                >
                  <LinkSimple size={13} />
                </button>
              </div>
            </div>
            );
          })}

          <div style={{
            display: "grid", gridTemplateColumns: creditorCols,
            padding: "10px 28px", borderTop: "1px solid #EDEBE6",
            alignItems: "center", background: "#FAF8F5",
          }}>
            <div />
            <div style={{ fontSize: 11, color: "#A89070" }}>{filteredItems.length} записей</div>
            <div style={{ fontSize: 12, color: "#6B6355", fontWeight: 500 }}>{fmt(totalOwed)}</div>
            <div style={{ fontSize: 12, color: "#4A7C59", fontWeight: 500 }}>{fmt(totalPaid)}</div>
            <div />
            <div style={{ fontSize: 13, fontWeight: 700, color: "#8B3A3A" }}>{fmt(totalDebt)}</div>
            <div /><div />
          </div>
        </>
      )}
    </>
  );
}

// ── Главная страница ────────────────────────────────────────────────────────

export default function Debtors() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"debtors" | "unallocated" | "creditors">("debtors");
  const [addCreditorOpen, setAddCreditorOpen] = useState(false);
  const [addReceivableOpen, setAddReceivableOpen] = useState(false);

  const { data: debtData } = useQuery({ queryKey: ["debtors"], queryFn: financeApi.debtors });
  const { data: credData } = useQuery({ queryKey: ["creditors"], queryFn: () => financeApi.creditors() });
  const { data: recData }  = useQuery({ queryKey: ["receivables"], queryFn: financeApi.receivables });

  const receivable = (debtData?.total ?? 0) + (recData?.total_debt ?? 0);
  const payable    = credData?.total_debt ?? 0;
  const openRecCount = recData?.open_items?.length ?? 0;

  const TABS = [
    { id: "debtors",     label: "Нам должны" },
    { id: "creditors",   label: "Мы должны" },
    { id: "unallocated", label: openRecCount > 0 ? `Нераспределённые (${openRecCount})` : "Нераспределённые" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>

      {/* Header */}
      <div style={{ padding: "24px 28px 0", borderBottom: "1px solid #EDEBE6", flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Обязательства</div>
          <div style={{ display: "flex", gap: 28 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 3 }}>ЖДЁМ ОТ КЛИЕНТОВ</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#4A7C59" }}>{fmt(receivable)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 3 }}>МЫ ДОЛЖНЫ</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#8B3A3A" }}>{fmt(payable)}</div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 24 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as any)}
              style={{
                fontSize: 13, padding: "0 0 12px",
                border: "none", background: "none", cursor: "pointer",
                color: tab === t.id ? "#1A1A1A" : "#A89070",
                fontWeight: tab === t.id ? 600 : 400,
                borderBottom: tab === t.id ? "2px solid #E8592A" : "2px solid transparent",
                marginBottom: -1,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Modals */}
      {addCreditorOpen && <AddCreditorModal onClose={() => setAddCreditorOpen(false)} />}
      {addReceivableOpen && <AddReceivableModal onClose={() => setAddReceivableOpen(false)} />}

      {/* Toolbar */}
      <div style={{ padding: "12px 28px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "flex-end", flexShrink: 0 }}>
        {tab === "debtors" && (
          <button onClick={() => navigate("/orders")}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
            <Plus size={13} weight="bold" /> Добавить
          </button>
        )}
        {tab === "creditors" && (
          <button onClick={() => setAddCreditorOpen(true)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
            <Plus size={13} weight="bold" /> Добавить
          </button>
        )}
        {tab === "unallocated" && (
          <button onClick={() => setAddReceivableOpen(true)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
            <Plus size={13} weight="bold" /> Добавить
          </button>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {tab === "debtors" && <DebtorsTab />}
        {tab === "unallocated" && <UnallocatedTab />}
        {tab === "creditors" && <CreditorsTab />}
      </div>
    </div>
  );
}
