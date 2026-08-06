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
import { ORDER_STATUSES } from "../domain";
import { Modal } from "../ui/Modal";
import { fmtMoneyDash as fmt } from "../ui/format";

type Unpaid = { id: string; name: string; description?: string; plan: number; fact: number; debt: number; ambiguous?: boolean };

export function StatusPicker({ orderId, current, onChange }: {
  orderId: string; current: string; onChange: (status: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<{ items: Unpaid[]; total: number } | null>(null);
  const [keepIds, setKeepIds] = useState<Set<string>>(new Set());
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
        setConfirm({ items: d.items || [], total: d.unpaid_total || 0 });
        setKeepIds(new Set());
      } else {
        throw err;
      }
    } finally {
      setSaving(false);
      setOpen(false);
    }
  };

  const confirmClose = async () => {
    if (!confirm) return;
    setSaving(true);
    try {
      // Закрываем только те, что Юра не оставил долгом
      const closeIds = confirm.items.filter(i => !keepIds.has(i.id)).map(i => i.id);
      await ordersApi.updateStatus(orderId, "completed", { close_obligations: true, only_ids: closeIds });
      onChange("completed");
      setConfirm(null);
    } finally {
      setSaving(false);
    }
  };

  const toggleKeep = (id: string) => setKeepIds(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  const writeOff = confirm ? confirm.items.filter(i => !keepIds.has(i.id)).reduce((s, i) => s + i.debt, 0) : 0;

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}
         onClick={e => e.stopPropagation()}>
      {confirm && (
        <Modal
          eyebrow="ЗАВЕРШИТЬ ЗАКАЗ"
          size="lg"
          onClose={() => setConfirm(null)}
          onCancel={() => setConfirm(null)}
          onSave={confirmClose}
          saveLabel="Завершить заказ"
          saving={saving}
          footerLeft={
            <div style={{ fontSize: 12, color: "#6B6355" }}>
              Спишется: <b style={{ color: "#8B3A3A" }}>{fmt(writeOff)}</b>
              {keepIds.size > 0 && (
                <span style={{ color: "#A89070" }}> · остаётся долгом {fmt(confirm.total - writeOff)}</span>
              )}
            </div>
          }
        >
        <div style={{ padding: "18px 24px" }}>
          <div style={{ fontSize: 13, color: "#6B6355", lineHeight: 1.6, marginBottom: 14 }}>
            По заказу остались обязательства из сметы, не закрытые фактом — всего <b>{fmt(confirm.total)}</b>.
            Завершение считает расчёты законченными: остатки спишутся. Сними галочку у строки,
            если подрядчику действительно не заплачено — она останется долгом.
          </div>
          <div style={{ border: "1px solid #EDEBE6", maxHeight: 260, overflowY: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: "26px 1fr 90px 90px 90px",
                          padding: "7px 12px", borderBottom: "1px solid #EDEBE6",
                          fontSize: 10, color: "#A89070", letterSpacing: "0.05em" }}>
              <div /><div>ОБЯЗАТЕЛЬСТВО</div>
              <div style={{ textAlign: "right" }}>ПЛАН</div>
              <div style={{ textAlign: "right" }}>ФАКТ</div>
              <div style={{ textAlign: "right" }}>СПИСАТЬ</div>
            </div>
            {confirm.items.map(i => {
              const keep = keepIds.has(i.id);
              return (
                <div key={i.id} style={{ display: "grid", gridTemplateColumns: "26px 1fr 90px 90px 90px",
                                         padding: "9px 12px", borderBottom: "1px solid #F2EFE9",
                                         alignItems: "center", opacity: keep ? 0.5 : 1 }}>
                  <input type="checkbox" checked={!keep} onChange={() => toggleKeep(i.id)}
                         style={{ accentColor: "#E8592A", cursor: "pointer" }} />
                  <div>
                    <div style={{ fontSize: 12, color: "#1A1A1A" }}>{i.name}</div>
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
      )}

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
