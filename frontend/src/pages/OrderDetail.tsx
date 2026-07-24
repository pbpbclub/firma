// Карточка заказа. Ось: сводка деньгами → ПЛАН (смета, резерв) → ФАКТ (расходы,
// платежи, исполнители) → ИТОГ (план-факт и лестница прибыли). Ось видна всегда:
// без сметы — CTA создать, с черновиком — плашка «утверди».
import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { MONO } from "../components/ui/Num";
import { ConfirmModal } from "../components/ui/Modal";
import { Loading } from "../components/ui/Loading";
import { Button } from "../components/ui/Button";
import { fmtMoney, fmtDate } from "../components/ui/format";
import { ESTIMATE_STATUS } from "../components/domain";
import { ordersApi, customersApi, estimatesApi, expensesApi } from "../api";
import { Plus, CaretRight, Trash, LinkSimple, PencilSimple, Warning } from "@phosphor-icons/react";
import { ExpenseModal, EXPENSE_CATEGORIES } from "../components/ExpenseModal";
import { ProfitLadder, PlanFactDuel } from "../components/OrderFinance";
import { OrderSummaryStrip } from "../components/order/OrderSummaryStrip";
import { OrderParams } from "../components/order/OrderParams";
import type { OrderFormState } from "../components/order/OrderParams";
import { useNavigationGuard, NavigationGuardModal } from "../components/NavigationGuard";
import { Breadcrumbs } from "../components/ui/Breadcrumbs";

// Заголовок стадии оси: ПЛАН → ФАКТ → ИТОГ.
function StageHeader({ n, title, hint }: { n: string; title: string; hint?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, paddingTop: 20, marginTop: 36, borderTop: "2px solid #1A1A1A" }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "#E8592A", fontFamily: MONO }}>{n}</span>
      <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", color: "#1A1A1A" }}>{title}</span>
      {hint && <span style={{ fontSize: 10, color: "#A89070" }}>{hint}</span>}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>{children}</div>;
}

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState<OrderFormState | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const blocker = useNavigationGuard(isDirty);

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

  // ── Утверждение сметы (актуализация) ───────────────────────────────────
  const [approveError, setApproveError] = useState("");
  const approveSet = useMutation({
    mutationFn: (setId: string) => estimatesApi.approveSet(setId),
    onSuccess: () => {
      setApproveError("");
      invalidateFact();
      qc.invalidateQueries({ queryKey: ["order-estimates", id] });
      qc.invalidateQueries({ queryKey: ["estimates-review-queue"] });
    },
    onError: (e: any) => setApproveError(e?.response?.data?.detail || "Не удалось утвердить смету"),
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

  const field = (f: Partial<OrderFormState>) => { setForm(prev => prev ? { ...prev, ...f } : prev); setIsDirty(true); };

  const paidTotal = order?.payments?.reduce((s: number, p: any) => s + p.amount, 0) ?? 0;
  // Активный черновик (план считается по нему): последний не-superseded draft.
  const activeDraft = order?.plan_source === "draft"
    ? [...(estimates as any[])].reverse().find((s: any) => s.status === "draft")
    : null;

  if (isLoading || !form) {
    return <Loading />;
  }

  return (
    <>
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>

      {/* Top bar */}
      <div style={{ padding: "16px 28px", borderBottom: "1px solid #EDEBE6", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {/* Крошки: Заказы › {название} · номер — выход всегда одной кнопкой */}
        <Breadcrumbs
          items={[{ label: "Заказы", to: "/orders" }, { label: order?.title || "…" }]}
          tail={<span style={{ fontSize: 10, color: "#C8C0B0", fontFamily: MONO }}>{order?.number}</span>}
        />
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
          <Button variant="primary" onClick={handleSave} disabled={saveMutation.isPending} style={{ fontSize: 12 }}>
            {saveMutation.isPending ? "Сохраняем..." : "Сохранить"}
          </Button>
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
              : `Удалить расход «${delExpense.title}» на ${fmtMoney(delExpense.amount)}? Факт и маржа пересчитаются.`}
            confirmLabel={removeExpense.isPending ? "Удаляем..." : "Удалить"}
            onConfirm={() => removeExpense.mutate(delExpense)}
            onCancel={() => setDelExpense(null)}
          />
        )}
      </div>

      {/* Scrollable body: слева рабочий поток (ПЛАН → ФАКТ), справа sticky-табло
          (сводка + дуэль план⇄факт + лестница) — фин-картина видна при любом скролле */}
      <div style={{ flex: 1, overflow: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(460px, 1fr) minmax(330px, 400px)", gap: 48, alignItems: "start", maxWidth: 1400, padding: "28px 36px 48px" }}>
        <div style={{ minWidth: 0 }}>

          {/* Editable title */}
          <input
            value={form.title}
            onChange={e => field({ title: e.target.value })}
            onKeyDown={e => e.key === "Enter" && handleSave()}
            style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", color: "#1A1A1A", border: "none", borderBottom: "2px solid transparent", outline: "none", background: "transparent", width: "100%", padding: "0 0 4px", fontFamily: "inherit", marginBottom: 20, boxSizing: "border-box" }}
            onFocus={e => (e.currentTarget.style.borderBottomColor = "#EDEBE6")}
            onBlur={e => (e.currentTarget.style.borderBottomColor = "transparent")}
          />

          {/* Параметры (статус/бренд/клиент/дедлайн) — под катом; сводка деньгами — в табло справа */}
          <OrderParams order={order} form={form} field={field} customers={customers as any[]} />

          {/* ═══ СТАДИЯ 1: ПЛАН ═══ */}
          <StageHeader n="01" title="ПЛАН" hint="смета и обещания клиенту" />

          {/* Сметы */}
          <div style={{ paddingTop: 18, marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <SectionLabel>СМЕТЫ</SectionLabel>
              <Button size="sm" onClick={() => addEstimateMutation.mutate()} disabled={addEstimateMutation.isPending} style={{ fontSize: 11 }}>
                <Plus size={11} /> Новая смета
              </Button>
            </div>
            {approveError && (
              <div style={{ fontSize: 11, color: "#8B3A3A", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                <Warning size={12} /> {approveError}
              </div>
            )}
            {(estimates as any[]).length === 0 ? (
              <div style={{ fontSize: 12, color: "#C8C0B0", padding: "8px 0" }}>Сметы не добавлены</div>
            ) : (
              (estimates as any[]).map((s: any, i: number) => {
                // Эндпоинт отдаёт сметы с позициями, но без агрегата по сете —
                // суммируем из items. Клиентская цена для безнала = sale × (1+bank%),
                // та же формула, что set_totals на бэке и редактор сметы.
                const items = s.items ?? [];
                const isBank = s.payment_type === "bank";
                const bpct = s.bank_pct ?? 13;
                const cost = items.reduce((a: number, it: any) => a + (it.cost_total || 0), 0);
                const sale = items.reduce((a: number, it: any) => a + (isBank ? Math.round((it.sale_price || 0) * (1 + (it.bank_pct ?? bpct) / 100)) : (it.sale_price || 0)), 0);
                const delta = sale - cost;
                const st = ESTIMATE_STATUS[s.status];
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
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, padding: "12px 10px", borderBottom: "1px solid #F2EFE9", cursor: "pointer", opacity: s.status === "superseded" ? 0.55 : 1 }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
                  onMouseLeave={e => (e.currentTarget.style.background = "")}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A" }}>
                      {s.name || `Смета ${i + 1}`}
                    </span>
                    <span style={{ fontSize: 10, color: st?.color ?? "#A89070", fontWeight: 500 }}>
                      {st?.label ?? s.status}
                    </span>
                    {s.status === "draft" && (
                      <Button size="sm" variant="primary" disabled={approveSet.isPending}
                        onClick={e => { e.stopPropagation(); approveSet.mutate(s.id); }}
                        style={{ fontSize: 10, padding: "3px 10px" }}>
                        {approveSet.isPending ? "..." : "Утвердить"}
                      </Button>
                    )}
                  </div>
                  {metric("СЕБЕСТ.", fmtMoney(cost), "#6B6355")}
                  {metric("ПРОДАЖА", fmtMoney(sale), "#1A1A1A")}
                  {metric("Δ", delta === 0 ? "—" : (delta > 0 ? "+" : "") + fmtMoney(delta), delta >= 0 ? "#4A7C59" : "#8B3A3A")}
                  <CaretRight size={13} style={{ color: "#C8C0B0", flexShrink: 0 }} />
                </div>
                );
              })
            )}
          </div>

          {/* Резерв под материалы */}
          {order && (
            <div style={{ paddingTop: 18, marginBottom: 8 }}>
              <div style={{ marginBottom: 12 }}><SectionLabel>РЕЗЕРВ ПОД МАТЕРИАЛЫ</SectionLabel></div>
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
                      <Button variant="primary" size="sm" onClick={() => setReserve.mutate(parseFloat(reserveEdit) || 0)} disabled={setReserve.isPending} style={{ fontSize: 12, padding: "7px 16px" }}>
                        {setReserve.isPending ? "..." : "Отложить"}
                      </Button>
                      <Button size="sm" onClick={() => setReserveEdit(null)} style={{ fontSize: 12, color: "#A89070" }}>Отмена</Button>
                    </div>
                  );
                }

                if (active) {
                  return (
                    <div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        <span style={{ fontSize: 15, fontWeight: 700, color: "#E8592A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(order.reserved_amount)}</span>
                        <span style={{ fontSize: 11, color: "#A89070" }}>отложено под закупку — тратить нельзя</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                        <button onClick={() => releaseReserve.mutate()} disabled={releaseReserve.isPending}
                          style={{ padding: "6px 14px", border: "1px solid #4A7C59", background: "none", color: "#4A7C59", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                          {releaseReserve.isPending ? "..." : "Материалы закуплены — снять резерв"}
                        </button>
                        <Button size="sm" onClick={() => setReserveEdit(String(order.reserved_amount))} style={{ fontSize: 12, color: "#6B6355" }}>Изменить</Button>
                      </div>
                    </div>
                  );
                }

                if (released) {
                  return (
                    <div>
                      <div style={{ fontSize: 12, color: "#A89070" }}>
                        Резерв снят (закупка проведена) · было {fmtMoney(order.reserved_amount)}
                      </div>
                      <Button size="sm" onClick={() => setReserveEdit(String(suggested))} style={{ marginTop: 10, fontSize: 12, color: "#6B6355" }}>Зарезервировать снова</Button>
                    </div>
                  );
                }

                // Резерва нет
                return (
                  <div>
                    <div style={{ fontSize: 12, color: "#6B6355" }}>
                      {suggested > 0
                        ? <>Себестоимость материалов по смете <b style={{ fontFamily: MONO, color: "#1A1A1A" }}>{fmtMoney(suggested)}</b> — отложить под закупку?</>
                        : <>Резерв под материалы не задан.</>}
                    </div>
                    <Button variant="primary" size="sm" onClick={() => setReserveEdit(String(suggested || ""))} style={{ marginTop: 12, fontSize: 12, padding: "7px 16px" }}>
                      Зарезервировать
                    </Button>
                  </div>
                );
              })()}
            </div>
          )}

          {/* ═══ СТАДИЯ 2: ФАКТ ═══ */}
          <StageHeader n="02" title="ФАКТ" hint="реальные деньги: траты и оплаты" />

          {/* Расходы (факт) */}
          <div style={{ paddingTop: 18, marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <SectionLabel>
                РАСХОДЫ (ФАКТ)
                {expensesData?.total > 0 && (
                  <span style={{ color: "#1A1A1A", marginLeft: 8, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                    {fmtMoney(expensesData.total)}
                  </span>
                )}
              </SectionLabel>
              <Button size="sm" onClick={() => setExpenseModal({ open: true })} style={{ fontSize: 11, color: "#6B6355" }}>
                <Plus size={11} /> Добавить расход
              </Button>
            </div>

            {!expensesData?.items?.length ? (
              <div style={{ fontSize: 12, color: "#C8C0B0" }}>
                Трат не внесено — маржа считается по плану. Списания банка разносятся в «Разноске».
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
                                    fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(e.amount)}</div>
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
                      <span key={k}>{k}: <span style={{ color: "#1A1A1A", fontFamily: MONO }}>{fmtMoney(v)}</span></span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* План/факт по строкам сметы — кто планировался vs кто исполнил */}
          {!!obligationsData?.items?.length && (
            <div style={{ paddingTop: 18, marginBottom: 8 }}>
              <div style={{ marginBottom: 12 }}><SectionLabel>ПЛАН / ФАКТ ПО РАБОТАМ</SectionLabel></div>
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
                      {fmtMoney(o.planned_amount)}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 13, fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: paidColor }}>{fmtMoney(o.paid)}</div>
                      {o.remaining > 0 && o.paid > 0 && (
                        <div style={{ fontSize: 10, color: "#A89070", fontFamily: MONO }}>ост. {fmtMoney(o.remaining)}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Платежи клиента */}
          <div style={{ paddingTop: 18, marginBottom: 8 }}>
            <div style={{ marginBottom: 12 }}><SectionLabel>ПЛАТЕЖИ КЛИЕНТА</SectionLabel></div>
            {!order?.payments?.length ? (
              <div style={{ fontSize: 12, color: "#C8C0B0" }}>
                Платежей нет. Входящие платежи банка разносятся во вкладке «Поступления» Разноски.
              </div>
            ) : (
              order.payments.map((p: any, i: number) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "10px 0", borderBottom: "1px solid #F2EFE9" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#4A7C59", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                      +{fmtMoney(p.amount)}
                      {p.bank_tx_id && <LinkSimple size={10} style={{ color: "#4A7C59", marginLeft: 5 }} />}
                    </div>
                    {p.note && <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>{p.note}</div>}
                  </div>
                  <div style={{ fontSize: 11, color: "#A89070", fontFamily: MONO }}>{fmtDate(p.paid_at)}</div>
                </div>
              ))
            )}
          </div>

        </div>

        {/* ═══ Табло: сводка + дуэль план⇄факт + лестница (sticky) ═══ */}
        <div style={{ position: "sticky", top: 0, minWidth: 0 }}>
          {order && <OrderSummaryStrip order={order} paidTotal={paidTotal} compact />}

          {!order?.plan_fact?.has_estimate ? (
            <div style={{ background: "#FAF8F5", borderLeft: "3px solid #EDEBE6", padding: "16px" }}>
              <div style={{ fontSize: 12, color: "#6B6355", marginBottom: 12, lineHeight: 1.5 }}>
                Табло пока пустое: без сметы не с чем сравнивать факт. Создай смету —
                появится план⇄факт и лестница прибыли.
              </div>
              <Button variant="primary" size="sm" onClick={() => addEstimateMutation.mutate()} disabled={addEstimateMutation.isPending}>
                <Plus size={11} /> Создать смету
              </Button>
            </div>
          ) : (
            <>
              {order?.plan_source === "draft" && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                  background: "#FAF8F5", border: "1px solid #EDEBE6", padding: "10px 14px", marginBottom: 14 }}>
                  <Warning size={13} style={{ color: "#E8592A", flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: "#6B6355", flex: 1, minWidth: 160 }}>
                    План — по <b>неутверждённой</b> смете.
                  </span>
                  {activeDraft && (
                    <Button size="sm" variant="primary" disabled={approveSet.isPending}
                      onClick={() => approveSet.mutate(activeDraft.id)} style={{ fontSize: 11 }}>
                      {approveSet.isPending ? "..." : "Утвердить"}
                    </Button>
                  )}
                </div>
              )}
              <PlanFactDuel planFact={order.plan_fact} />
              <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #EDEBE6" }}>
                <div style={{ marginBottom: 12 }}><SectionLabel>ЛЕСТНИЦА ПРИБЫЛИ</SectionLabel></div>
                <ProfitLadder order={order} paidTotal={paidTotal} />
              </div>
            </>
          )}
        </div>

        </div>
      </div>
    </div>

    <NavigationGuardModal blocker={blocker} />
    </>
  );
}
