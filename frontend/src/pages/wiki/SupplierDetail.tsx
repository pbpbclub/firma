import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigationGuard, NavigationGuardModal } from "../../components/NavigationGuard";
import { EditModal, type FieldDef } from "../../components/EditModal";
import { PayeeRulesSection } from "../../components/PayeeRulesSection";
import { suppliersApi, materialsApi } from "../../api";
import { MONO } from "../../components/ui/Num";
import { DetailRow as Row } from "./DetailRow";
import { DetailShell, DetailSection, NoteBlock } from "./DetailShell";

// Свежесть прайса поставщика из materials.db (живые цены ВРЭП/Металлинвест).
function PriceSync({ code }: { code: string }) {
  const { data } = useQuery({
    queryKey: ["supplier-sync", code],
    queryFn: () => materialsApi.supplierSync(code),
  });
  if (!data?.last_date) return null;
  return (
    <DetailSection label="ПРАЙС">
      <div style={{ fontSize: 13, color: "#1A1A1A" }}>
        {PRICE_SUPPLIER_LABELS[code] || code} · обновлён{" "}
        <span style={{ fontFamily: MONO }}>{data.last_date}</span>
        <span style={{ color: "#A89070" }}> · {new Intl.NumberFormat("ru-RU").format(data.count)} позиций</span>
      </div>
    </DetailSection>
  );
}

// Код прайса materials.db → метка (справочно; join не строим).
export const PRICE_SUPPLIER_LABELS: Record<string, string> = {
  vrep: "ВРЭП", metplus: "Металлинвест",
};

export const SUPPLIER_FIELDS: FieldDef[] = [
  { key: "name",           label: "Название" },
  { key: "full_name",      label: "Полное название" },
  { key: "inn",            label: "ИНН" },
  { key: "category",       label: "Категория (что поставляет)" },
  { key: "contact",        label: "Контактное лицо" },
  { key: "phone",          label: "Телефон" },
  { key: "telegram",       label: "Telegram" },
  { key: "email",          label: "Email" },
  { key: "website",        label: "Сайт" },
  { key: "price_supplier", label: "Прайс поставщика", type: "select", options: [
    { v: "vrep",    l: "ВРЭП" },
    { v: "metplus", l: "Металлинвест" },
  ]},
  { key: "status",         label: "Статус" },
  { key: "notes",          label: "Заметки", type: "textarea" },
];

// Список приходит одним запросом (wiki-экран), get по id не нужен — работаем по row.
export function SupplierDetail({ row, onClose, onDeleted }: { row: any; onClose: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const blocker = useNavigationGuard(editing);
  const s = row;

  const save = useMutation({
    mutationFn: (patch: Record<string, any>) => suppliersApi.update(s.id, patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["wiki", "suppliers"] }); setEditing(false); },
  });
  const del = useMutation({
    mutationFn: () => suppliersApi.delete(s.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["wiki", "suppliers"] }); setEditing(false); onDeleted(); },
  });

  if (!s) return null;

  return (
    <>
      {editing && (
        <EditModal
          title={`Редактировать: ${s.name}`}
          fields={SUPPLIER_FIELDS}
          initial={s}
          isPending={save.isPending}
          onSave={(d) => save.mutate(d)}
          onClose={() => setEditing(false)}
          onDelete={() => del.mutate()}
        />
      )}

      <DetailShell
        title={s.name}
        subtitle={s.category}
        avatar={{ kind: "initials", name: s.name }}
        status={s.price_supplier && PRICE_SUPPLIER_LABELS[s.price_supplier]
          ? { label: `прайс: ${PRICE_SUPPLIER_LABELS[s.price_supplier]}`, color: "#E8592A" } : null}
        onEdit={() => setEditing(true)}
        onClose={onClose}
      >
        <DetailSection label="КОНТАКТЫ" first>
          <Row label="ИНН"             value={s.inn} mono />
          <Row label="Телефон"         value={s.phone} mono />
          <Row label="Email"           value={s.email} />
          <Row label="Контактное лицо" value={s.contact} />
          <Row label="Telegram"        value={s.telegram} />
          <Row label="Сайт"            value={s.website} />
        </DetailSection>

        {s.price_supplier && PRICE_SUPPLIER_LABELS[s.price_supplier] && (
          <PriceSync code={s.price_supplier} />
        )}

        {s.notes && (
          <DetailSection label="ЗАМЕТКИ">
            <NoteBlock>{s.notes}</NoteBlock>
          </DetailSection>
        )}

        <PayeeRulesSection entityType="supplier" entityId={s.id} />
      </DetailShell>

      <NavigationGuardModal blocker={blocker} />
    </>
  );
}
