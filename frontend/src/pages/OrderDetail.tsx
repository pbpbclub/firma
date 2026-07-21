import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { MONO } from "../components/ui/Num";
import { ConfirmModal } from "../components/ui/Modal";
import { Loading } from "../components/ui/Loading";
import { ordersApi, customersApi, estimatesApi, expensesApi } from "../api";
import { ArrowLeft, Plus, CaretRight, Trash, LinkSimple, PencilSimple } from "@phosphor-icons/react";
import { ExpenseModal, EXPENSE_CATEGORIES } from "../components/ExpenseModal";
import { ProfitLadder, PlanFactBlock } from "../components/OrderFinance";
import { useNavigationGuard, NavigationGuardModal } from "../components/NavigationGuard";

const ALL_STATUSES = [
  { value: "draft",         label: "Черновик",       color: "#A89070" },
  { value: "estimate",      label: "Смета",          color: "#E8592A" },
  { value: "project",       label: "Проект",         color: "#E8592A" },
  { value: "in_production", label: "В производстве", color: "#1A1A1A" },
  { value: "completed",     label: "Завершён",       color: "#4A7C59" },
  { value: "cancelled",     label: "Отменён",        color: "#8B3A3A" },
];

const BRANDS = [
  { value: "MeRA",    color: "#2E6DA4" },
  { value: "pbpb",    color: "#7B4F9E" },
  { value: "Транзит", color: "#3D8C6B" },
];

const ESTIMATE_STATUS: Record<string, string> = { approved: "Согласована", draft: "Черновик" };

function fmt(n: number | null | undefined) {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

interface FormState {
  title: string;
  status: string;
  brand: string;
  priority: string;
  deadline: string;
  customer_id: string;
  price_plan: string;
  cost_plan: string;
}

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const blocker = useNavigationGuard(isDirty);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  const { data: order, isLoading } = useQuery({
    queryKey: ["order-detail", id],
    queryFn: () => ordersApi.get(id!),
    enabled: !!id,
  });

  const { data: customers = [] } = useQuery({
    queryKey: ["customers", ""],
    queryFn: () => customersApi.list(""),
  });

  const { data: estimates = [] } = useQuery({
    queryKey: ["order-estimates", id],
    queryFn: () => ordersApi.estimate(id!),
    enabled: !!id,
  });

  useEffect(() => {
    if (order && !form) {
      setForm({
        title: order.title || "",
        status: order.status || "draft",
        brand: order.brand || "",
        priority: order.priority || "normal",
        deadline: order.deadline ? order.deadline.split("T")[0] : "",
        customer_id: order.customer_id ? String(order.customer_id) : "",
        price_plan: order.price_plan != null ? String(order.price_plan) : "",
        cost_plan: order.cost_plan != null ? String(order.cost_plan) : "",
      });
    }
  }, [order]);

  const saveMutation = useMutation({
    mutationFn: (data: Record<string, any>) => ordersApi.update(id!, data),
    onSuccess: () => {
      setIsDirty(false);
      qc.invalidateQueries({ queryKey: ["order-detail", id] });
      qc.invalidateQueries({ queryKey: ["orders-v2"] });
    },
  });

  // ── Фактические траты ──────────────────────────────────────────────────
  const [expenseModal, setExpenseModal] = useState<{ open: boolean; item?: any } | null>(null);
  const [delExpense, setDelExpense] = useState<any>(null);

  const { data: expensesData } = useQuery({
    queryKey: ["order-expenses", id],
    queryFn: () => expensesApi.list(id!),
    enabled: !!id,
  });

  // План/факт по строкам сметы (обязательства): кто планировался vs кто исполнил.
  const { data: obligationsData } = useQuery({
    queryKey: ["order-obligations", id],
    queryFn: () => ordersApi.obligations(id!),
    enabled: !!id,
  });

  // Факт меняет план-факт и маржу → инвалидируем и карточку, и списки.
  const invalidateFact = () => {
    qc.invalidateQueries({ queryKey: ["order-expenses", id] });
    qc.invalidateQueries({ queryKey: ["order-obligations", id] });
    qc.invalidateQueries({ queryKey: ["order-detail", id] });
    qc.invalidateQueries({ queryKey: ["orders-v2"] });
    qc.invalidateQueries({ queryKey: ["orders-plan-fact-summary"] });
  };

  const saveExpense = useMutation({
    mutationFn: (data: any) => expenseModal?.item
      ? expensesApi.update(id!, expenseModal.item.id, data)
      : expensesApi.create(id!, data),
    onSuccess: () => { invalidateFact(); setExpenseModal(null); },
  });

  const removeExpense = useMutation({
    mutationFn: (e: any) => expensesApi.delete(id!, e.id, !!e.group_id),
    onSuccess: () => { invalidateFact(); setDelExpense(null); },
  });

  // ── Резерв под материалы ───────────────────────────────────────────────
  const [reserveEdit, setReserveEdit] = useState<string | null>(null);
  const invalidateReserve = () => {
    qc.invalidateQueries({ queryKey: ["order-detail", id] });
    qc.invalidateQueries({ queryKey: ["orders-v2"] });
    qc.invalidateQueries({ queryKey: ["free-cash"] });
  };
  const setReserve = useMutation({
    mutationFn: (amount: number) => ordersApi.reserve(id!, amount),
    onSuccess: () => { invalidateReserve(); setReserveEdit(null); },
  });
  const releaseReserve = useMutation({
    mutationFn: () => ordersApi.releaseReserve(id!),
    onSuccess: () => invalidateReserve(),
  });

  const deleteMutation = useMutation({
    mutationFn: () => ordersApi.delete(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders-v2"] });
      navigate("/orders");
    },
  });

  const addEstimateMutation = useMutation({
    mutationFn: () => estimatesApi.createSet(id!),
    onSuccess: (newSet: any) => {
      navigate(`/orders/${id}/estimate?set=${newSet.id}`);
    },
  });

  const handleSave = () => {
    if (!form) return;
    saveMutation.mutate({
      title: form.title.trim() || undefined,
      status: form.status,
      brand: form.brand || null,
      priority: form.priority,
      deadline: form.deadline || null,
      customer_id: form.customer_id && form.customer_id !== "__new__" ? form.customer_id : null,
    });
  };

  const field = (f: Partial<FormState>) => { setForm(prev => prev ? { ...prev, ...f } : prev); setIsDirty(true); };

  const statusColor = ALL_STATUSES.find(s => s.value === form?.status)?.color || "#1A1A1A";
  const brandColor = BRANDS.find(b => b.value === form?.brand)?.color || "#A89070";
  const paidTotal = order?.payments?.reduce((s: number, p: any) => s + p.amount, 0) ?? 0;

  if (isLoading || !form) {
    return <Loading />;
  }

  return (
    <>
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>

      {/* Top bar */}
      <div style={{ padding: "16px 32px", borderBottom: "1px solid #EDEBE6", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button
            onClick={() => navigate("/orders")}
            style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", color: "#A89070", fontSize: 12, padding: 0, fontFamily: "inherit" }}
            onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
            onMouseLeave={e => (e.currentTarget.style.color = "#A89070")}
          >
            <ArrowLeft size={13} /> Заказы
          </button>
          <div style={{ width: 1, height: 14, background: "#EDEBE6" }} />
          {/* Название ведёт; номер — тусклый хвост для инженерии */}
          <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>{order?.title}</span>
          <span style={{ fontSize: 10, color: "#C8C0B0", fontFamily: MONO }}>{order?.number}</span>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {saveMutation.isError && <span style={{ fontSize: 11, color: "#8B3A3A" }}>Ошибка сохранения</span>}
          {saveMutation.isSuccess && <span style={{ fontSize: 11, color: "#4A7C59" }}>Сохранено ✓</span>}
          <button
            onClick={() => setConfirmDelete(true)}
            title="Удалить заказ"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, background: "#F2EFE9", border: "none", cursor: "pointer", color: "#8B3A3A" }}
            onMouseEnter={e => { e.currentTarget.style.background = "#8B3A3A"; e.currentTarget.style.color = "#fff"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "#F2EFE9"; e.currentTarget.style.color = "#8B3A3A"; }}
          >
            <Trash size={14} />
          </button>
          <button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            style={{ padding: "7px 22px", background: "#E8592A", color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: saveMutation.isPending ? "default" : "pointer", opacity: saveMutation.isPending ? 0.7 : 1, fontFamily: "inherit" }}
          >
            {saveMutation.isPending ? "Сохраняем..." : "Сохранить"}
          </button>
        </div>

        {/* Delete confirmation modal */}
        {confirmDelete && (
          <ConfirmModal
            message={`Удалить заказ «${order?.title ?? ""}»? Это действие необратимо — сметы и платежи будут удалены навсегда.`}
            confirmLabel={deleteMutation.isPending ? "Удаляем..." : "Удалить"}
            onConfirm={() => deleteMutation.mutate()}
            onCancel={() => setConfirmDelete(false)}
          />
        )}

        {/* Расход: создание / правка */}
        {expenseModal?.open && (
          <ExpenseModal
            orderId={id!}
            expense={expenseModal.item}
            saving={saveExpense.isPending}
            onSave={(d) => saveExpense.mutate(d)}
            onClose={() => setExpenseModal(null)}
          />
        )}

        {delExpense && (
          <ConfirmModal
            message={delExpense.group_id
              ? `Удалить расход «${delExpense.title}»? Он входит в разноску на несколько заказов — удалится вся группа.`
              : `Удалить расход «${delExpense.title}» на ${fmt(delExpense.amount)}? Факт и маржа пересчитаются.`}
            confirmLabel={removeExpense.isPending ? "Удаляем..." : "Удалить"}
            onConfirm={() => removeExpense.mutate(delExpense)}
            onCancel={() => setDelExpense(null)}
          />
        )}
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflow: "auto" }}>
        <div style={{ maxWidth: 760, padding: "28px 32px 48px" }}>

          {/* Editable title */}
          <input
            value={form.title}
            onChange={e => field({ title: e.target.value })}
            onKeyDown={e => e.key === "Enter" && handleSave()}
            style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em", color: "#1A1A1A", border: "none", borderBottom: "2px solid transparent", outline: "none", background: "transparent", width: "100%", padding: "0 0 4px", fontFamily: "inherit", marginBottom: 20, boxSizing: "border-box" }}
            onFocus={e => (e.currentTarget.style.borderBottomColor = "#EDEBE6")}
            onBlur={e => (e.currentTarget.style.borderBottomColor = "transparent")}
          />

          {/* Quick selectors */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 28, paddingBottom: 24, borderBottom: "1px solid #EDEBE6" }}>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>СТАТУС</div>
              <select
                value={form.status}
                onChange={e => field({ status: e.target.value })}
                style={{ border: "1px solid #EDEBE6", padding: "6px 10px", fontSize: 12, fontWeight: 600, outline: "none", background: "#fff", color: statusColor, cursor: "pointer", fontFamily: "inherit" }}
              >
                {ALL_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>БРЕНД</div>
              <select
                value={form.brand}
                onChange={e => field({ brand: e.target.value })}
                style={{ border: `1px solid ${form.brand ? brandColor : "#EDEBE6"}`, padding: "6px 10px", fontSize: 12, fontWeight: 600, outline: "none", background: "#fff", color: form.brand ? brandColor : "#A89070", cursor: "pointer", fontFamily: "inherit" }}
              >
                <option value="">— без бренда —</option>
                {BRANDS.map(b => <option key={b.value} value={b.value}>{b.value}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ПРИОРИТЕТ</div>
              <select
                value={form.priority}
                onChange={e => field({ priority: e.target.value })}
                style={{ border: "1px solid #EDEBE6", padding: "6px 10px", fontSize: 12, outline: "none", background: "#fff", cursor: "pointer", fontFamily: "inherit" }}
              >
                <option value="low">Низкий</option>
                <option value="normal">Обычный</option>
                <option value="high">Высокий</option>
                <option value="urgent">Срочный</option>
              </select>
            </div>
          </div>

          {/* Fields grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "18px 28px", marginBottom: 32 }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>КЛИЕНТ</div>
              <select
                value={form.customer_id === "__new__" ? "__new__" : form.customer_id}
                onChange={e => {
                  if (e.target.value === "__new__") {
                    field({ customer_id: "__new__" });
                    setNewCustomerName("");
                  } else {
                    field({ customer_id: e.target.value });
                    setNewCustomerName("");
                  }
                }}
                style={{ width: "100%", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none", background: "#fff", fontFamily: "inherit" }}
              >
                <option value="">— не выбран —</option>
                {(customers as any[]).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                <option value="__new__">+ Создать нового клиента</option>
              </select>
              {form.customer_id === "__new__" && (
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <input
                    autoFocus
                    placeholder="Имя клиента"
                    value={newCustomerName}
                    onChange={e => setNewCustomerName(e.target.value)}
                    onKeyDown={async e => {
                      if (e.key === "Escape") { field({ customer_id: "" }); setNewCustomerName(""); }
                      if (e.key === "Enter" && newCustomerName.trim()) {
                        setCreatingCustomer(true);
                        try {
                          const c = await customersApi.create({ name: newCustomerName.trim() });
                          qc.invalidateQueries({ queryKey: ["customers"] });
                          field({ customer_id: String(c.id) });
                          setNewCustomerName("");
                        } finally { setCreatingCustomer(false); }
                      }
                    }}
                    style={{ flex: 1, border: "1px solid #E8592A", padding: "6px 10px", fontSize: 13, outline: "none", fontFamily: "inherit" }}
                  />
                  <button
                    disabled={creatingCustomer || !newCustomerName.trim()}
                    onClick={async () => {
                      if (!newCustomerName.trim()) return;
                      setCreatingCustomer(true);
                      try {
                        const c = await customersApi.create({ name: newCustomerName.trim() });
                        qc.invalidateQueries({ queryKey: ["customers"] });
                        field({ customer_id: String(c.id) });
                        setNewCustomerName("");
                      } finally { setCreatingCustomer(false); }
                    }}
                    style={{ padding: "6px 14px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600, opacity: creatingCustomer || !newCustomerName.trim() ? 0.5 : 1, fontFamily: "inherit" }}
                  >
                    {creatingCustomer ? "..." : "Создать"}
                  </button>
                </div>
              )}
            </div>
            {/* Плановые суммы — из сметы, read-only: _sync_order_from_set перезапишет
                любую ручную правку при утверждении сметы. Правятся в редакторе сметы. */}
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>СТОИМОСТЬ (план)</div>
              <div style={{ padding: "7px 10px", fontSize: 13, fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: "#1A1A1A", background: "#FAF8F5" }}>
                {fmt(order?.price_plan)} <span style={{ fontSize: 9, color: "#A89070", fontFamily: "inherit" }}>из сметы</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>СЕБЕСТОИМОСТЬ (план)</div>
              <div style={{ padding: "7px 10px", fontSize: 13, fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: "#1A1A1A", background: "#FAF8F5" }}>
                {fmt(order?.cost_plan)} <span style={{ fontSize: 9, color: "#A89070", fontFamily: "inherit" }}>из сметы</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ДЕДЛАЙН</div>
              <input
                type="date"
                value={form.deadline}
                onChange={e => field({ deadline: e.target.value })}
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none", fontFamily: "inherit" }}
              />
            </div>
          </div>

          {/* Estimates */}
          <div style={{ paddingTop: 24, borderTop: "1px solid #EDEBE6", marginBottom: 32 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>СМЕТЫ</div>
              <button
                onClick={() => addEstimateMutation.mutate()}
                disabled={addEstimateMutation.isPending}
                style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 12px", border: "1px solid #EDEBE6", background: "none", fontSize: 11, cursor: "pointer", color: "#1A1A1A", fontFamily: "inherit" }}
              >
                <Plus size={11} /> Новая смета
              </button>
            </div>
            {(estimates as any[]).length === 0 ? (
              <div style={{ fontSize: 12, color: "#C8C0B0", padding: "8px 0" }}>Сметы не добавлены</div>
            ) : (
              (estimates as any[]).map((s: any, i: number) => {
                // Эндпоинт отдаёт сметы с позициями, но без агрегата по сете —
                // суммируем из items. Клиентская цена для безнала = sale × (1+bank%),
                // та же формула, что в _sync_order_from_set и редакторе сметы.
                const items = s.items ?? [];
                const isBank = s.payment_type === "bank";
                const bpct = s.bank_pct ?? 13;
                const cost = items.reduce((a: number, it: any) => a + (it.cost_total || 0), 0);
                const sale = items.reduce((a: number, it: any) => a + (isBank ? Math.round((it.sale_price || 0) * (1 + (it.bank_pct ?? bpct) / 100)) : (it.sale_price || 0)), 0);
                const delta = sale - cost;
                const metric = (label: string, value: string, color: string) => (
                  <div style={{ textAlign: "right", minWidth: 76 }}>
                    <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.04em" }}>{label}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{value}</div>
                  </div>
                );
                return (
                <div
                  key={s.id}
                  onClick={() => navigate(`/orders/${id}/estimate?set=${s.id}`)}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, padding: "12px 10px", borderBottom: "1px solid #F2EFE9", cursor: "pointer" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
                  onMouseLeave={e => (e.currentTarget.style.background = "")}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>
                      {s.name || `Смета ${i + 1}`}
                    </span>
                    <span style={{ fontSize: 10, color: s.status === "approved" ? "#4A7C59" : "#A89070", fontWeight: 500 }}>
                      {ESTIMATE_STATUS[s.status] ?? s.status}
                    </span>
                  </div>
                  {metric("СЕБЕСТ.", fmt(cost), "#6B6355")}
                  {metric("ПРОДАЖА", fmt(sale), "#1A1A1A")}
                  {metric("Δ", delta === 0 ? "—" : (delta > 0 ? "+" : "") + fmt(delta), delta >= 0 ? "#4A7C59" : "#8B3A3A")}
                  <CaretRight size={13} style={{ color: "#C8C0B0", flexShrink: 0 }} />
                </div>
                );
              })
            )}
          </div>

          {/* Финансы — та же лестница, что в панели списка (считает бэк) */}
          <div style={{ paddingTop: 24, borderTop: "1px solid #EDEBE6", marginBottom: 32 }}>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 14 }}>ФИНАНСЫ</div>
            {order && <ProfitLadder order={order} paidTotal={paidTotal} />}
            {order?.price_plan > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ height: 2, background: "#F2EFE9" }}>
                  <div style={{ height: 2, background: "#E8592A", width: `${Math.min(100, (paidTotal / order.price_plan) * 100)}%` }} />
                </div>
              </div>
            )}
          </div>

          {/* Резерв под материалы */}
          {order && (
            <div style={{ paddingTop: 24, borderTop: "1px solid #EDEBE6", marginBottom: 32 }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 14 }}>РЕЗЕРВ ПОД МАТЕРИАЛЫ</div>
              {(() => {
                const active = order.reserve_active;
                const released = order.reserved_amount > 0 && order.reserve_released_at;
                const suggested = order.reserve_suggested || 0;

                if (reserveEdit !== null) {
                  return (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input type="number" min="0" value={reserveEdit} autoFocus
                        onChange={e => setReserveEdit(e.target.value)}
                        style={{ width: 140, border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none", fontFamily: MONO, textAlign: "right" }} />
                      <button onClick={() => setReserve.mutate(parseFloat(reserveEdit) || 0)} disabled={setReserve.isPending}
                        style={{ padding: "7px 16px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                        {setReserve.isPending ? "..." : "Отложить"}
                      </button>
                      <button onClick={() => setReserveEdit(null)}
                        style={{ padding: "7px 12px", border: "1px solid #EDEBE6", background: "none", color: "#A89070", fontSize: 12, cursor: "pointer" }}>Отмена</button>
                    </div>
                  );
                }

                if (active) {
                  return (
                    <div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        <span style={{ fontSize: 15, fontWeight: 700, color: "#E8592A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(order.reserved_amount)}</span>
                        <span style={{ fontSize: 11, color: "#A89070" }}>отложено под закупку — тратить нельзя</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                        <button onClick={() => releaseReserve.mutate()} disabled={releaseReserve.isPending}
                          style={{ padding: "6px 14px", border: "1px solid #4A7C59", background: "none", color: "#4A7C59", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                          {releaseReserve.isPending ? "..." : "Материалы закуплены — снять резерв"}
                        </button>
                        <button onClick={() => setReserveEdit(String(order.reserved_amount))}
                          style={{ padding: "6px 12px", border: "1px solid #EDEBE6", background: "none", color: "#6B6355", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Изменить</button>
                      </div>
                    </div>
                  );
                }

                if (released) {
                  return (
                    <div>
                      <div style={{ fontSize: 12, color: "#A89070" }}>
                        Резерв снят (закупка проведена) · было {fmt(order.reserved_amount)}
                      </div>
                      <button onClick={() => setReserveEdit(String(suggested))}
                        style={{ marginTop: 10, padding: "6px 14px", border: "1px solid #EDEBE6", background: "none", color: "#6B6355", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Зарезервировать снова</button>
                    </div>
                  );
                }

                // Резерва нет
                return (
                  <div>
                    <div style={{ fontSize: 12, color: "#6B6355" }}>
                      {suggested > 0
                        ? <>Себестоимость материалов по смете <b style={{ fontFamily: MONO, color: "#1A1A1A" }}>{fmt(suggested)}</b> — отложить под закупку?</>
                        : <>Резерв под материалы не задан.</>}
                    </div>
                    <button onClick={() => setReserveEdit(String(suggested || ""))}
                      style={{ marginTop: 12, padding: "7px 16px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                      Зарезервировать
                    </button>
                  </div>
                );
              })()}
            </div>
          )}

          {/* План-Факт */}
          {order?.plan_fact?.has_estimate && (
            <div style={{ paddingTop: 24, borderTop: "1px solid #EDEBE6", marginBottom: 32 }}>
              <PlanFactBlock planFact={order.plan_fact} />
            </div>
          )}

          {/* План/факт по строкам сметы — кто планировался vs кто исполнил */}
          {!!obligationsData?.items?.length && (
            <div style={{ paddingTop: 24, borderTop: "1px solid #EDEBE6", marginBottom: 32 }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 14 }}>
                ПЛАН / ФАКТ ПО РАБОТАМ
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "0 20px", fontSize: 9, color: "#A89070", letterSpacing: "0.05em", paddingBottom: 6, borderBottom: "1px solid #EDEBE6" }}>
                <div>СТРОКА · ИСПОЛНИТЕЛЬ</div>
                <div style={{ textAlign: "right" }}>ПЛАН</div>
                <div style={{ textAlign: "right" }}>ФАКТ</div>
              </div>
              {obligationsData.items.map((o: any) => {
                const actual = (o.actual_executors || []).join(", ");
                const paidColor = o.status === "closed" ? "#4A7C59" : o.paid > 0 ? "#1A1A1A" : "#C8C0B0";
                return (
                  <div key={o.creditor_id} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "0 20px", padding: "9px 0", borderBottom: "1px solid #F2EFE9", alignItems: "baseline" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "#1A1A1A" }}>
                        {o.title}
                        {o.divergence && (
                          <span title="Расхождение план/факт" style={{ marginLeft: 8, fontSize: 9, color: "#E8592A", letterSpacing: "0.05em", verticalAlign: "middle" }}>⚠ РАСХОЖДЕНИЕ</span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>
                        план: {o.planned_executor || "—"}
                        <span style={{ color: "#C8C0B0" }}>  ·  </span>
                        факт: <span style={{ color: actual ? (o.divergence ? "#E8592A" : "#4A7C59") : "#C8C0B0" }}>{actual || "—"}</span>
                      </div>
                    </div>
                    <div style={{ textAlign: "right", fontSize: 13, fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: "#6B6355" }}>
                      {fmt(o.planned_amount)}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 13, fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: paidColor }}>{fmt(o.paid)}</div>
                      {o.remaining > 0 && o.paid > 0 && (
                        <div style={{ fontSize: 10, color: "#A89070", fontFamily: MONO }}>ост. {fmt(o.remaining)}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Расходы (факт) */}
          <div style={{ paddingTop: 24, borderTop: "1px solid #EDEBE6", marginBottom: 32 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>
                РАСХОДЫ (ФАКТ)
                {expensesData?.total > 0 && (
                  <span style={{ color: "#1A1A1A", marginLeft: 8, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                    {fmt(expensesData.total)}
                  </span>
                )}
              </div>
              <button
                onClick={() => setExpenseModal({ open: true })}
                style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "1px solid #EDEBE6",
                         padding: "4px 10px", fontSize: 11, color: "#6B6355", cursor: "pointer", fontFamily: "inherit" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#E8592A"; e.currentTarget.style.color = "#E8592A"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "#EDEBE6"; e.currentTarget.style.color = "#6B6355"; }}
              >
                <Plus size={11} /> Добавить расход
              </button>
            </div>

            {!expensesData?.items?.length ? (
              <div style={{ fontSize: 12, color: "#C8C0B0" }}>
                Трат не внесено — маржа считается по плану
              </div>
            ) : (
              <>
                {expensesData.items.map((e: any) => {
                  const cat = EXPENSE_CATEGORIES.find(c => c.v === e.category);
                  return (
                    <div key={e.id}
                      style={{ display: "grid", gridTemplateColumns: "78px 1fr 96px 110px 52px",
                               gap: 10, alignItems: "center", padding: "9px 0", borderBottom: "1px solid #F2EFE9" }}>
                      <div style={{ fontSize: 11, color: "#A89070", fontFamily: MONO }}>{fmtDate(e.expense_date)}</div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {e.title}
                          {(e.finance_tx_id || e.zenmoney_tx_id) && (
                            <LinkSimple size={10} style={{ color: "#4A7C59", marginLeft: 5 }} />
                          )}
                          {e.creditor_id && (
                            <span title="Оплата обязательства — в факте учтена один раз"
                              style={{ fontSize: 9, color: "#4A7C59", marginLeft: 5 }}>обяз.</span>
                          )}
                        </div>
                        {e.supplier && <div style={{ fontSize: 10, color: "#A89070", marginTop: 1 }}>{e.supplier}</div>}
                      </div>
                      <div style={{ fontSize: 10, color: "#6B6355" }}>{cat?.l ?? e.category}</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#8B3A3A", textAlign: "right",
                                    fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(e.amount)}</div>
                      <div style={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
                        <button onClick={() => setExpenseModal({ open: true, item: e })}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 3, display: "flex" }}
                          onMouseEnter={ev => (ev.currentTarget.style.color = "#1A1A1A")}
                          onMouseLeave={ev => (ev.currentTarget.style.color = "#C8C0B0")}>
                          <PencilSimple size={13} />
                        </button>
                        <button onClick={() => setDelExpense(e)}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 3, display: "flex" }}
                          onMouseEnter={ev => (ev.currentTarget.style.color = "#8B3A3A")}
                          onMouseLeave={ev => (ev.currentTarget.style.color = "#C8C0B0")}>
                          <Trash size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {Object.keys(expensesData.by_category || {}).length > 1 && (
                  <div style={{ display: "flex", gap: 14, marginTop: 10, fontSize: 10, color: "#A89070" }}>
                    {Object.entries(expensesData.by_category).map(([k, v]: any) => (
                      <span key={k}>{k}: <span style={{ color: "#1A1A1A", fontFamily: MONO }}>{fmt(v)}</span></span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Payments */}
          {order?.payments?.length > 0 && (
            <div style={{ paddingTop: 24, borderTop: "1px solid #EDEBE6" }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 14 }}>ПЛАТЕЖИ</div>
              {order.payments.map((p: any, i: number) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "10px 0", borderBottom: "1px solid #F2EFE9" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(p.amount)}</div>
                    {p.note && <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>{p.note}</div>}
                  </div>
                  <div style={{ fontSize: 11, color: "#A89070", fontFamily: MONO }}>{fmtDate(p.paid_at)}</div>
                </div>
              ))}
            </div>
          )}

        </div>
      </div>
    </div>

    <NavigationGuardModal blocker={blocker} />
    </>
  );
}
