import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MONO } from "../../components/ui/Num";
import { IconButton } from "../../components/ui/IconButton";
import { useNavigationGuard, NavigationGuardModal } from "../../components/NavigationGuard";
import { EditModal, type FieldDef } from "../../components/EditModal";
import { PayeeRulesSection } from "../../components/PayeeRulesSection";
import { customersApi } from "../../api";
import { PencilSimple, X } from "@phosphor-icons/react";
import { fmt } from "./helpers";
import { DetailRow as Row } from "./DetailRow";

const CUSTOMER_STATUS_COLORS: Record<string, string> = {
  "VIP": "#E8592A", "Постоянный": "#4A7C59", "Разовый": "#A89070", "Холодный": "#6B6355",
};

const ORDER_STATUS_LABELS: Record<string, string> = {
  draft: "Черновик", estimate: "Смета", project: "Проект",
  in_production: "В производстве", completed: "Завершён", cancelled: "Отменён",
};

export const CLIENT_FIELDS: FieldDef[] = [
  { key: "name",      label: "Название" },
  { key: "full_name", label: "Полное имя" },
  { key: "inn",       label: "ИНН" },
  { key: "contact",   label: "Контактное лицо" },
  { key: "phone",     label: "Телефон" },
  { key: "telegram",  label: "Telegram" },
  { key: "instagram", label: "Instagram" },
  { key: "whatsapp",  label: "WhatsApp" },
  { key: "email",     label: "Email" },
  { key: "status",    label: "Статус клиента", type: "select", options: [
    { v: "VIP",        l: "VIP" },
    { v: "Постоянный", l: "Постоянный" },
    { v: "Разовый",    l: "Разовый" },
    { v: "Холодный",   l: "Холодный" },
  ]},
  { key: "source",    label: "Источник / Канал", type: "select", options: [
    { v: "Сарафан",   l: "Сарафан" },
    { v: "Инстаграм", l: "Инстаграм" },
    { v: "Авито",     l: "Авито" },
    { v: "Сайт",      l: "Сайт" },
    { v: "ВКонтакте", l: "ВКонтакте" },
    { v: "Выставка",  l: "Выставка" },
    { v: "Прочее",    l: "Прочее" },
  ]},
  { key: "wiki_ref",  label: "Ссылка (wiki)" },
  { key: "notes",     label: "Заметки", type: "textarea" },
];

export function ClientDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const blocker = useNavigationGuard(editing);

  const { data, isLoading } = useQuery({
    queryKey: ["customer", id],
    queryFn: () => customersApi.get(id),
  });

  const save = useMutation({
    mutationFn: (patch: Record<string, any>) => customersApi.update(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customer", id] });
      qc.invalidateQueries({ queryKey: ["wiki", "clients"] });
      setEditing(false);
    },
  });

  const del = useMutation({
    mutationFn: () => customersApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wiki", "clients"] });
      setEditing(false);
      onClose();
    },
  });

  if (isLoading) return <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>;
  const customer = data?.customer;
  if (!customer) return null;
  const summary = data?.transaction_summary;
  const totalDebt = (data?.orders ?? []).reduce((s: number, o: any) => s + Math.max(0, o.debt ?? 0), 0);

  return (
    <>
      {editing && (
        <EditModal
          title={`Редактировать: ${customer.name}`}
          fields={CLIENT_FIELDS}
          initial={customer}
          isPending={save.isPending}
          onSave={(d) => save.mutate(d)}
          onClose={() => setEditing(false)}
          onDelete={() => del.mutate()}
        />
      )}

      <div style={{ padding: "22px 24px 16px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexShrink: 0 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <div style={{ fontSize: 21, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em", maxWidth: 270 }}>{customer.name}</div>
            {customer.status && (
              <span style={{ fontSize: 9, color: CUSTOMER_STATUS_COLORS[customer.status] || "#A89070", border: `1px solid ${CUSTOMER_STATUS_COLORS[customer.status] || "#EDEBE6"}`, padding: "2px 6px", letterSpacing: "0.04em", flexShrink: 0 }}>
                {customer.status}
              </span>
            )}
          </div>
          {customer.full_name && <div style={{ fontSize: 11, color: "#A89070" }}>{customer.full_name}</div>}
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <IconButton icon={PencilSimple} title="Редактировать" size={28} iconSize={16} color="#C8C0B0" onClick={() => setEditing(true)} />
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 6 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
            onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}>
            <X size={16} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "18px 24px" }}>
        {summary && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 20 }}>
            {[
              { l: "Заказов",  v: String(data?.orders?.length ?? 0), c: "#1A1A1A" },
              { l: "Получено", v: fmt(summary.income),                c: "#4A7C59" },
              { l: "Долг",     v: totalDebt > 0 ? fmt(totalDebt) : "нет", c: totalDebt > 0 ? "#8B3A3A" : "#4A7C59" },
            ].map(s => (
              <div key={s.l} style={{ background: "#FAF8F5", padding: "9px 11px" }}>
                <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 3 }}>{s.l.toUpperCase()}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: s.c, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{s.v}</div>
              </div>
            ))}
          </div>
        )}

        <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>КОНТАКТЫ</div>
        <Row label="ИНН"              value={customer.inn} mono />
        <Row label="Телефон"          value={customer.phone} mono />
        <Row label="Email"            value={customer.email} />
        <Row label="Контактное лицо"  value={customer.contact} />

        {(customer.source || customer.notes) && (
          <>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10, marginTop: 20 }}>ПРОФИЛЬ</div>
            {customer.source && <Row label="Источник" value={customer.source} />}
            {customer.notes && (
              <div style={{ marginTop: 8, padding: "10px 12px", background: "#FAF8F5", fontSize: 12, color: "#1A1A1A", lineHeight: 1.7, borderLeft: "3px solid #EDEBE6" }}>
                {customer.notes}
              </div>
            )}
          </>
        )}

        {customer.wiki_ref && (
          <>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10, marginTop: 20 }}>ВИКИ</div>
            <Row label="Ссылка" value={customer.wiki_ref} />
          </>
        )}

        {data?.orders?.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>
              ЗАКАЗЫ <span style={{ color: "#C8C0B0", fontWeight: 400 }}>· {data.orders.length}</span>
            </div>
            {data.orders.map((o: any) => (
              <div key={o.id} style={{ padding: "9px 0", borderBottom: "1px solid #F2EFE9" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>{o.title || o.number || "—"}</div>
                  <div style={{ fontSize: 10, color: "#A89070" }}>{ORDER_STATUS_LABELS[o.status] || o.status}</div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#6B6355" }}>
                  <span style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(o.price_plan)}</span>
                  <span style={{ color: o.debt > 0 ? "#E8592A" : "#4A7C59", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{o.debt > 0 ? `долг ${fmt(o.debt)}` : "оплачен"}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <PayeeRulesSection entityType="customer" entityId={id} />
      </div>

      <NavigationGuardModal blocker={blocker} />
    </>
  );
}
