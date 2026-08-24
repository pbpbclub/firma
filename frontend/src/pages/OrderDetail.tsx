// Карточка заказа. Ось: сводка деньгами → ПЛАН (смета, резерв) → ФАКТ (расходы,
// платежи, исполнители) → ИТОГ (план-факт и лестница прибыли). Ось видна всегда:
// без сметы — CTA создать, с черновиком — плашка «утверди».
import { useState, useEffect } from "react";
import { MoneyInput, parseMoney } from "../components/ui/MoneyInput";
import { debtColor } from "../components/ui/type";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { MONO } from "../components/ui/Num";
import { Modal, ConfirmModal } from "../components/ui/Modal";
import { Loading } from "../components/ui/Loading";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { fmtMoney, fmtDate } from "../components/ui/format";
import { clientPrice } from "../components/ui/priceMath";
import { ESTIMATE_STATUS } from "../components/domain";
import { ordersApi, customersApi, estimatesApi, expensesApi, paymentsApi } from "../api";
import { Plus, CaretRight, Trash, LinkSimple, PencilSimple, Warning, ArrowsSplit } from "@phosphor-icons/react";
import { ExpenseModal, EXPENSE_CATEGORIES } from "../components/ExpenseModal";
import { ProfitLadder, PlanFactDuel } from "../components/OrderFinance";
import { TransitPanel } from "../components/order/TransitPanel";
import { OrderSummaryStrip } from "../components/order/OrderSummaryStrip";
import { OrderParams } from "../components/order/OrderParams";
import type { OrderFormState } from "../components/order/OrderParams";
import { useNavigationGuard, NavigationGuardModal } from "../components/NavigationGuard";
import { Breadcrumbs } from "../components/ui/Breadcrumbs";

// A1/A2 (ТЗ 24.08.2026): «чем закрыт расход». cash и пустое — обычная оплата,
// бейджа не требует; остальное стоит отметить, иначе строка читается как выплата.
const SETTLED_BADGES: Record<string, { l: string; hint: string }> = {
  advance:     { l: "авансом",  hint: "Закрыто ранее выданным авансом: себестоимость выросла, сальдо подрядчика не двигалось" },
  offset:      { l: "зачётом",  hint: "Взаимозачёт: денег не было, наш долг подрядчику погашен" },
  third_party: { l: "за него",  hint: "Закрыто оплатой, которую мы сделали за него третьему лицу" },
  none:        { l: "не оплачено", hint: "Работа принята, деньги не уходили — долг остаётся" },
};

/** «деньгами 4 000 · зачётом 1 400» — из obligations[].settled. */
function settledSummary(settled?: Record<string, number>): string {
  const labels: Record<string, string> = {
    cash: "деньгами", advance: "авансом", offset: "зачётом",
    third_party: "за него", none: "не оплачено",
  };
  const parts = Object.entries(settled || {}).filter(([, v]) => v > 0);
  // Одна строка «деньгами N» ничего не добавляет к сумме факта рядом — молчим.
  if (parts.length < 2 && parts[0]?.[0] === "cash") return "";
  return parts.map(([k, v]) => `${labels[k] ?? k} ${fmtMoney(v)}`).join(" · ");
}

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

// Детализация расхода: разбить одну привязанную сумму на несколько категорий
// (материалы/работы/доставка/прочее). Сумма частей должна сойтись с исходной.
// Часть может уйти и «мимо заказа»: закупка про запас, собственный образец,
// общехозяйственное (ТЗ stock_and_samples). Тогда она не попадёт в себестоимость
// заказа — живой случай: 11 800 ₽ = 9 500 ₽ работы + 2 300 ₽ логотипы про запас.
const SPLIT_TARGETS = [
  { v: "", l: "в заказ" },
  { v: "stock", l: "запас" },
  { v: "sample", l: "образец" },
  { v: "overhead", l: "общехоз" },
];

// Допработа: что сделали сверх сметы, за сколько и во что обошлось.
/** Платёж клиента вручную. Ключевое поле — «относится к»: без extra_id платёж
 *  ложится в смету, и допработа остаётся с «оплачено 0» при пришедших деньгах. */
function PaymentModal({ extras, debt, saving, onSave, onClose }: {
  extras: any[]; debt: number; saving: boolean;
  onSave: (d: { amount: number; paid_at: string; note: string | null; extra_id: string | null }) => void;
  onClose: () => void;
}) {
  // Остаток долга подставляем сразу: типовое «клиент закрыл остаток» не должно
  // требовать ручного набора цифры, которая выведена на том же экране.
  const [amount, setAmount] = useState(debt > 0 ? String(debt) : "");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [extraId, setExtraId] = useState("");
  const amountNum = parseMoney(amount);
  const valid = !isNaN(amountNum) && amountNum > 0 && !!date;
  const lbl: React.CSSProperties = { fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 5 };
  const inp: React.CSSProperties = { width: "100%", padding: "7px 9px", fontSize: 13, border: "1px solid #EDEBE6",
                                     background: "#fff", color: "#1A1A1A", fontFamily: "inherit", boxSizing: "border-box" };
  return (
    <Modal size="md" eyebrow="ПЛАТЁЖ КЛИЕНТА" onClose={onClose} onCancel={onClose}
      onSave={() => valid && onSave({ amount: amountNum, paid_at: date,
                                      note: note.trim() || null, extra_id: extraId || null })}
      saveLabel="Добавить" saving={saving} canSave={valid}>
      <div style={{ padding: "16px 24px 20px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={lbl}>СУММА ₽</div>
            <MoneyInput style={inp} autoFocus value={amount} onChange={setAmount} />
            {debt > 0 && (
              <div style={{ fontSize: 10, color: "#A89070", marginTop: 4 }}>остаток долга {fmtMoney(debt)}</div>
            )}
          </div>
          <div>
            <div style={lbl}>ДАТА</div>
            <input style={inp} type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
        </div>
        {extras.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={lbl}>ОТНОСИТСЯ К</div>
            <select style={{ ...inp, cursor: "pointer" }} value={extraId} onChange={e => setExtraId(e.target.value)}>
              <option value="">Смета заказа</option>
              {extras.map((x: any) => <option key={x.id} value={x.id}>Доп: {x.title}</option>)}
            </select>
            <div style={{ fontSize: 10, color: "#A89070", marginTop: 5, lineHeight: 1.5 }}>
              Счёт часто общий на смету и доп — тогда деньги заводятся двумя строками, каждая на своё.
            </div>
          </div>
        )}
        <div style={{ marginTop: 14 }}>
          <div style={lbl}>ПРИМЕЧАНИЕ</div>
          <input style={inp} value={note} onChange={e => setNote(e.target.value)} placeholder="например: аванс 50%" />
        </div>
        <div style={{ fontSize: 10, color: "#A89070", marginTop: 12, lineHeight: 1.6 }}>
          Платёж из банка лучше заводить в «Разноске» — там он свяжется с выпиской.
          Эта форма для наличных и для случаев, когда транзакции в банке нет.
        </div>
      </div>
    </Modal>
  );
}

function ExtraModal({ extra, saving, onSave, onClose }: {
  extra?: any; saving: boolean;
  onSave: (d: { title: string; price: number; cost: number; note: string | null; created_at?: string }) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(extra?.title ?? "");
  // Даты у допа не было вовсе — в ленте заказа ему не на что было опереться.
  const [date, setDate] = useState((extra?.created_at ?? new Date().toISOString()).slice(0, 10));
  const [price, setPrice] = useState(extra?.price != null ? String(extra.price) : "");
  const [cost, setCost]   = useState(extra?.cost != null ? String(extra.cost) : "");
  const [note, setNote]   = useState(extra?.note ?? "");
  const priceNum = parseMoney(price) || 0;
  const costNum  = parseMoney(cost) || 0;
  const valid = title.trim().length > 0 && priceNum >= 0 && costNum >= 0;
  const lbl: React.CSSProperties = { fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 5 };
  const inp: React.CSSProperties = { width: "100%", padding: "7px 9px", fontSize: 13, border: "1px solid #EDEBE6",
                                     background: "#fff", color: "#1A1A1A", fontFamily: "inherit", boxSizing: "border-box" };
  return (
    <Modal size="md" eyebrow={extra ? "ДОПРАБОТА · ПРАВКА" : "НОВАЯ ДОПРАБОТА"} onClose={onClose}
      onCancel={onClose}
      onSave={() => valid && onSave({ title: title.trim(), price: priceNum, cost: costNum,
                                     note: note.trim() || null, created_at: date || undefined })}
      saveLabel={extra ? "Сохранить" : "Добавить"} saving={saving} canSave={valid}>
      <div style={{ padding: "16px 24px 20px" }}>
        <div style={lbl}>ЧТО СДЕЛАЛИ</div>
        <input style={inp} autoFocus value={title} onChange={e => setTitle(e.target.value)}
          placeholder="Например: сверление отверстий в скамейках" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
          <div>
            <div style={lbl}>ЦЕНА ДЛЯ ЗАКАЗЧИКА ₽</div>
            <MoneyInput style={inp} value={price} onChange={setPrice} />
          </div>
          <div>
            <div style={lbl}>СЕБЕСТОИМОСТЬ ₽</div>
            <MoneyInput style={inp} value={cost} onChange={setCost} />
          </div>
        </div>
        <div style={{ marginTop: 14, maxWidth: 200 }}>
          <div style={lbl}>КОГДА</div>
          <input style={inp} type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div style={{ marginTop: 14 }}>
          <div style={lbl}>ЗАМЕТКА</div>
          <input style={inp} value={note} onChange={e => setNote(e.target.value)}
            placeholder="Например: забрал с объекта, вернул на следующий день" />
        </div>
        <div style={{ marginTop: 14, fontSize: 11, color: "#6B6355", lineHeight: 1.5 }}>
          Смета не меняется: доп добавляется к цене заказа отдельной строкой, поэтому оплата
          за него не выглядит переплатой. Статус заказа тоже не меняется — доп можно завести
          и по уже завершённому заказу. Расходы по допу отмечаются в форме расхода
          («относится к»), чтобы не портить маржу основного заказа.
        </div>
      </div>
    </Modal>
  );
}

function SplitExpenseModal({ expense, saving, onSave, onClose }: {
  expense: any; saving: boolean;
  onSave: (parts: { amount: number; category: string; title?: string | null; purpose?: string | null }[]) => void;
  onClose: () => void;
}) {
  type Part = { amount: string; category: string; title: string; purpose: string };
  const [parts, setParts] = useState<Part[]>([
    { amount: String(expense.amount ?? ""), category: expense.category || "material", title: "", purpose: "" },
    { amount: "", category: "work", title: "", purpose: "" },
  ]);
  const patch = (i: number, p: Partial<Part>) => setParts(parts.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const sum = parts.reduce((s, p) => s + (parseMoney(p.amount) || 0), 0);
  const diff = Math.round(((expense.amount || 0) - sum) * 100) / 100;
  const valid = parts.length >= 2 && parts.every(p => (parseMoney(p.amount) || 0) > 0) && Math.abs(diff) < 0.01;
  const addPart = () => setParts([...parts, { amount: diff > 0 ? String(diff) : "", category: "other", title: "", purpose: "" }]);
  const outOfOrder = parts.filter(p => p.purpose).reduce((s, p) => s + (parseMoney(p.amount) || 0), 0);
  return (
    <Modal size="lg" eyebrow="ДЕТАЛИЗАЦИЯ РАСХОДА" onClose={onClose}
      onCancel={onClose} onSave={() => valid && onSave(parts.map(p => ({
        amount: parseMoney(p.amount), category: p.category, title: p.title.trim() || null,
        purpose: p.purpose || null,
      })))}
      saveLabel={saving ? "Разбиваем..." : "Разбить"} saving={saving} canSave={valid}>
      <div style={{ padding: "18px 24px" }}>
        <div style={{ fontSize: 12, color: "#6B6355", marginBottom: 14 }}>
          «{expense.title}» — <span style={{ fontFamily: MONO, fontWeight: 600, color: "#1A1A1A" }}>{fmtMoney(expense.amount)}</span>
          <span style={{ color: "#A89070" }}> → на что ушло:</span>
        </div>
        {parts.map((p, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <MoneyInput value={p.amount} onChange={v => patch(i, { amount: v })} placeholder="сумма"
              style={{ width: 110, border: "1px solid #EDEBE6", padding: "6px 8px", fontSize: 12, outline: "none" }} />
            <div style={{ display: "flex" }}>
              {EXPENSE_CATEGORIES.map(c => (
                <button type="button" key={c.v} onClick={() => patch(i, { category: c.v })}
                  style={{ fontSize: 10.5, padding: "6px 10px", cursor: "pointer", fontFamily: "inherit",
                           border: "1px solid #EDEBE6", marginLeft: -1,
                           background: p.category === c.v ? "#1A1A1A" : "#fff",
                           color: p.category === c.v ? "#fff" : "#6B6355" }}>
                  {c.l}
                </button>
              ))}
            </div>
            <select value={p.purpose} onChange={e => patch(i, { purpose: e.target.value })}
              title="Куда отнести часть: в этот заказ или мимо заказов"
              style={{ border: "1px solid #EDEBE6", padding: "6px 6px", fontSize: 11, outline: "none",
                       fontFamily: "inherit", background: p.purpose ? "#FAF8F5" : "#fff",
                       color: p.purpose ? "#E8592A" : "#6B6355", cursor: "pointer" }}>
              {SPLIT_TARGETS.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
            </select>
            <input value={p.title} onChange={e => patch(i, { title: e.target.value })} placeholder="название (опц.)"
              style={{ flex: 1, minWidth: 90, border: "1px solid #EDEBE6", padding: "6px 8px", fontSize: 12, outline: "none" }} />
            {parts.length > 2 && (
              <button type="button" onClick={() => setParts(parts.filter((_, j) => j !== i))}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 3, display: "flex" }}>
                <Trash size={12} />
              </button>
            )}
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
          <button type="button" onClick={addPart}
            style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, padding: "5px 10px",
                     border: "1px solid #EDEBE6", background: "#fff", color: "#6B6355", cursor: "pointer", fontFamily: "inherit" }}>
            <Plus size={11} /> часть
          </button>
          <div style={{ fontSize: 11, fontFamily: MONO, color: Math.abs(diff) < 0.01 ? "#4A7C59" : "#8B3A3A" }}>
            {outOfOrder > 0 && Math.abs(diff) < 0.01 && (
              <span style={{ color: "#A89070", marginRight: 10 }}>
                мимо заказа {fmtMoney(outOfOrder)} →
              </span>
            )}
            {Math.abs(diff) < 0.01 ? `✓ ${fmtMoney(sum)} — сходится` :
              diff > 0 ? `осталось распределить ${fmtMoney(diff)}` :
                         `перебор на ${fmtMoney(Math.abs(diff))}`}
          </div>
        </div>
      </div>
    </Modal>
  );
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
        discount: order.discount ? String(order.discount) : "",
        discount_note: order.discount_note || "",
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

  const [splitExpense, setSplitExpense] = useState<any>(null);
  const doSplit = useMutation({
    mutationFn: (parts: { amount: number; category: string; title?: string | null }[]) =>
      expensesApi.split(id!, splitExpense.id, parts),
    onSuccess: () => { invalidateFact(); setSplitExpense(null); },
  });

  // ── Допработы (ТЗ extra_works 01.08.2026) ──────────────────────────────
  // Работы сверх утверждённой сметы: заводятся в любой момент, в том числе по
  // завершённому заказу. Смета при этом не переписывается — цена заказа
  // считается как «смета + допы» (бэкенд, _margin).
  const [extraModal, setExtraModal] = useState<{ open: boolean; item?: any } | null>(null);
  const [delExtra, setDelExtra] = useState<any>(null);
  const extras: any[] = order?.extras ?? [];

  const saveExtra = useMutation({
    mutationFn: (d: any) => extraModal?.item
      ? ordersApi.updateExtra(id!, extraModal.item.id, d)
      : ordersApi.addExtra(id!, d),
    onSuccess: () => { invalidateFact(); setExtraModal(null); },
  });
  const removeExtra = useMutation({
    mutationFn: (x: any) => ordersApi.deleteExtra(id!, x.id),
    onSuccess: () => { invalidateFact(); setDelExtra(null); },
  });

  // ── Платежи клиента ────────────────────────────────────────────────────
  // До 24.08.2026 блок был read-only, и extra_id платежа заполнить было нечем:
  // «оплачено» у допработы всегда показывало 0, хотя деньги приходили (счёт
  // 081-Н/26, 8 000 ₽ за двойную печать). Бэк принимал поле с самого начала.
  const [payModal, setPayModal] = useState<boolean>(false);
  const [delPayment, setDelPayment] = useState<any>(null);

  const savePayment = useMutation({
    mutationFn: (d: any) => ordersApi.addPayment(id!, d),
    onSuccess: () => { invalidateFact(); setPayModal(false); },
  });
  const removePayment = useMutation({
    // Разнесённое поступление откатываем группой — транзакция вернётся в инбокс
    // «Разноски», как это делает откат расхода (expensesApi.delete с group).
    mutationFn: (p: any) => p.group_id && p.siblings?.length
      ? paymentsApi.deleteGroup(p.group_id)
      : ordersApi.deletePayment(id!, p.id),
    onSuccess: () => { invalidateFact(); setDelPayment(null); },
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
  // Смена статуса из баннеров «ждёт оплаты» / «оплата пришла». Оба перехода —
  // только по клику Юры: система подсказывает, но не переводит сама.
  const setStatusMutation = useMutation({
    mutationFn: (st: string) => ordersApi.updateStatus(id!, st),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["order-detail", id] }); qc.invalidateQueries({ queryKey: ["orders-v2"] }); },
  });

  // Основная смета — ручной выбор Юры: остальные варианты остаются живыми черновиками
  const setPrimary = useMutation({
    mutationFn: (setId: string) => estimatesApi.setPrimary(setId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["order-detail", id] }); qc.invalidateQueries({ queryKey: ["order-estimates", id] }); },
  });
  const unsetPrimary = useMutation({
    mutationFn: (setId: string) => estimatesApi.unsetPrimary(setId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["order-detail", id] }); qc.invalidateQueries({ queryKey: ["order-estimates", id] }); },
  });

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
      discount: parseFloat(form.discount) || 0,
      discount_note: form.discount_note || null,
      customer_id: form.customer_id && form.customer_id !== "__new__" ? form.customer_id : null,
    });
  };

  const field = (f: Partial<OrderFormState>) => { setForm(prev => prev ? { ...prev, ...f } : prev); setIsDirty(true); };

  const paidTotal = order?.payments?.reduce((s: number, p: any) => s + p.amount, 0) ?? 0;
  // Активный черновик (план считается по нему): помеченный основным, иначе последний
  // не-superseded draft. Тот же порядок, что у _active_set на бэке.
  const drafts = (estimates as any[]).filter((s: any) => s.status === "draft");
  const activeDraft = order?.plan_source === "draft"
    ? (drafts.find((s: any) => s.is_primary) ?? [...drafts].reverse()[0] ?? null)
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
          <button type="button"
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
            existingExpenses={expensesData?.items ?? []}
            extras={extras}
            saving={saveExpense.isPending}
            onSave={(d) => saveExpense.mutate(d)}
            onClose={() => setExpenseModal(null)}
          />
        )}

        {/* Допработа: создание / правка */}
        {extraModal?.open && (
          <ExtraModal
            extra={extraModal.item}
            saving={saveExtra.isPending}
            onSave={(d) => saveExtra.mutate(d)}
            onClose={() => setExtraModal(null)}
          />
        )}

        {delExtra && (
          <ConfirmModal
            message={`Удалить допработу «${delExtra.title}»? Платежи и расходы останутся — с них снимется привязка к допу.`}
            confirmLabel={removeExtra.isPending ? "Удаляем..." : "Удалить"}
            onConfirm={() => removeExtra.mutate(delExtra)}
            onCancel={() => setDelExtra(null)}
          />
        )}

        {payModal && (
          <PaymentModal
            extras={extras}
            debt={order?.debt ?? 0}
            saving={savePayment.isPending}
            onSave={(d) => savePayment.mutate(d)}
            onClose={() => setPayModal(false)}
          />
        )}

        {delPayment && (
          <ConfirmModal
            message={delPayment.siblings?.length
              ? `Этой же транзакцией оплачены другие заказы (${delPayment.siblings.map((x: any) => x.title).join(", ")}). Разноска откатится целиком, транзакция вернётся в «Разноску».`
              : `Удалить платёж ${fmtMoney(delPayment.amount)}?`}
            confirmLabel={removePayment.isPending ? "Удаляем..."
              : delPayment.siblings?.length ? "Откатить разноску" : "Удалить"}
            onConfirm={() => removePayment.mutate(delPayment)}
            onCancel={() => setDelPayment(null)}
          />
        )}

        {/* Детализация расхода: разбить сумму на категории */}
        {splitExpense && (
          <SplitExpenseModal
            expense={splitExpense}
            saving={doSplit.isPending}
            onSave={(parts) => doSplit.mutate(parts)}
            onClose={() => setSplitExpense(null)}
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
          <OrderParams order={order} form={form} field={field} customers={customers as any[]}
            onStatusChanged={(st) => {
              // Статус уже записан пилюлей (PATCH) — форму синхронизируем БЕЗ isDirty,
              // иначе NavigationGuard посчитает страницу несохранённой.
              setForm(prev => prev ? { ...prev, status: st } : prev);
              qc.invalidateQueries({ queryKey: ["order-detail", id] });
              qc.invalidateQueries({ queryKey: ["orders-v2"] });
            }} />

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
                const sale = items.reduce((a: number, it: any) => a + clientPrice(it.sale_price || 0, isBank, bpct), 0);
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
                      {s.title || `Смета ${i + 1}`}
                    </span>
                    <span style={{ fontSize: 10, color: st?.color ?? "#A89070", fontWeight: 500 }}>
                      {st?.label ?? s.status}
                    </span>
                    {!!s.is_primary && s.status !== "approved" && (
                      <span title="Показывать эту смету как основную — план заказа считается по ней"
                        style={{ fontSize: 9, letterSpacing: "0.06em", color: "#E8592A", border: "1px solid #E8592A", padding: "2px 6px", whiteSpace: "nowrap" }}>
                        ОСНОВНАЯ
                      </span>
                    )}
                    {s.status === "draft" && !s.is_primary && (estimates as any[]).length > 1 && (
                      <Button size="sm" variant="ghost" disabled={setPrimary.isPending}
                        onClick={e => { e.stopPropagation(); setPrimary.mutate(s.id); }}
                        style={{ fontSize: 10, padding: "3px 10px" }}>
                        Сделать основной
                      </Button>
                    )}
                    {!!s.is_primary && s.status === "draft" && (
                      <Button size="sm" variant="ghost" disabled={unsetPrimary.isPending}
                        onClick={e => { e.stopPropagation(); unsetPrimary.mutate(s.id); }}
                        style={{ fontSize: 10, padding: "3px 10px", color: "#A89070" }}>
                        Снять
                      </Button>
                    )}
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

          {/* Резерв под материалы. У транзита материалов нет: себестоимость — это
              выплата контрагенту, откладывать «под закупку» нечего. */}
          {order && !order.transit && (
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
                        <button type="button" onClick={() => releaseReserve.mutate()} disabled={releaseReserve.isPending}
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

          {/* Допработы — сверх утверждённой сметы. Не версия сметы: смета остаётся
              нетронутой, а цена заказа = смета + допы (ТЗ extra_works 01.08.2026). */}
          <div style={{ paddingTop: 18, marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <SectionLabel>
                ДОПРАБОТЫ
                {extras.length > 0 && (
                  <span style={{ color: "#1A1A1A", marginLeft: 8, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                    {fmtMoney(order?.extras_total?.price ?? 0)}
                  </span>
                )}
              </SectionLabel>
              <Button size="sm" onClick={() => setExtraModal({ open: true })} style={{ fontSize: 11, color: "#6B6355" }}>
                <Plus size={11} /> Добавить доп
              </Button>
            </div>

            {!extras.length ? (
              <div style={{ fontSize: 12, color: "#C8C0B0" }}>
                Допов нет. Доработка сверх сметы (доделали после сдачи) заводится сюда — смета не переписывается.
              </div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 96px 96px 96px 30px", gap: 10,
                              fontSize: 9, color: "#A89070", letterSpacing: "0.05em", paddingBottom: 6, borderBottom: "1px solid #EDEBE6" }}>
                  <div>ЧТО · КОГДА</div>
                  <div style={{ textAlign: "right" }}>ЦЕНА</div>
                  <div style={{ textAlign: "right" }}>СЕБЕСТ.</div>
                  <div style={{ textAlign: "right" }}>МАРЖА</div>
                  <div />
                </div>
                {extras.map((x: any) => (
                  <div key={x.id} style={{ display: "grid", gridTemplateColumns: "1fr 96px 96px 96px 30px", gap: 10,
                                           alignItems: "center", padding: "9px 0", borderBottom: "1px solid #F2EFE9" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {x.title}
                      </div>
                      <div style={{ fontSize: 10, color: "#A89070", marginTop: 2 }}>
                        {fmtDate(x.created_at)}
                        {x.note && <> · {x.note}</>}
                        {" · "}
                        {/* Красили сумму оплаты цветом ОСТАТКА — разводим: оплата
                            нейтральна, а неоплаченный остаток это дебиторка (зелёная). */}
                        оплачено <span style={{ fontFamily: MONO }}>{fmtMoney(x.paid)}</span>
                        {x.rest > 0 && <> · остаток <span style={{ fontFamily: MONO, color: debtColor(x.rest, "in") }}>{fmtMoney(x.rest)}</span></>}
                        {x.cost_fact > 0 && <> · факт затрат <span style={{ fontFamily: MONO }}>{fmtMoney(x.cost_fact)}</span></>}
                      </div>
                    </div>
                    <div style={{ fontSize: 13, textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(x.price)}</div>
                    <div style={{ fontSize: 13, textAlign: "right", color: "#6B6355", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                      {fmtMoney(Math.max(x.cost || 0, x.cost_fact || 0))}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums",
                                  color: x.gross >= 0 ? "#4A7C59" : "#8B3A3A" }}>{fmtMoney(x.gross)}</div>
                    <div style={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
                      <button type="button" onClick={() => setExtraModal({ open: true, item: x })}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 3, display: "flex" }}
                        onMouseEnter={ev => (ev.currentTarget.style.color = "#1A1A1A")}
                        onMouseLeave={ev => (ev.currentTarget.style.color = "#C8C0B0")}>
                        <PencilSimple size={13} />
                      </button>
                      <button type="button" onClick={() => setDelExtra(x)}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 3, display: "flex" }}
                        onMouseEnter={ev => (ev.currentTarget.style.color = "#8B3A3A")}
                        onMouseLeave={ev => (ev.currentTarget.style.color = "#C8C0B0")}>
                        <Trash size={13} />
                      </button>
                    </div>
                  </div>
                ))}
                <div style={{ fontSize: 10, color: "#A89070", marginTop: 8 }}>
                  Цена заказа = смета + допы, поэтому оплата допа не выглядит переплатой.
                </div>
              </>
            )}
          </div>

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
                      style={{ display: "grid", gridTemplateColumns: "78px 1fr 96px 110px 74px",
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
                          {/* A1: расход, закрытый не новыми деньгами. Себестоимость
                              заказа он поднял, а лицевой счёт подрядчика не двигал. */}
                          {SETTLED_BADGES[e.settled_by as string] && (
                            <span title={SETTLED_BADGES[e.settled_by as string].hint}
                              style={{ fontSize: 9, color: "#6B6355", background: "#F2EFE9", padding: "1px 5px", marginLeft: 5 }}>
                              {SETTLED_BADGES[e.settled_by as string].l}
                            </span>
                          )}
                          {e.payment_source === "cash_fund" && (
                            <span title="Оплачено наличными из кассы"
                              style={{ fontSize: 9, color: "#A89070", background: "#F2EFE9", padding: "1px 5px", marginLeft: 5 }}>нал</span>
                          )}
                          {e.payment_source === "accountable" && (
                            <span title="Оплачено подотчётным лицом"
                              style={{ fontSize: 9, color: "#A89070", background: "#F2EFE9", padding: "1px 5px", marginLeft: 5 }}>под отчёт</span>
                          )}
                        </div>
                        {e.supplier && <div style={{ fontSize: 10, color: "#A89070", marginTop: 1 }}>{e.supplier}</div>}
                      </div>
                      <div style={{ fontSize: 10, color: "#6B6355" }}>{cat?.l ?? e.category}</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#8B3A3A", textAlign: "right",
                                    fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(e.amount)}</div>
                      <div style={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
                        <button type="button" onClick={() => setExpenseModal({ open: true, item: e })}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 3, display: "flex" }}
                          onMouseEnter={ev => (ev.currentTarget.style.color = "#1A1A1A")}
                          onMouseLeave={ev => (ev.currentTarget.style.color = "#C8C0B0")}>
                          <PencilSimple size={13} />
                        </button>
                        <button type="button" onClick={() => setSplitExpense(e)}
                          title="Детализировать: разбить на категории (материалы/работы/…)"
                          style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 3, display: "flex" }}
                          onMouseEnter={ev => (ev.currentTarget.style.color = "#E8592A")}
                          onMouseLeave={ev => (ev.currentTarget.style.color = "#C8C0B0")}>
                          <ArrowsSplit size={13} />
                        </button>
                        <button type="button" onClick={() => setDelExpense(e)}
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
                      {/* A2 п.3: чем закрыто — деньгами, зачётом, авансом, оплатой за
                          него. Одно обязательство закрывается несколькими способами. */}
                      {settledSummary(o.settled) && (
                        <div style={{ fontSize: 10, color: "#6B6355", marginTop: 1 }}>{settledSummary(o.settled)}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Платежи клиента */}
          <div style={{ paddingTop: 18, marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <SectionLabel>ПЛАТЕЖИ КЛИЕНТА</SectionLabel>
              <Button size="sm" onClick={() => setPayModal(true)} style={{ fontSize: 12, color: "#6B6355" }}>
                <Plus size={11} /> Платёж
              </Button>
            </div>
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
                      {p.extra_id && (
                        <span title="Оплата допработы, а не сметы"
                          style={{ fontSize: 9, color: "#A89070", background: "#F2EFE9", padding: "1px 5px", marginLeft: 5 }}>доп</span>
                      )}
                    </div>
                    {p.note && <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>{p.note}</div>}
                    {/* A3-лайт: этой же транзакцией банка оплачены другие заказы */}
                    {p.siblings?.length > 0 && (
                      <div style={{ fontSize: 10, color: "#B8860B", marginTop: 3 }}>
                        этой же транзакцией: {p.siblings.map((s: any) => `${s.title} (${fmtMoney(s.amount)})`).join(", ")}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 11, color: "#A89070", fontFamily: MONO }}>{fmtDate(p.paid_at)}</span>
                    <IconButton icon={Trash} iconSize={13} title={p.siblings?.length
                      ? "Откатить разноску этой транзакции целиком"
                      : "Удалить платёж"} tone="danger" onClick={() => setDelPayment(p)} />
                  </div>
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
              {/* Подсказка: счёт/цена есть, оплат нет — похоже, заказчик тянет.
                  Статус НЕ ставим сами — только предлагаем (решение Юры 28.07.2026). */}
              {order?.awaiting_hint && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                  background: "#FAF8F5", border: "1px solid #EDEBE6", padding: "10px 14px", marginBottom: 14 }}>
                  <Warning size={13} style={{ color: "#B8860B", flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: "#6B6355", flex: 1, minWidth: 160 }}>
                    Счёт есть, оплат нет — похоже, заказ <b>ждёт оплаты</b>.
                  </span>
                  <Button size="sm" disabled={setStatusMutation.isPending}
                    onClick={() => setStatusMutation.mutate("awaiting_payment")} style={{ fontSize: 11 }}>
                    {setStatusMutation.isPending ? "..." : "Пометить «Ждёт оплаты»"}
                  </Button>
                </div>
              )}
              {/* Оплата по «ждущему» пришла — сигнал, не автопереход: частичная
                  предоплата ещё не значит, что работа началась. */}
              {order?.awaiting_paid_signal && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                  background: "#F3F7F4", border: "1px solid #DCE8DF", padding: "10px 14px", marginBottom: 14 }}>
                  <Warning size={13} style={{ color: "#4A7C59", flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: "#6B6355", flex: 1, minWidth: 160 }}>
                    <b>Оплата пришла</b> ({fmtMoney(paidTotal)}) — запускаем в производство?
                  </span>
                  <Button size="sm" variant="primary" disabled={setStatusMutation.isPending}
                    onClick={() => setStatusMutation.mutate("in_production")} style={{ fontSize: 11 }}>
                    {setStatusMutation.isPending ? "..." : "В производство"}
                  </Button>
                </div>
              )}
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
              {/* У транзита разбивки по материалам/работам нет — себестоимость это
                  выплата контрагенту, поэтому дуэль по категориям заменяется своим блоком */}
              {order.transit
                ? <TransitPanel transit={order.transit} tax={order.tax}
                    taxPct={order.tax_pct} netProfit={order.net_profit} />
                : <PlanFactDuel planFact={order.plan_fact} />}
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
