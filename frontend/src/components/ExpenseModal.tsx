import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "./ui/Modal";
import { MONO } from "./ui/Num";
import { mastersApi, financeApi, accountableApi } from "../api";

// Источник оплаты (наличный контур): безнал — как раньше; касса — спишется из
// фонда «Касса (наличные)»; подотчётник — оплатило доверенное лицо из выданных
// под отчёт денег (его баланс «на руках» уменьшится).
const PAYMENT_SOURCES = [
  { v: "",            l: "Безнал" },
  { v: "cash_fund",   l: "Наличные (касса)" },
  { v: "accountable", l: "Через подотчётника" },
];

// 4 корзины план-факта. Свободный ввод запрещён: категория вне списка молча
// уедет в «Прочее» (backend _bucket тотальная) и потеряется в разбивке.
export const EXPENSE_CATEGORIES = [
  { v: "material", l: "Материалы" },
  { v: "work",     l: "Работы" },
  { v: "delivery", l: "Доставка" },
  { v: "other",    l: "Прочее" },
];

const lbl: React.CSSProperties = { fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 };
const inp: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6",
  padding: "7px 10px", fontSize: 12, outline: "none", background: "transparent", color: "#1A1A1A",
};

export function ExpenseModal({ orderId, expense, existingExpenses = [], onSave, onClose, saving }: {
  orderId: string;
  expense?: any;               // если передан — режим правки
  existingExpenses?: any[];    // траты заказа — для предупреждения о дубле
  onSave: (data: any) => void;
  onClose: () => void;
  saving?: boolean;
}) {
  const [title, setTitle]       = useState(expense?.title ?? "");
  const [amount, setAmount]     = useState(expense?.amount != null ? String(expense.amount) : "");
  const [category, setCategory] = useState(expense?.category ?? "material");
  const [masterId, setMasterId] = useState(expense?.master_id ?? "");
  const [date, setDate]         = useState(expense?.expense_date ?? new Date().toISOString().slice(0, 10));
  const [creditorId, setCreditorId] = useState<string | null>(expense?.creditor_id ?? null);
  const [paySource, setPaySource] = useState(expense?.payment_source ?? "");
  const [accountableId, setAccountableId] = useState(expense?.accountable_person_id ?? "");
  const [dupConfirmed, setDupConfirmed] = useState(false);

  const { data: masters = [] } = useQuery({ queryKey: ["masters"], queryFn: mastersApi.list });
  const { data: accountables = [] } = useQuery({ queryKey: ["accountable"], queryFn: accountableApi.list });
  // Обязательства этого заказа — чтобы поймать двойной счёт до того, как он случится.
  // Эндпоинт отдаёт обёртку {items, total_*} — разворачиваем сразу, иначе .find по
  // объекту роняет рендер («Добавить расход» падал в ErrorBoundary).
  const { data: creditors = [] } = useQuery({
    queryKey: ["creditors"],
    queryFn: () => financeApi.creditors().then((r: any) => r?.items ?? r ?? []),
  });

  const master = (masters as any[]).find((m: any) => m.id === masterId);
  const supplier = master?.name ?? expense?.supplier ?? null;

  // Незакрытое обязательство того же заказа с тем же подрядчиком — вероятно, это оно и есть.
  const candidate = (creditors as any[]).find((c: any) =>
    c.order_id && String(c.order_id) === String(orderId) && supplier && c.name === supplier
  );

  const amountNum = parseFloat(amount);
  const valid = title.trim().length > 0 && !isNaN(amountNum) && amountNum > 0
    && (paySource !== "accountable" || !!accountableId);

  // Похоже на дубль: та же сумма (±1 ₽) и тот же поставщик/название, дата ±3 дня.
  const dupCandidate = !expense && valid ? (existingExpenses as any[]).find((e: any) => {
    if (Math.abs((e.amount || 0) - amountNum) > 1) return false;
    const sameWho = (supplier && e.supplier === supplier) || (e.title || "").trim() === title.trim();
    if (!sameWho) return false;
    const d1 = new Date(e.expense_date || 0).getTime(), d2 = new Date(date || 0).getTime();
    return Math.abs(d1 - d2) <= 3 * 86400_000;
  }) : null;

  const submit = () => {
    if (!valid) return;
    if (dupCandidate && !dupConfirmed) { setDupConfirmed(true); return; }
    onSave({
      title: title.trim(),
      amount: amountNum,
      category,
      supplier,
      master_id: masterId || null,
      expense_date: date || null,
      creditor_id: creditorId,
      payment_source: paySource || null,
      accountable_person_id: paySource === "accountable" ? accountableId : null,
    });
  };

  return (
    <Modal
      size="md"
      eyebrow={expense ? "РАСХОД · ПРАВКА" : "НОВЫЙ РАСХОД"}
      onClose={onClose}
      onCancel={onClose}
      onSave={submit}
      canSave={valid}
      saving={saving}
      saveLabel={expense ? "Сохранить" : "Добавить"}
    >
      <div style={{ padding: "16px 24px 20px" }}>

        <div style={lbl}>НАЗВАНИЕ</div>
        <input style={inp} autoFocus value={title} onChange={e => setTitle(e.target.value)}
          placeholder="Например: Плазменная резка столешниц" />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
          <div>
            <div style={lbl}>СУММА ₽</div>
            <input style={{ ...inp, fontFamily: MONO, fontVariantNumeric: "tabular-nums", textAlign: "right" }}
              type="number" min="0" step="0.01" value={amount}
              onChange={e => setAmount(e.target.value)} placeholder="0" />
          </div>
          <div>
            <div style={lbl}>ДАТА</div>
            <input style={{ ...inp, fontFamily: MONO }} type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={lbl}>КАТЕГОРИЯ</div>
          <div style={{ display: "flex" }}>
            {EXPENSE_CATEGORIES.map(c => (
              <button key={c.v} onClick={() => setCategory(c.v)}
                style={{
                  padding: "5px 12px", fontSize: 11, cursor: "pointer", border: "1px solid",
                  borderColor: category === c.v ? "#1A1A1A" : "#EDEBE6",
                  background: category === c.v ? "#1A1A1A" : "transparent",
                  color: category === c.v ? "#FFFFFF" : "#A89070",
                  marginRight: -1, fontFamily: "inherit",
                }}>{c.l}</button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={lbl}>ИСТОЧНИК ОПЛАТЫ</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex" }}>
              {PAYMENT_SOURCES.map(p => (
                <button key={p.v} onClick={() => setPaySource(p.v)}
                  style={{
                    padding: "5px 12px", fontSize: 11, cursor: "pointer", border: "1px solid",
                    borderColor: paySource === p.v ? "#1A1A1A" : "#EDEBE6",
                    background: paySource === p.v ? "#1A1A1A" : "transparent",
                    color: paySource === p.v ? "#FFFFFF" : "#A89070",
                    marginRight: -1, fontFamily: "inherit",
                  }}>{p.l}</button>
              ))}
            </div>
            {paySource === "accountable" && (
              <select style={{ ...inp, width: "auto", minWidth: 160, cursor: "pointer" }}
                value={accountableId} onChange={e => setAccountableId(e.target.value)}>
                <option value="">— кто платил —</option>
                {(accountables as any[]).map((a: any) => (
                  <option key={a.id} value={a.id}>{a.name} · на руках {new Intl.NumberFormat("ru-RU").format(a.balance)} ₽</option>
                ))}
              </select>
            )}
          </div>
          {paySource === "cash_fund" && (
            <div style={{ fontSize: 10, color: "#A89070", marginTop: 5 }}>Спишется из кассы наличных — остаток виден в Фондах.</div>
          )}
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={lbl}>ПОДРЯДЧИК / ПОСТАВЩИК</div>
          <select style={{ ...inp, cursor: "pointer" }} value={masterId} onChange={e => setMasterId(e.target.value)}>
            <option value="">— не указан —</option>
            {(masters as any[]).map((m: any) => (
              <option key={m.id} value={m.id}>{m.name}{m.specialization ? ` · ${m.specialization}` : ""}</option>
            ))}
          </select>
        </div>

        {/* Похоже на дубль: уже есть трата с тем же поставщиком/суммой в ±3 дня */}
        {dupCandidate && (
          <div style={{ marginTop: 14, padding: "10px 12px", background: "#FFF4EE", borderLeft: "2px solid #8B3A3A" }}>
            <div style={{ fontSize: 11, color: "#8B3A3A", lineHeight: 1.5 }}>
              Похоже на дубль: «{dupCandidate.title}» на <span style={{ fontFamily: MONO }}>{dupCandidate.amount} ₽</span> от {dupCandidate.expense_date} уже внесён.
              {dupConfirmed ? " Нажми «Добавить» ещё раз, чтобы всё равно сохранить." : ""}
            </div>
          </div>
        )}

        {/* Подсказка про двойной счёт: тот же подрядчик уже висит обязательством по заказу */}
        {candidate && (
          <div style={{ marginTop: 14, padding: "10px 12px", background: "#FFF4EE", borderLeft: "2px solid #E8592A" }}>
            <div style={{ fontSize: 11, color: "#6B6355", lineHeight: 1.5 }}>
              По заказу есть обязательство «{candidate.name}» на{" "}
              <span style={{ fontFamily: MONO }}>{candidate.total} ₽</span>
              {candidate.paid > 0 && <> (оплачено <span style={{ fontFamily: MONO }}>{candidate.paid} ₽</span>)</>}.
              Это оплата по нему?
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, cursor: "pointer", fontSize: 11, color: "#1A1A1A" }}>
              <input type="checkbox" checked={creditorId === candidate.id}
                onChange={e => setCreditorId(e.target.checked ? candidate.id : null)} />
              Да — засчитать один раз, не задваивать факт
            </label>
          </div>
        )}

      </div>
    </Modal>
  );
}
