/**
 * «История» заказа — лента из журнала изменений (GET /orders/{id}/timeline).
 *
 * Источник — audit_log: summary там уже человекочитаемые («Утверждена смета…»,
 * «Платёж 103 925 ₽…»), их не переписываем. Блок свёрнут по умолчанию и грузит
 * данные только при раскрытии: история нужна не при каждом открытии карточки.
 *
 * Задел: сюда же вторым источником просится операционка агентов
 * (ops.py subject order:N) — отдельный заход, чтение Supabase из веб-бэка
 * требует своего разговора про надёжность.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CaretRight } from "@phosphor-icons/react";
import { ordersApi } from "../../api";
import { MONO } from "../ui/Num";

const ACTION_LABELS: Record<string, string> = {
  create: "создано",
  update: "правка",
  delete: "удалено",
  approve: "утверждение",
  status: "статус",
  close: "закрытие",
  move: "перенос",
  settle: "расчёты закрыты",
  unsettle: "расчёты открыты",
  archive: "в архив",
  unarchive: "из архива",
};

const ACTION_COLORS: Record<string, string> = {
  delete: "#8B3A3A",
  approve: "#4A7C59",
  status: "#E8592A",
  close: "#4A7C59",
  settle: "#4A7C59",
  archive: "#A89070",
};

export function OrderTimeline({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["order-timeline", orderId],
    queryFn: () => ordersApi.timeline(orderId),
    enabled: open,
  });
  const items: any[] = data?.items ?? [];

  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #EDEBE6" }}>
      <div
        onClick={() => setOpen(v => !v)}
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }}
      >
        <CaretRight size={11} style={{ color: "#A89070", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
        <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>ИСТОРИЯ</span>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          {isLoading ? (
            <div style={{ fontSize: 11, color: "#C8C0B0", padding: "6px 0" }}>Загружаем…</div>
          ) : items.length === 0 ? (
            <div style={{ fontSize: 11, color: "#C8C0B0", padding: "6px 0" }}>
              Журнал по этому заказу пуст — записи копятся с 05.08.2026.
            </div>
          ) : (
            items.map((ev: any, i: number) => (
              <div key={i} style={{ display: "flex", gap: 8, padding: "6px 0",
                borderBottom: i < items.length - 1 ? "1px solid #F2EFE9" : "none", alignItems: "baseline" }}>
                <span style={{ fontFamily: MONO, fontSize: 10, color: "#A89070", minWidth: 66, flexShrink: 0 }}>
                  {String(ev.created_at || "").slice(0, 10).split("-").reverse().slice(0, 2).join(".")}
                  {" "}{String(ev.created_at || "").slice(11, 16)}
                </span>
                <span style={{ fontSize: 9, color: ACTION_COLORS[ev.action] || "#A89070",
                  letterSpacing: "0.04em", minWidth: 68, flexShrink: 0, textTransform: "uppercase" }}>
                  {ACTION_LABELS[ev.action] || ev.action}
                </span>
                <span style={{ fontSize: 11, color: "#1A1A1A", lineHeight: 1.45 }}>{ev.summary}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
