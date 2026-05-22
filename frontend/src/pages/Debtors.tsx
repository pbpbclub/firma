import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { financeApi } from "../api";
import { useNavigate } from "react-router-dom";
import { Bank, X, Check, Plus, Funnel } from "@phosphor-icons/react";

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

const debtorCols = "2fr 1fr 130px 150px 130px 100px";

function DebtorsTab() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ["debtors"], queryFn: financeApi.debtors });
  const [statusFilter, setStatusFilter] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [orderFilter, setOrderFilter] = useState("");

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

  if (isLoading) return <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>;

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: debtorCols, padding: "8px 28px", borderBottom: "1px solid #EDEBE6", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>КЛИЕНТ / ЗАКАЗ</span>
          <ColumnFilter options={uniqueClients} value={clientFilter} onChange={setClientFilter} />
          <ColumnFilter options={uniqueOrders} value={orderFilter} onChange={setOrderFilter} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>СТАТУС</span>
          <ColumnFilter options={uniqueStatuses} value={statusFilter} onChange={setStatusFilter} />
        </div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>СОГЛАСОВАНО</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ОПЛАЧЕНО</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ОЖИДАЕМ</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>ДЕДЛАЙН</div>
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>
          Нет согласованных смет с задолженностью
        </div>
      ) : (
        <>
          {filtered.map((d: any, i: number) => (
            <div
              key={i}
              onClick={() => navigate(`/orders/${d.number}`)}
              style={{
                display: "grid", gridTemplateColumns: debtorCols,
                padding: "13px 28px", borderBottom: "1px solid #F2EFE9",
                cursor: "pointer", alignItems: "center", transition: "background 0.1s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#FAF8F5")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
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
            </div>
          ))}

          <div style={{
            display: "grid", gridTemplateColumns: debtorCols,
            padding: "10px 28px", borderTop: "1px solid #EDEBE6",
            alignItems: "center", background: "#FAF8F5",
          }}>
            <div style={{ fontSize: 11, color: "#A89070" }}>{filtered.length} заказов</div>
            <div />
            <div style={{ fontSize: 12, color: "#6B6355", fontWeight: 500 }}>{fmt(totalPlan)}</div>
            <div style={{ fontSize: 12, color: "#4A7C59", fontWeight: 500 }}>{fmt(totalPaid)}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#E8592A" }}>{fmt(total)}</div>
            <div />
          </div>
        </>
      )}
      <ReceivablesSection />
    </>
  );
}

// ── Секция: выставленные счета (receivables из вики) ──────────────────────

function ReceivablesSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["receivables"], queryFn: financeApi.receivables });
  const [editId, setEditId] = useState<number | null>(null);
  const [paidDraft, setPaidDraft] = useState("");

  const update = useMutation({
    mutationFn: ({ id, paid }: { id: number; paid: number }) =>
      financeApi.updateReceivable(id, { paid }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["receivables"] }); setEditId(null); },
  });

  const items: any[] = data?.open_items || [];
  if (isLoading) return null;
  if (items.length === 0) return null;

  const recCols = "2fr 2fr 120px 120px 120px";

  return (
    <>
      {/* Section divider */}
      <div style={{ padding: "14px 28px 10px", borderTop: "2px solid #EDEBE6", marginTop: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>ВЫСТАВЛЕННЫЕ СЧЕТА (ВИКИ)</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#4A7C59" }}>{fmt(data?.total_debt ?? 0)}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: recCols, padding: "6px 28px 6px", borderBottom: "1px solid #EDEBE6" }}>
        {["Клиент", "Назначение", "Счёт", "Оплачено", "Остаток"].map(h => (
          <div key={h} style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>{h}</div>
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

// ── Вкладка: кредиторы ─────────────────────────────────────────────────────

const creditorCols = "2fr 2fr 130px 130px 130px 100px";

function CreditorsTab() {
  const [addOpen, setAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [contragentFilter, setContragentFilter] = useState("");
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

      <div style={{ padding: "12px 28px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={() => setAddOpen(true)}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600 }}
        >
          <Plus size={13} weight="bold" /> Добавить
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: creditorCols, padding: "8px 28px", borderBottom: "1px solid #EDEBE6", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>Контрагент</span>
          <ColumnFilter options={uniqueContragents} value={contragentFilter} onChange={setContragentFilter} />
        </div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>За что</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>Сумма долга</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>Оплачено</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>Остаток</div>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em" }}>Срок</div>
      </div>

      {filteredItems.length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>
          Нет открытых обязательств
        </div>
      ) : (
        <>
          {filteredItems.map((c: any, i: number) => (
            <div
              key={i}
              onClick={() => setEditItem(c)}
              style={{
                display: "grid", gridTemplateColumns: creditorCols,
                padding: "13px 28px", borderBottom: "1px solid #F2EFE9",
                cursor: "pointer", alignItems: "center", transition: "background 0.1s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#FAF8F5")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>{c.name}</div>
              <div style={{ fontSize: 12, color: "#6B6355", paddingRight: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.description || "—"}
              </div>
              <div style={{ fontSize: 13, color: "#1A1A1A" }}>{fmt(c.total)}</div>
              <div style={{ fontSize: 13, color: "#4A7C59" }}>{c.paid > 0 ? fmt(c.paid) : "—"}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: c.debt > 0 ? "#8B3A3A" : "#4A7C59" }}>
                {c.debt > 0 ? fmt(c.debt) : "Закрыт"}
              </div>
              <div style={{ fontSize: 12, color: deadlineColor(c.due_date) }}>{fmtDate(c.due_date)}</div>
            </div>
          ))}

          <div style={{
            display: "grid", gridTemplateColumns: creditorCols,
            padding: "10px 28px", borderTop: "1px solid #EDEBE6",
            alignItems: "center", background: "#FAF8F5",
          }}>
            <div style={{ fontSize: 11, color: "#A89070" }}>{filteredItems.length} записей</div>
            <div />
            <div style={{ fontSize: 12, color: "#6B6355", fontWeight: 500 }}>{fmt(totalOwed)}</div>
            <div style={{ fontSize: 12, color: "#4A7C59", fontWeight: 500 }}>{fmt(totalPaid)}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#8B3A3A" }}>{fmt(totalDebt)}</div>
            <div />
          </div>
        </>
      )}
    </>
  );
}

// ── Главная страница ────────────────────────────────────────────────────────

const TABS = [
  { id: "debtors",   label: "Нам должны" },
  { id: "creditors", label: "Мы должны" },
];

export default function Debtors() {
  const [tab, setTab] = useState<"debtors" | "creditors">("debtors");

  const { data: debtData } = useQuery({ queryKey: ["debtors"], queryFn: financeApi.debtors });
  const { data: credData } = useQuery({ queryKey: ["creditors"], queryFn: () => financeApi.creditors() });
  const { data: recData }  = useQuery({ queryKey: ["receivables"], queryFn: financeApi.receivables });

  const receivable = (debtData?.total ?? 0) + (recData?.total_debt ?? 0);
  const payable    = credData?.total_debt ?? 0;

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

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {tab === "debtors" ? <DebtorsTab /> : <CreditorsTab />}
      </div>
    </div>
  );
}
