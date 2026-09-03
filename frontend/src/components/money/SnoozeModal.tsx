/**
 * «Убрать из актуального» (ТЗ 03.09.2026, п.7): причина + дата возврата или
 * «навсегда». Заглушённое уходит из сумм экрана денег, но не удаляется — живёт во
 * вкладке «Архив» и возвращается по сроку само.
 */
import { useState } from "react";
import { Modal } from "../ui/Modal";

export function SnoozeModal({ title, subtitle, onSave, onClose, saving }: {
  title: string; subtitle?: string;
  onSave: (v: { until: string | null; reason: string }) => void | Promise<void>;
  onClose: () => void; saving?: boolean;
}) {
  const [reason, setReason] = useState("");
  const [forever, setForever] = useState(false);
  const plus30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const [until, setUntil] = useState(plus30);
  const ok = reason.trim().length > 0 && (forever || !!until);
  const lbl: React.CSSProperties = { fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 };
  const inp: React.CSSProperties = { width: "100%", border: "1px solid #EDEBE6", padding: "7px 9px", fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" };
  return (
    <Modal size="md" eyebrow="УБРАТЬ ИЗ АКТУАЛЬНОГО" onClose={onClose} onCancel={onClose}
           onSave={() => ok && onSave({ until: forever ? null : until, reason: reason.trim() })}
           canSave={ok} saving={saving} saveLabel="Убрать">
      <div style={{ fontSize: 13, color: "#1A1A1A", marginBottom: 2 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 11, color: "#A89070", marginBottom: 12 }}>{subtitle}</div>}
      <div style={{ fontSize: 11, color: "#6B6355", lineHeight: 1.6, margin: "8px 0 14px" }}>
        Из сумм и плашек уйдёт, но не удалится: останется в истории и во вкладке «Архив». По сроку вернётся само.
      </div>
      <div style={lbl}>ПОЧЕМУ</div>
      <input style={inp} value={reason} onChange={e => setReason(e.target.value)} autoFocus
             placeholder="клиент тянет до конца квартала / старый счёт, спишем" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12, alignItems: "end" }}>
        <div>
          <div style={lbl}>ВЕРНУТЬ</div>
          <input type="date" style={{ ...inp, opacity: forever ? 0.4 : 1 }} value={until} disabled={forever}
                 onChange={e => setUntil(e.target.value)} />
        </div>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "#6B6355", cursor: "pointer", paddingBottom: 8 }}>
          <input type="checkbox" checked={forever} onChange={e => setForever(e.target.checked)} style={{ accentColor: "#E8592A" }} />
          навсегда
        </label>
      </div>
    </Modal>
  );
}
