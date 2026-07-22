import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MONO } from "../../components/ui/Num";
import { useNavigationGuard, NavigationGuardModal } from "../../components/NavigationGuard";
import { EditModal, type FieldDef } from "../../components/EditModal";
import { PayeeRulesSection } from "../../components/PayeeRulesSection";
import { customersApi } from "../../api";
import { fmt } from "./helpers";
import { DetailRow as Row } from "./DetailRow";
import { DetailShell, DetailSection, NoteBlock } from "./DetailShell";

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

      <DetailShell
        title={customer.name}
        subtitle={customer.full_name}
        avatar={{ kind: "initials", name: customer.name }}
        status={customer.status ? { label: customer.status, color: CUSTOMER_STATUS_COLORS[customer.status] } : null}
        metrics={summary ? [
          { label: "Заказов",  value: String(data?.orders?.length ?? 0) },
          { label: "Получено", value: fmt(summary.income), color: "#4A7C59" },
          { label: "Долг",     value: totalDebt > 0 ? fmt(totalDebt) : "нет", color: totalDebt > 0 ? "#8B3A3A" : "#4A7C59" },
        ] : undefined}
        onEdit={() => setEditing(true)}
        onClose={onClose}
      >
        <DetailSection label="КОНТАКТЫ" first>
          <Row label="ИНН"              value={customer.inn} mono />
          <Row label="Телефон"          value={customer.phone} mono />
          <Row label="Email"            value={customer.email} />
          <Row label="Контактное лицо"  value={customer.contact} />
        </DetailSection>

        {(customer.source || customer.notes) && (
          <DetailSection label="ПРОФИЛЬ">
            {customer.source && <Row label="Источник" value={customer.source} />}
            {customer.notes && <NoteBlock>{customer.notes}</NoteBlock>}
          </DetailSection>
        )}

        {customer.wiki_ref && (
          <DetailSection label="ВИКИ">
            <Row label="Ссылка" value={customer.wiki_ref} />
          </DetailSection>
        )}

        {data?.orders?.length > 0 && (
          <DetailSection label="ЗАКАЗЫ" extra={`· ${data.orders.length}`}>
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
          </DetailSection>
        )}

        <PayeeRulesSection entityType="customer" entityId={id} />
      </DetailShell>

      <NavigationGuardModal blocker={blocker} />
    </>
  );
}
