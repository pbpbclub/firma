// Выпадашка-пилюля смены статуса заказа: клик по статусу → список → мгновенный
// PATCH, без формы и «Сохранить». Живёт и в строках списка заказов, и в шапке
// карточки — вынесена из OrdersV2, чтобы карточка не дублировала логику.
//
// Здесь же — подтверждение закрытия расчётов с подрядчиками при завершении
// заказа (ТЗ обязательств 04.08.2026): бэкенд отвечает 409 со списком незакрытых
// обязательств, Юра решает построчно, что списать, а что оставить долгом.
import { useState, useRef, useEffect } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { ordersApi } from "../../api";
import { fmtMoneyDash as fmt } from "../ui/format";
import { ORDER_STATUSES } from "../domain";
import { ObligationsConfirmModal, type Unpaid } from "./ObligationsConfirmModal";

export function StatusPicker({ orderId, current, onChange }: {
  orderId: string; current: string; onChange: (status: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // target — куда переводим: завершение и отмена отвечают одним 409, окно одно.
  const [confirm, setConfirm] = useState<{ items: Unpaid[]; total: number; target: string } | null>(null);
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
    } catch (err: any) {
      // 409 — по заказу остались незакрытые обязательства: спрашиваем, а не списываем молча
      const d = err?.response?.data?.detail;
      if (err?.response?.status === 409 && d?.code === "obligations_unpaid") {
        setConfirm({ items: d.items || [], total: d.unpaid_total || 0, target: d.target || value });
      } else {
        throw err;
      }
    } finally {
      setSaving(false);
      setOpen(false);
    }
  };

  const confirmClose = async (closeIds: string[]) => {
    if (!confirm) return;
    setSaving(true);
    try {
      // Закрываем только те, что Юра не оставил долгом
      await ordersApi.updateStatus(orderId, confirm.target, { close_obligations: true, only_ids: closeIds });
      onChange(confirm.target);
      setConfirm(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}
         onClick={e => e.stopPropagation()}>
      {confirm && (
        <ObligationsConfirmModal
          eyebrow={confirm.target === "cancelled" ? "ОТМЕНИТЬ ЗАКАЗ" : "ЗАВЕРШИТЬ ЗАКАЗ"}
          saveLabel={confirm.target === "cancelled" ? "Отменить заказ" : "Завершить заказ"}
          intro={confirm.target === "cancelled"
            ? <>Заказ отменяется, а по смете остались обязательства на <b>{fmt(confirm.total)}</b>. Отмена закрывает
                их: подрядчикам по этому заказу ничего не заказано. Сними галочку у строки, если реально должны —
                она останется долгом.</>
            : <>По заказу остались обязательства из сметы, не закрытые фактом — всего <b>{fmt(confirm.total)}</b>.
                Завершение считает расчёты законченными: остатки спишутся. Сними галочку у строки,
                если подрядчику действительно не заплачено — она останется долгом.</>}
          items={confirm.items} total={confirm.total} saving={saving}
          onConfirm={confirmClose} onCancel={() => setConfirm(null)}
        />
      )}

      <button type="button"
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
