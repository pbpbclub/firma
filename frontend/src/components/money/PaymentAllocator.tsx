/**
 * Редактор разноски поступления: одна транзакция → 1..N заказов.
 *
 * Общий для «Разноски» и ДДС (24.08.2026). До этого два экрана делали одно разными
 * ручками: инбокс — через POST /payments/from-tx (несколько заказов, group_id,
 * extra_id, подсказка резерва), а ДДС — через POST /orders/{id}/payments, то есть
 * строго один заказ и без group_id, поэтому разнесённое из ДДС нельзя было ни
 * разбить, ни откатить группой.
 *
 * Компонент владеет только строками разноски. Блок «плательщик → клиент» с правилами
 * остаётся в инбоксе: он специфичен для потока разбора выписки.
 *
 * Бэкенд требует, чтобы сумма строк РАВНЯЛАСЬ сумме транзакции (payments.py:233) —
 * частичная разноска не поддерживается, поэтому остаток показываем всегда.
 */
import { useQuery } from "@tanstack/react-query";
import { X } from "@phosphor-icons/react";
import { ordersApi } from "../../api";
import { MONO } from "../ui/Num";
import { fmtMoneyDash as fmt } from "../ui/format";

export type Alloc = { order_id: string; amount: string; extra_id?: string; note?: string };

/** «Это по допу, а не по смете» — селект появляется, только если у заказа есть допы. */
function ExtraPicker({ orderId, value, onChange }: {
  orderId: string; value: string; onChange: (v: string) => void;
}) {
  const { data: extras } = useQuery({
    queryKey: ["order-extras", orderId],
    queryFn: () => ordersApi.extras(orderId),
  });
  const items: any[] = Array.isArray(extras) ? extras : (extras as any)?.items ?? [];
  if (!items.length) return null;
  return (
    <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
      <span style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em" }}>ОТНОСИТСЯ К</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ flex: 1, minWidth: 0, border: "1px solid #EDEBE6", padding: "4px 8px", fontSize: 11,
                 outline: "none", background: "transparent", color: "#6B6355", cursor: "pointer",
                 fontFamily: "inherit" }}>
        <option value="">Смета заказа</option>
        {items.map((x: any) => <option key={x.id} value={x.id}>Доп: {x.title}</option>)}
      </select>
    </div>
  );
}

export function PaymentAllocator({ tx, allocs, onChange, label = "ПЛАТЁЖ ПО ЗАКАЗАМ" }: {
  tx: { id: string | number; amount: number; counterparty?: string | null; purpose?: string | null };
  allocs: Alloc[];
  onChange: (next: Alloc[]) => void;
  label?: string;
}) {
  // Скоринг заказов по контрагенту и сумме против долга — считает бэкенд.
  const { data: suggestions = [] } = useQuery({
    queryKey: ["order-suggest-in", tx.counterparty, tx.amount],
    queryFn: () => ordersApi.suggest(tx.counterparty || tx.purpose || "", tx.amount || 0),
  });
  const ordersById = new Map((suggestions as any[]).map((o: any) => [o.id, o]));

  const patch = (i: number, field: keyof Alloc, v: string) =>
    onChange(allocs.map((x, j) => (j === i ? { ...x, [field]: v } : x)));

  const addOrder = (orderId: string) => {
    if (allocs.some(a => a.order_id === orderId)) return;
    // По умолчанию — весь неразнесённый остаток (первый заказ = вся сумма платежа).
    const other = allocs.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
    const left = Math.round((tx.amount - other) * 100) / 100;
    onChange([...allocs, { order_id: orderId, amount: left > 0 ? String(left) : "" }]);
  };

  const sum = allocs.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
  const diff = Math.round((tx.amount - sum) * 100) / 100;

  return (
    <>
      <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>{label}</div>

      {allocs.map((a, i) => {
        const o = ordersById.get(a.order_id);
        return (
          <div key={a.order_id} style={{ background: "#fff", border: "1px solid #EDEBE6", padding: "8px 10px", marginBottom: 8,
            display: "grid", gridTemplateColumns: "1fr 120px 24px", gap: 8, alignItems: "center" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {o?.title ?? a.order_id}
              </div>
              {o && (
                <div style={{ fontSize: 10, color: "#A89070", marginTop: 1 }}>
                  {o.customer_name ? `${o.customer_name} · ` : ""}долг <span style={{ fontFamily: MONO }}>{fmt(o.debt)}</span>
                </div>
              )}
            </div>
            <input value={a.amount} onChange={e => patch(i, "amount", e.target.value)} placeholder="сумма" type="number"
              style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none", textAlign: "right", fontFamily: MONO }} />
            <button onClick={() => onChange(allocs.filter((_, j) => j !== i))}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 0, display: "flex", justifyContent: "center" }}>
              <X size={12} />
            </button>
            <ExtraPicker orderId={a.order_id} value={a.extra_id || ""} onChange={v => patch(i, "extra_id", v)} />
            <input value={a.note || ""} onChange={e => patch(i, "note", e.target.value)}
              placeholder="примечание к платежу (необязательно)"
              style={{ gridColumn: "1 / -1", boxSizing: "border-box", border: "1px solid #EDEBE6",
                       padding: "4px 8px", fontSize: 11, outline: "none", background: "transparent", color: "#6B6355" }} />
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4, marginBottom: 12 }}>
        {(suggestions as any[]).filter((o: any) => !allocs.some(a => a.order_id === o.id)).slice(0, 6).map((o: any) => (
          <button key={o.id} onClick={() => addOrder(o.id)}
            style={{ fontSize: 11, padding: "3px 9px", border: "1px solid #EDEBE6", background: "#fff", cursor: "pointer", color: "#6B6355", fontFamily: "inherit" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#E8592A"; e.currentTarget.style.color = "#E8592A"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#EDEBE6"; e.currentTarget.style.color = "#6B6355"; }}>
            + {o.title}{o.debt > 0 ? ` · долг ${fmt(o.debt)}` : ""}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 11, color: Math.abs(diff) < 0.01 ? "#4A7C59" : "#8B3A3A" }}>
        {allocs.length === 0
          ? `К разноске ${fmt(tx.amount)} — выбери заказ`
          : Math.abs(diff) < 0.01
            ? `Разнесено полностью: ${fmt(sum)}`
            : diff > 0 ? `Осталось разнести ${fmt(diff)}` : `Разнесено больше суммы на ${fmt(-diff)}`}
      </div>
    </>
  );
}

/** Готова ли разноска к отправке: есть строки и сумма сошлась с транзакцией. */
export function allocReady(allocs: Alloc[], txAmount: number): boolean {
  if (!allocs.length) return false;
  const sum = allocs.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
  return Math.abs(txAmount - sum) < 0.01;
}

/** Строки в тело POST /payments/from-tx. */
export function allocPayload(allocs: Alloc[]) {
  return allocs.map(a => ({
    order_id: a.order_id,
    amount: parseFloat(a.amount) || 0,
    extra_id: a.extra_id || null,
    note: a.note?.trim() || null,
  }));
}
