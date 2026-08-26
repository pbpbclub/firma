/**
 * Окно «по заказу остались незакрытые обязательства» — одно на три двери:
 * завершение, отмена и архивация заказа (все отвечают 409 obligations_unpaid),
 * плюс плашки «закрыть по завершённым/отменённым/архивным» в «Обязательствах».
 *
 * Юра решает построчно: галочка снята — строка остаётся долгом, подрядчику
 * действительно должны. Остальное закрывается с причиной, по которой откат
 * переоткроет ровно это.
 */
import { useState, type ReactNode } from "react";
import { Modal } from "../ui/Modal";
import { fmtMoneyDash as fmt } from "../ui/format";

export type Unpaid = {
  id: string; name: string; description?: string; plan: number; fact: number; debt: number;
  ambiguous?: boolean; order?: string;
};

export function ObligationsConfirmModal({ eyebrow, saveLabel, intro, items, total, saving, onConfirm, onCancel }: {
  eyebrow: string;
  saveLabel: string;
  intro: ReactNode;
  items: Unpaid[];
  total: number;
  saving?: boolean;
  onConfirm: (closeIds: string[]) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [keepIds, setKeepIds] = useState<Set<string>>(new Set());
  const toggleKeep = (id: string) => setKeepIds(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const closing = items.filter(i => !keepIds.has(i.id));
  const writeOff = closing.reduce((s, i) => s + i.debt, 0);

  return (
    <Modal
      eyebrow={eyebrow}
      size="lg"
      onClose={onCancel}
      onCancel={onCancel}
      onSave={() => onConfirm(closing.map(i => i.id))}
      saveLabel={saveLabel}
      saving={saving}
      canSave={closing.length > 0}
      footerLeft={
        <div style={{ fontSize: 12, color: "#6B6355" }}>
          Спишется: <b style={{ color: "#8B3A3A" }}>{fmt(writeOff)}</b>
          {keepIds.size > 0 && (
            <span style={{ color: "#A89070" }}> · остаётся долгом {fmt(total - writeOff)}</span>
          )}
        </div>
      }
    >
      <div style={{ padding: "18px 24px" }}>
        <div style={{ fontSize: 13, color: "#6B6355", lineHeight: 1.6, marginBottom: 14 }}>{intro}</div>
        <div style={{ border: "1px solid #EDEBE6", maxHeight: 300, overflowY: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "26px 1fr 90px 90px 90px",
                        padding: "7px 12px", borderBottom: "1px solid #EDEBE6",
                        fontSize: 10, color: "#A89070", letterSpacing: "0.05em" }}>
            <div /><div>ОБЯЗАТЕЛЬСТВО</div>
            <div style={{ textAlign: "right" }}>ПЛАН</div>
            <div style={{ textAlign: "right" }}>ФАКТ</div>
            <div style={{ textAlign: "right" }}>СПИСАТЬ</div>
          </div>
          {items.map(i => {
            const keep = keepIds.has(i.id);
            return (
              <div key={i.id} style={{ display: "grid", gridTemplateColumns: "26px 1fr 90px 90px 90px",
                                       padding: "9px 12px", borderBottom: "1px solid #F2EFE9",
                                       alignItems: "center", opacity: keep ? 0.5 : 1 }}>
                <input type="checkbox" checked={!keep} onChange={() => toggleKeep(i.id)}
                       style={{ accentColor: "#E8592A", cursor: "pointer" }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#1A1A1A" }}>{i.name}</div>
                  {i.order && <div style={{ fontSize: 10, color: "#A89070", marginTop: 1 }}>{i.order}</div>}
                  {i.ambiguous && (
                    <div style={{ fontSize: 9, color: "#B8860B", marginTop: 1 }}>≈ похоже, закрыто расходами</div>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "#6B6355", textAlign: "right" }}>{fmt(i.plan)}</div>
                <div style={{ fontSize: 12, color: i.fact > 0 ? "#4A7C59" : "#C8C0B0", textAlign: "right" }}>
                  {i.fact > 0 ? fmt(i.fact) : "—"}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: keep ? "#C8C0B0" : "#8B3A3A", textAlign: "right" }}>
                  {keep ? "остаётся" : fmt(i.debt)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
