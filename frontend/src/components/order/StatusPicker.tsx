// Выпадашка-пилюля смены статуса заказа: клик по статусу → список → мгновенный
// PATCH, без формы и «Сохранить». Живёт и в строках списка заказов, и в шапке
// карточки — вынесена из OrdersV2, чтобы карточка не дублировала логику.
import { useState, useRef, useEffect } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { ordersApi } from "../../api";
import { ORDER_STATUSES } from "../domain";

export function StatusPicker({ orderId, current, onChange }: {
  orderId: string; current: string; onChange: (status: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const st = ORDER_STATUSES.find(s => s.value === current) || { label: current, color: "#A89070" };

  const pick = async (value: string) => {
    if (value === current) { setOpen(false); return; }
    setSaving(true);
    try {
      await ordersApi.updateStatus(orderId, value);
      onChange(value);
    } finally {
      setSaving(false);
      setOpen(false);
    }
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}
         onClick={e => e.stopPropagation()}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={saving}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "5px 10px", border: "1px solid #EDEBE6", background: "none",
          fontSize: 11, cursor: "pointer", color: st.color, fontWeight: 600,
          fontFamily: "inherit",
        }}
      >
        {saving ? "..." : st.label}
        <CaretDown size={10} style={{ color: "#A89070" }} />
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, marginTop: 2,
          background: "#fff", border: "1px solid #EDEBE6", zIndex: 100,
          boxShadow: "0 4px 16px rgba(0,0,0,0.12)", minWidth: 160,
        }}>
          {ORDER_STATUSES.map(s => (
            <div
              key={s.value}
              onClick={() => pick(s.value)}
              style={{
                padding: "8px 14px", fontSize: 12, cursor: "pointer",
                color: s.value === current ? "#1A1A1A" : s.color,
                fontWeight: s.value === current ? 700 : 400,
                background: s.value === current ? "#FAF8F5" : "transparent",
              }}
              onMouseEnter={(e) => { if (s.value !== current) (e.currentTarget as HTMLElement).style.background = "#FAF8F5"; }}
              onMouseLeave={(e) => { if (s.value !== current) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              {s.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
