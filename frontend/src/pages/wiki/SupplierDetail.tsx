import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconButton } from "../../components/ui/IconButton";
import { useNavigationGuard, NavigationGuardModal } from "../../components/NavigationGuard";
import { EditModal, type FieldDef } from "../../components/EditModal";
import { PayeeRulesSection } from "../../components/PayeeRulesSection";
import { suppliersApi } from "../../api";
import { PencilSimple, X } from "@phosphor-icons/react";
import { DetailRow as Row } from "./DetailRow";

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

      <div style={{ padding: "22px 24px 16px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexShrink: 0 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <div style={{ fontSize: 21, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em", maxWidth: 270 }}>{s.name}</div>
            {s.price_supplier && PRICE_SUPPLIER_LABELS[s.price_supplier] && (
              <span style={{ fontSize: 9, color: "#E8592A", border: "1px solid #E8592A", padding: "2px 6px", letterSpacing: "0.04em" }}>
                прайс: {PRICE_SUPPLIER_LABELS[s.price_supplier]}
              </span>
            )}
          </div>
          {s.category && <div style={{ fontSize: 11, color: "#A89070" }}>{s.category}</div>}
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
        <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>КОНТАКТЫ</div>
        <Row label="ИНН"             value={s.inn} mono />
        <Row label="Телефон"         value={s.phone} mono />
        <Row label="Email"           value={s.email} />
        <Row label="Контактное лицо" value={s.contact} />
        <Row label="Telegram"        value={s.telegram} />
        <Row label="Сайт"            value={s.website} />

        {s.notes && (
          <>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10, marginTop: 20 }}>ЗАМЕТКИ</div>
            <div style={{ padding: "10px 12px", background: "#FAF8F5", fontSize: 12, color: "#1A1A1A", lineHeight: 1.7, borderLeft: "3px solid #EDEBE6" }}>
              {s.notes}
            </div>
          </>
        )}

        <PayeeRulesSection entityType="supplier" entityId={s.id} />
      </div>

      <NavigationGuardModal blocker={blocker} />
    </>
  );
}
