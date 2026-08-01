/**
 * «Запас и образцы» — траты без заказа (ТЗ stock_and_samples 01.08.2026).
 *
 * Сюда попадает то, что нельзя вешать на клиентский заказ: материалы и заготовки
 * впрок, собственные и тестовые экземпляры, общехозяйственное. Запас потом
 * списывается в конкретный заказ — датой ИСПОЛЬЗОВАНИЯ, а не покупки: тогда
 * себестоимость ложится туда, где материал реально израсходован.
 */
import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Plus, Trash, ArrowRight, PencilSimple } from "@phosphor-icons/react";

import { generalExpensesApi, ordersApi, mastersApi } from "../api";
import { fmtMoney as fmt, fmtDate } from "../components/ui/format";
import { MONO } from "../components/ui/Num";
import { Loading } from "../components/ui/Loading";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";

const PURPOSES = [
  { v: "stock", l: "Запас", hint: "Куплено впрок — ляжет в заказ при списании" },
  { v: "sample", l: "Образцы и тесты", hint: "Свой экземпляр, выставка, проба технологии" },
  { v: "overhead", l: "Общехозяйственные", hint: "К заказам не относится вовсе" },
];
const CATEGORIES = [
  { v: "material", l: "Материалы" },
  { v: "work", l: "Работы" },
  { v: "delivery", l: "Доставка" },
  { v: "other", l: "Прочее" },
];
const today = () => new Date().toISOString().slice(0, 10);

const inputStyle: React.CSSProperties = {
  width: "100%", border: "1px solid #EDEBE6", padding: "7px 10px",
  fontSize: 12, outline: "none", boxSizing: "border-box", fontFamily: "inherit",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.05em", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function Chips({ options, value, onPick }: {
  options: { v: string; l: string; hint?: string }[]; value: string; onPick: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex" }}>
      {options.map(o => (
        <button key={o.v} onClick={() => onPick(o.v)} title={o.hint}
          style={{ fontSize: 11, padding: "7px 12px", cursor: "pointer", fontFamily: "inherit",
                   border: "1px solid #EDEBE6", marginLeft: -1,
                   background: value === o.v ? "#1A1A1A" : "#fff",
                   color: value === o.v ? "#fff" : "#6B6355" }}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

// ── Форма траты без заказа ───────────────────────────────────────────────────

function ExpenseForm({ item, onClose, onDone }: { item: any | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    title: item?.title || "",
    amount: item?.amount != null ? String(item.amount) : "",
    purpose: item?.purpose || "stock",
    category: item?.category || "material",
    supplier: item?.supplier || "",
    master_id: item?.master_id || "",
    expense_date: (item?.expense_date || today()).slice(0, 10),
  });
  const [saving, setSaving] = useState(false);
  const { data: masters = [] } = useQuery({ queryKey: ["masters"], queryFn: () => mastersApi.list() });
  const amount = parseFloat((f.amount || "").replace(/\s/g, "").replace(",", "."));
  const valid = !!f.title.trim() && amount > 0;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      const body = { ...f, amount, master_id: f.master_id || null, supplier: f.supplier || null };
      if (item) await generalExpensesApi.update(item.id, body);
      else await generalExpensesApi.create(body);
      onDone(); onClose();
    } finally { setSaving(false); }
  };

  return (
    <Modal size="sm" eyebrow={item ? "ПРАВКА ТРАТЫ" : "ТРАТА БЕЗ ЗАКАЗА"} onClose={onClose} onCancel={onClose}
      onSave={submit} saveLabel={item ? "Сохранить" : "Записать"} saving={saving} canSave={valid}>
      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="НАЗНАЧЕНИЕ">
          <Chips options={PURPOSES} value={f.purpose} onPick={v => setF({ ...f, purpose: v })} />
        </Field>
        <Field label="ЧТО ИМЕННО">
          <input autoFocus value={f.title} onChange={e => setF({ ...f, title: e.target.value })}
            placeholder="Резка логотипов pbpb" style={inputStyle} />
        </Field>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Field label="СУММА, ₽">
              <input value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} placeholder="0"
                style={{ ...inputStyle, textAlign: "right", fontFamily: MONO, fontWeight: 700, fontSize: 15 }} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="ДАТА">
              <input type="date" value={f.expense_date} onChange={e => setF({ ...f, expense_date: e.target.value })}
                style={inputStyle} />
            </Field>
          </div>
        </div>
        <Field label="КАТЕГОРИЯ">
          <Chips options={CATEGORIES} value={f.category} onPick={v => setF({ ...f, category: v })} />
        </Field>
        <Field label="ИСПОЛНИТЕЛЬ / ПОСТАВЩИК">
          <select value={f.master_id} onChange={e => setF({ ...f, master_id: e.target.value })} style={inputStyle}>
            <option value="">— не указан —</option>
            {(masters as any[]).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// ── Списание запаса в заказ ──────────────────────────────────────────────────

function WriteOffModal({ item, onClose, onDone }: { item: any; onClose: () => void; onDone: () => void }) {
  const [orderId, setOrderId] = useState("");
  const [amount, setAmount] = useState(String(item.amount ?? ""));
  const [date, setDate] = useState(today());
  const [category, setCategory] = useState(item.category || "material");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { data: orders = [] } = useQuery({ queryKey: ["orders", ""], queryFn: () => ordersApi.list({}) });
  const val = parseFloat((amount || "").replace(/\s/g, "").replace(",", "."));
  const valid = !!orderId && val > 0 && val <= (item.amount || 0) + 0.01;

  const submit = async () => {
    if (!valid) return;
    setSaving(true); setError("");
    try {
      await generalExpensesApi.writeOff(item.id, {
        order_id: orderId, amount: val, expense_date: date, category,
      });
      onDone(); onClose();
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Не удалось списать");
    } finally { setSaving(false); }
  };

  return (
    <Modal size="sm" eyebrow="СПИСАТЬ ЗАПАС В ЗАКАЗ" onClose={onClose} onCancel={onClose}
      onSave={submit} saveLabel="Списать" saving={saving} canSave={valid}>
      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 12, color: "#6B6355" }}>
          «{item.title}» — в запасе <span style={{ fontFamily: MONO, fontWeight: 600, color: "#1A1A1A" }}>{fmt(item.amount)}</span>
        </div>
        <Field label="В КАКОЙ ЗАКАЗ">
          <select autoFocus value={orderId} onChange={e => setOrderId(e.target.value)} style={inputStyle}>
            <option value="">— выбери заказ —</option>
            {(orders as any[]).map(o => <option key={o.id} value={o.id}>{o.title}</option>)}
          </select>
        </Field>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Field label="СУММА, ₽">
              <input value={amount} onChange={e => setAmount(e.target.value)}
                style={{ ...inputStyle, textAlign: "right", fontFamily: MONO, fontWeight: 700, fontSize: 15 }} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="ДАТА ИСПОЛЬЗОВАНИЯ">
              <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
            </Field>
          </div>
        </div>
        <Field label="КАТЕГОРИЯ В ЗАКАЗЕ">
          <Chips options={CATEGORIES} value={category} onPick={setCategory} />
        </Field>
        <div style={{ fontSize: 11, color: "#A89070", lineHeight: 1.5 }}>
          Себестоимость ляжет на заказ датой использования. Остаток запаса уменьшится
          на списанную сумму — деньги не задвоятся.
        </div>
        {error && <div style={{ fontSize: 11, color: "#8B3A3A" }}>{error}</div>}
      </div>
    </Modal>
  );
}

// ── Страница ─────────────────────────────────────────────────────────────────

export default function GeneralExpenses() {
  const qc = useQueryClient();
  const [purpose, setPurpose] = useState("");
  const [form, setForm] = useState<{ item: any | null } | null>(null);
  const [writeOff, setWriteOff] = useState<any>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["general-expenses", purpose],
    queryFn: () => generalExpensesApi.list(purpose ? { purpose } : {}),
  });
  const { data: sum } = useQuery({
    queryKey: ["general-expenses-summary"],
    queryFn: () => generalExpensesApi.summary(),
  });
  const del = useMutation({
    mutationFn: (id: string) => generalExpensesApi.delete(id),
    onSuccess: () => refresh(),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["general-expenses"] });
    qc.invalidateQueries({ queryKey: ["general-expenses-summary"] });
    qc.invalidateQueries({ queryKey: ["plan-fact-summary"] });
  };

  const items = (data?.items ?? []) as any[];

  const metrics = [
    { label: "ЗАПАС (НЕ СПИСАНО)", value: sum?.stock_open ?? 0, color: "#1A1A1A" },
    { label: "СПИСАНО В ЗАКАЗЫ", value: sum?.stock_written_off ?? 0, color: "#4A7C59" },
    { label: "ОБРАЗЦЫ И ТЕСТЫ", value: sum?.sample ?? 0, color: "#E8592A" },
    { label: "ОБЩЕХОЗЯЙСТВЕННЫЕ", value: sum?.overhead ?? 0, color: "#6B6355" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "24px 28px 20px", borderBottom: "1px solid #EDEBE6", display: "flex",
                    justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Запас и образцы</div>
          <div style={{ fontSize: 11, color: "#A89070", marginTop: 3 }}>
            Траты вне клиентских заказов — в их себестоимость не входят
          </div>
        </div>
        <button onClick={() => setForm({ item: null })}
          style={{ padding: "7px 14px", background: "#E8592A", border: "none", color: "#FFFFFF", fontSize: 12,
                   fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit" }}>
          <Plus size={12} /> Трата без заказа
        </button>
      </div>

      {/* Сводка — те самые отдельные строки отчёта */}
      <div style={{ display: "flex", borderBottom: "1px solid #EDEBE6", flexShrink: 0 }}>
        {metrics.map(m => (
          <div key={m.label} style={{ flex: 1, padding: "14px 28px", borderRight: "1px solid #F2EFE9" }}>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>{m.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: m.value ? m.color : "#C8C0B0", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
              {fmt(m.value)}
            </div>
          </div>
        ))}
      </div>

      <div style={{ padding: "12px 28px", borderBottom: "1px solid #EDEBE6", display: "flex", gap: 0, flexShrink: 0 }}>
        <Chips options={[{ v: "", l: "Все" }, ...PURPOSES]} value={purpose} onPick={setPurpose} />
      </div>

      {isLoading ? <Loading /> : items.length === 0 ? (
        <EmptyState title="Пока пусто"
          hint="Сюда попадают закупки впрок, собственные образцы и общехозяйственные траты. Часть перевода можно отправить сюда прямо из детализации расхода заказа." />
      ) : (
        <div style={{ flex: 1, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", textAlign: "left" }}>
                <th style={{ padding: "10px 28px", fontWeight: 400 }}>ДАТА</th>
                <th style={{ padding: "10px 8px", fontWeight: 400 }}>ЧТО</th>
                <th style={{ padding: "10px 8px", fontWeight: 400 }}>НАЗНАЧЕНИЕ</th>
                <th style={{ padding: "10px 8px", fontWeight: 400, textAlign: "right" }}>ОСТАТОК</th>
                <th style={{ padding: "10px 8px", fontWeight: 400, textAlign: "right" }}>СПИСАНО</th>
                <th style={{ padding: "10px 28px", fontWeight: 400, textAlign: "right" }}>ДЕЙСТВИЯ</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} style={{ borderTop: "1px solid #F2EFE9", fontSize: 12 }}>
                  <td style={{ padding: "11px 28px", color: "#6B6355", fontFamily: MONO, whiteSpace: "nowrap" }}>
                    {fmtDate(it.expense_date)}
                  </td>
                  <td style={{ padding: "11px 8px", color: "#1A1A1A" }}>
                    {it.title}
                    {(it.master_name || it.supplier) && (
                      <span style={{ color: "#A89070" }}> · {it.master_name || it.supplier}</span>
                    )}
                  </td>
                  <td style={{ padding: "11px 8px", color: "#6B6355" }}>{it.purpose_label}</td>
                  <td style={{ padding: "11px 8px", textAlign: "right", fontFamily: MONO, fontWeight: 600,
                               color: it.amount > 0 ? "#1A1A1A" : "#C8C0B0" }}>
                    {fmt(it.amount)}
                  </td>
                  <td style={{ padding: "11px 8px", textAlign: "right", fontFamily: MONO, color: "#4A7C59" }}>
                    {it.written_off ? fmt(it.written_off) : "—"}
                    {it.written_off_orders && (
                      <div style={{ fontSize: 10, color: "#A89070", fontFamily: "inherit" }}>{it.written_off_orders}</div>
                    )}
                  </td>
                  <td style={{ padding: "9px 28px", textAlign: "right", whiteSpace: "nowrap" }}>
                    {it.purpose === "stock" && it.amount > 0 && (
                      <button onClick={() => setWriteOff(it)}
                        style={{ fontSize: 11, padding: "5px 10px", border: "1px solid #EDEBE6", background: "#fff",
                                 color: "#6B6355", cursor: "pointer", fontFamily: "inherit", display: "inline-flex",
                                 alignItems: "center", gap: 5, marginRight: 6 }}>
                        <ArrowRight size={11} /> В заказ
                      </button>
                    )}
                    <button onClick={() => setForm({ item: it })} title="Править"
                      style={{ background: "none", border: "1px solid #EDEBE6", cursor: "pointer", color: "#6B6355",
                               padding: "5px 7px", marginRight: 6 }}>
                      <PencilSimple size={12} />
                    </button>
                    <button onClick={() => del.mutate(it.id)} title="Удалить"
                      style={{ background: "none", border: "1px solid #EDEBE6", cursor: "pointer", color: "#C8C0B0", padding: "5px 7px" }}>
                      <Trash size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {del.isError && (
            <div style={{ padding: "10px 28px", fontSize: 11, color: "#8B3A3A" }}>
              {(del.error as any)?.response?.data?.detail || "Не удалось удалить"}
            </div>
          )}
        </div>
      )}

      {form && <ExpenseForm item={form.item} onClose={() => setForm(null)} onDone={refresh} />}
      {writeOff && <WriteOffModal item={writeOff} onClose={() => setWriteOff(null)} onDone={refresh} />}
    </div>
  );
}
