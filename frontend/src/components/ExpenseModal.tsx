import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "./ui/Modal";
import { MONO } from "./ui/Num";
import { mastersApi, financeApi } from "../api";

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

export function ExpenseModal({ orderId, expense, onSave, onClose, saving }: {
  orderId: string;
  expense?: any;               // если передан — режим правки
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

  const { data: masters = [] } = useQuery({ queryKey: ["masters"], queryFn: mastersApi.list });
  // Обязательства этого заказа — чтобы поймать двойной счёт до того, как он случится.
  const { data: creditors = [] } = useQuery({ queryKey: ["creditors"], queryFn: () => financeApi.creditors() });

  const master = (masters as any[]).find((m: any) => m.id === masterId);
  const supplier = master?.name ?? expense?.supplier ?? null;

  // Незакрытое обязательство того же заказа с тем же подрядчиком — вероятно, это оно и есть.
  const candidate = (creditors as any[]).find((c: any) =>
    c.order_id && String(c.order_id) === String(orderId) && supplier && c.name === supplier
  );

  const amountNum = parseFloat(amount);
  const valid = title.trim().length > 0 && !isNaN(amountNum) && amountNum > 0;

  const submit = () => {
    if (!valid) return;
    onSave({
      title: title.trim(),
      amount: amountNum,
      category,
      supplier,
      master_id: masterId || null,
      expense_date: date || null,
      creditor_id: creditorId,
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
          <div style={lbl}>ПОДРЯДЧИК / ПОСТАВЩИК</div>
          <select style={{ ...inp, cursor: "pointer" }} value={masterId} onChange={e => setMasterId(e.target.value)}>
            <option value="">— не указан —</option>
            {(masters as any[]).map((m: any) => (
              <option key={m.id} value={m.id}>{m.name}{m.specialization ? ` · ${m.specialization}` : ""}</option>
            ))}
          </select>
        </div>

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
