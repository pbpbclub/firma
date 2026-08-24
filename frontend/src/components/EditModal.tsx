import { useState } from "react";
import { Modal, ConfirmModal } from "./ui/Modal";

// Описание поля формы. Общее для карточек клиента и подрядчика.
export type FieldDef = {
  key: string;
  label: string;
  type?: "text" | "textarea" | "select";
  options?: { v: string; l: string }[];
};

export function EditModal({
  title, fields, initial, onSave, onClose, onDelete, isPending,
}: {
  title: string;
  fields: FieldDef[];
  initial: Record<string, any>;
  onSave: (data: Record<string, any>) => void;
  onClose: () => void;
  onDelete?: () => void;
  isPending: boolean;
}) {
  const [draft, setDraft] = useState<Record<string, any>>({ ...initial });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (key: string, val: string) => setDraft(d => ({ ...d, [key]: val }));

  return (
    <>
      <Modal
        size="md"
        eyebrow={title}
        onClose={onClose}
        onDelete={onDelete ? () => setConfirmDelete(true) : undefined}
        onCancel={onClose}
        onSave={() => onSave(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, (v as string)?.trim() || null])))}
        saving={isPending}
      >
          <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
            {fields.map(f => (
              <div key={f.key}>
                <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>{f.label.toUpperCase()}</div>
                {f.type === "textarea" ? (
                  <textarea
                    value={draft[f.key] ?? ""}
                    onChange={e => set(f.key, e.target.value)}
                    rows={3}
                    style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 12, outline: "none", resize: "vertical", fontFamily: "inherit" }}
                  />
                ) : f.type === "select" ? (
                  <select
                    value={draft[f.key] ?? ""}
                    onChange={e => set(f.key, e.target.value)}
                    style={{ width: "100%", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 12, outline: "none", background: "#fff" }}
                  >
                    <option value="">—</option>
                    {f.options?.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                  </select>
                ) : (
                  <input
                    value={draft[f.key] ?? ""}
                    onChange={e => set(f.key, e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 12, outline: "none" }}
                  />
                )}
              </div>
            ))}
          </div>
      </Modal>

      {confirmDelete && (
        <ConfirmModal
          message="Запись будет удалена. Это действие нельзя отменить."
          confirmLabel="Да, удалить"
          // Закрываем ДО вызова: если onDelete упал, окно висело навсегда, а
          // повторный клик отправлял удаление второй раз.
          onConfirm={() => { setConfirmDelete(false); onDelete?.(); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}

