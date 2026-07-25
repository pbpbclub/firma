// Параметры заказа (статус/бренд/приоритет/клиент/дедлайн) — сворачиваемая секция.
// Карточка открывается деньгами и план-фактом; форма правки — под катом.
// Состояние формы живёт в OrderDetail (кнопка «Сохранить» в топ-баре).
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CaretDown, CaretRight, Phone, EnvelopeSimple } from "@phosphor-icons/react";
import { customersApi } from "../../api";
import { contactHref } from "../ui/ContactLinks";
import { MONO } from "../ui/Num";
import { fmtDate } from "../ui/format";
import { BRANDS, ORDER_STATUSES } from "../domain";

export type OrderFormState = {
  title: string; status: string; brand: string; priority: string;
  deadline: string; customer_id: string; price_plan: string; cost_plan: string;
};

const PRIORITY_LABELS: Record<string, string> = { low: "Низкий", normal: "Обычный", high: "Высокий", urgent: "Срочный" };

export function OrderParams({ order, form, field, customers }: {
  order: any;
  form: OrderFormState;
  field: (f: Partial<OrderFormState>) => void;
  customers: any[];
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  const statusMeta = ORDER_STATUSES.find(s => s.value === form.status);
  const brandColor = BRANDS.find(b => b.value === form.brand)?.color || "#A89070";
  const customerName = (customers as any[]).find((c: any) => String(c.id) === form.customer_id)?.name
    || order?.customer_name;

  const createCustomer = async () => {
    if (!newCustomerName.trim()) return;
    setCreatingCustomer(true);
    try {
      const c = await customersApi.create({ name: newCustomerName.trim() });
      qc.invalidateQueries({ queryKey: ["customers"] });
      field({ customer_id: String(c.id) });
      setNewCustomerName("");
    } finally {
      setCreatingCustomer(false);
    }
  };

  return (
    <div style={{ borderTop: "1px solid #EDEBE6", marginBottom: 8 }}>
      {/* Шапка-свёртка: закрытая показывает выжимку значений */}
      <button onClick={() => setOpen(o => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "14px 0",
          background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
        {open ? <CaretDown size={11} style={{ color: "#A89070" }} /> : <CaretRight size={11} style={{ color: "#A89070" }} />}
        <span style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em" }}>ПАРАМЕТРЫ</span>
        {!open && (
          <span style={{ fontSize: 11, color: "#6B6355", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <span style={{ color: statusMeta?.color, fontWeight: 600 }}>{statusMeta?.label ?? form.status}</span>
            {form.brand && <> · <span style={{ color: brandColor, fontWeight: 600 }}>{form.brand}</span></>}
            {customerName && <> · {customerName}</>}
            {form.deadline && <> · до <span style={{ fontFamily: MONO }}>{fmtDate(form.deadline)}</span></>}
            {form.priority !== "normal" && <> · {PRIORITY_LABELS[form.priority] ?? form.priority}</>}
          </span>
        )}
      </button>

      {open && (
        <div style={{ paddingBottom: 20 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>СТАТУС</div>
              <select value={form.status} onChange={e => field({ status: e.target.value })}
                style={{ border: "1px solid #EDEBE6", padding: "6px 10px", fontSize: 12, fontWeight: 600, outline: "none", background: "#fff", color: statusMeta?.color ?? "#1A1A1A", cursor: "pointer", fontFamily: "inherit" }}>
                {ORDER_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>БРЕНД</div>
              <select value={form.brand} onChange={e => field({ brand: e.target.value })}
                style={{ border: `1px solid ${form.brand ? brandColor : "#EDEBE6"}`, padding: "6px 10px", fontSize: 12, fontWeight: 600, outline: "none", background: "#fff", color: form.brand ? brandColor : "#A89070", cursor: "pointer", fontFamily: "inherit" }}>
                <option value="">— без бренда —</option>
                {BRANDS.map(b => <option key={b.value} value={b.value}>{b.value}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ПРИОРИТЕТ</div>
              <select value={form.priority} onChange={e => field({ priority: e.target.value })}
                style={{ border: "1px solid #EDEBE6", padding: "6px 10px", fontSize: 12, outline: "none", background: "#fff", cursor: "pointer", fontFamily: "inherit" }}>
                {Object.entries(PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ДЕДЛАЙН</div>
              <input type="date" value={form.deadline} onChange={e => field({ deadline: e.target.value })}
                style={{ border: "1px solid #EDEBE6", padding: "5px 10px", fontSize: 12, outline: "none", fontFamily: "inherit" }} />
            </div>
          </div>

          <div style={{ maxWidth: 420 }}>
            <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>КЛИЕНТ</div>
            <select
              value={form.customer_id === "__new__" ? "__new__" : form.customer_id}
              onChange={e => { field({ customer_id: e.target.value }); setNewCustomerName(""); }}
              style={{ width: "100%", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none", background: "#fff", fontFamily: "inherit" }}>
              <option value="">— не выбран —</option>
              {(customers as any[]).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="__new__">+ Создать нового клиента</option>
            </select>
            {form.customer_id === "__new__" && (
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <input autoFocus placeholder="Имя клиента" value={newCustomerName}
                  onChange={e => setNewCustomerName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Escape") { field({ customer_id: "" }); setNewCustomerName(""); }
                    if (e.key === "Enter") createCustomer();
                  }}
                  style={{ flex: 1, border: "1px solid #E8592A", padding: "6px 10px", fontSize: 13, outline: "none", fontFamily: "inherit" }} />
                <button disabled={creatingCustomer || !newCustomerName.trim()} onClick={createCustomer}
                  style={{ padding: "6px 14px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600, opacity: creatingCustomer || !newCustomerName.trim() ? 0.5 : 1, fontFamily: "inherit" }}>
                  {creatingCustomer ? "..." : "Создать"}
                </button>
              </div>
            )}
            {/* Контакты клиента приходят с карточкой заказа — раньше не показывались вовсе */}
            {(order?.customer_phone || order?.customer_email) && form.customer_id === String(order?.customer_id ?? "") && (
              <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 11, color: "#6B6355", flexWrap: "wrap" }}>
                {order.customer_phone && (
                  <a href={contactHref("phone", order.customer_phone)}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "inherit", textDecoration: "none" }}>
                    <Phone size={11} style={{ color: "#A89070" }} />
                    <span style={{ fontFamily: MONO }}>{order.customer_phone}</span>
                  </a>
                )}
                {order.customer_email && (
                  <a href={contactHref("email", order.customer_email)}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "inherit", textDecoration: "none" }}>
                    <EnvelopeSimple size={11} style={{ color: "#A89070" }} />
                    <span style={{ fontFamily: MONO }}>{order.customer_email}</span>
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
