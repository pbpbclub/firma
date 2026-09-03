/**
 * Окно «по заказу остались незакрытые обязательства» — одно на три двери:
 * завершение, отмена и архивация заказа (все отвечают 409 obligations_unpaid),
 * плюс плашки «закрыть по завершённым/отменённым/архивным» и «Закрыть выбранные»
 * в «Обязательствах».
 *
 * Юра решает построчно: галочка снята — строка остаётся долгом, подрядчику
 * действительно должны. Остальное закрывается с причиной, по которой откат
 * переоткроет ровно это.
 *
 * ТЗ 03.09.2026: закрытие меняет начисление в лицевом счёте (закрытая строка
 * начисляется покрытой частью, а не планом) — ручное закрытие «дублей» Малафеева
 * перевернуло его сальдо с «мы должны 87 100» на «должен отработать 24 400».
 * Поэтому окно ПОКАЗЫВАЕТ, как изменится сальдо каждого подрядчика
 * (POST /finance/creditors/close-preview), и при ручном закрытии даёт выбор:
 * списать прикидку (manual) или признать долг (recognized — начисление полной суммой).
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "../ui/Modal";
import { fmtMoneyDash as fmt } from "../ui/format";
import { financeApi } from "../../api";

export type Unpaid = {
  id: string; name: string; description?: string; plan: number; fact: number; debt: number;
  ambiguous?: boolean; order?: string;
  // по строке есть ручное начисление лицевого счёта — долг сверен там, остаток строки не вопрос
  recognized?: boolean; recognized_amount?: number;
};

export type LedgerDelta = {
  by_master: { master_id: string; name: string; balance_before: number; balance_after: number; delta: number }[];
  unbound: { id: string; name: string | null }[];
};

export type CloseReason = "manual" | "recognized";

export function ObligationsConfirmModal({
  eyebrow, saveLabel, intro, items, total, saving, onConfirm, onCancel,
  previewReason, initialDelta, reasonChoice = false,
}: {
  eyebrow: string;
  saveLabel: string;
  intro: ReactNode;
  items: Unpaid[];
  total: number;
  saving?: boolean;
  onConfirm: (closeIds: string[], reason: CloseReason) => void | Promise<void>;
  onCancel: () => void;
  // Причина закрытия для предпросмотра сальдо (order_completed | order_cancelled |
  // order_archived). При reasonChoice берётся выбор Юры: manual | recognized.
  previewReason?: string;
  initialDelta?: LedgerDelta;
  reasonChoice?: boolean;
}) {
  const [keepIds, setKeepIds] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState<CloseReason>("manual");
  const toggleKeep = (id: string) => setKeepIds(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const closing = items.filter(i => !keepIds.has(i.id));
  const writeOff = closing.filter(i => !i.recognized).reduce((s, i) => s + i.debt, 0);

  const effReason = reasonChoice ? reason : previewReason;
  const closingIds = closing.map(i => i.id);
  const preview = useQuery({
    queryKey: ["close-preview", closingIds.join(","), effReason],
    queryFn: () => financeApi.closePreview(closingIds, effReason as string),
    enabled: !!effReason && closingIds.length > 0,
    placeholderData: initialDelta,
  });
  const delta: LedgerDelta | undefined = preview.data ?? initialDelta;
  // Признать долг по строке, не привязанной к мастеру, нельзя — долг «в никуда».
  const unbound = reasonChoice && reason === "recognized" ? (delta?.unbound ?? []) : [];
  const canSave = closing.length > 0 && unbound.length === 0;

  const radio = (v: CloseReason, label: string, hint: string) => (
    <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", flex: 1, minWidth: 220,
                    padding: "9px 12px", border: `1px solid ${reason === v ? "#E8592A" : "#EDEBE6"}`,
                    background: reason === v ? "#FFF8F5" : "transparent" }}>
      <input type="radio" name="close-reason" checked={reason === v} onChange={() => setReason(v)}
             style={{ accentColor: "#E8592A", marginTop: 2 }} />
      <span>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A", display: "block" }}>{label}</span>
        <span style={{ fontSize: 11, color: "#6B6355", lineHeight: 1.4 }}>{hint}</span>
      </span>
    </label>
  );

  return (
    <Modal
      eyebrow={eyebrow}
      size="lg"
      onClose={onCancel}
      onCancel={onCancel}
      onSave={() => onConfirm(closingIds, reason)}
      saveLabel={saveLabel}
      saving={saving}
      canSave={canSave}
      footerLeft={
        <div style={{ fontSize: 12, color: "#6B6355" }}>
          {reasonChoice && reason === "recognized"
            ? <>Признаётся долгом: <b style={{ color: "#8B3A3A" }}>{fmt(closing.reduce((s, i) => s + i.debt, 0))}</b></>
            : <>Спишется: <b style={{ color: "#8B3A3A" }}>{fmt(writeOff)}</b></>}
          {keepIds.size > 0 && (
            <span style={{ color: "#A89070" }}> · остаётся открытым {fmt(total - writeOff)}</span>
          )}
        </div>
      }
    >
      <div style={{ padding: "18px 24px" }}>
        <div style={{ fontSize: 13, color: "#6B6355", lineHeight: 1.6, marginBottom: 14 }}>{intro}</div>

        {reasonChoice && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            {radio("manual", "Списать — прикидка не ждёт денег",
                   "Строка была планом; в лицевом счёте мастера останется только то, что реально прошло.")}
            {radio("recognized", "Работа принята — долг остаётся",
                   "Строка признаётся сверенной суммой: лицевой счёт начислит её целиком.")}
          </div>
        )}

        <div style={{ border: "1px solid #EDEBE6", maxHeight: 300, overflowY: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "26px 1fr 90px 90px 90px",
                        padding: "7px 12px", borderBottom: "1px solid #EDEBE6",
                        fontSize: 10, color: "#A89070", letterSpacing: "0.05em" }}>
            <div /><div>ОБЯЗАТЕЛЬСТВО</div>
            <div style={{ textAlign: "right" }}>ПЛАН</div>
            <div style={{ textAlign: "right" }}>ФАКТ</div>
            <div style={{ textAlign: "right" }}>{reasonChoice && reason === "recognized" ? "ДОЛГ" : "СПИСАТЬ"}</div>
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
                  {i.recognized && (
                    <div style={{ fontSize: 9, color: "#4A7C59", marginTop: 1 }}>
                      признано в лицевом счёте{i.recognized_amount ? `: ${fmt(i.recognized_amount)}` : ""} — сальдо не изменится
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "#6B6355", textAlign: "right" }}>{fmt(i.plan)}</div>
                <div style={{ fontSize: 12, color: i.fact > 0 ? "#4A7C59" : "#C8C0B0", textAlign: "right" }}>
                  {i.fact > 0 ? fmt(i.fact) : "—"}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, textAlign: "right",
                              color: keep ? "#C8C0B0" : i.recognized ? "#A89070" : "#8B3A3A" }}>
                  {keep ? "остаётся" : i.recognized ? "—" : fmt(i.debt)}
                </div>
              </div>
            );
          })}
        </div>

        {/* Как закрытие ляжет на сальдо подрядчиков — ДО кнопки, не после. */}
        {effReason && closing.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.05em", marginBottom: 6 }}>
              САЛЬДО ПОДРЯДЧИКОВ ПОСЛЕ ЗАКРЫТИЯ
            </div>
            {preview.isError && (
              <div style={{ fontSize: 11, color: "#8B3A3A" }}>Предпросмотр сальдо не отработал — закрывай с оглядкой на лицевые счета.</div>
            )}
            {!preview.isError && delta && delta.by_master.length === 0 && (
              <div style={{ fontSize: 11, color: "#6B6355" }}>
                Ни один лицевой счёт не изменится: строки не привязаны к мастерам (план закупок без исполнителя).
              </div>
            )}
            {delta?.by_master.map(m => {
              const flip = m.balance_before > 0.01 && m.balance_after < -0.01;
              const changed = Math.abs(m.delta) > 0.01;
              return (
                <div key={m.master_id} style={{ display: "flex", justifyContent: "space-between", gap: 12,
                                                padding: "6px 0", borderBottom: "1px solid #F2EFE9", fontSize: 12 }}>
                  <span style={{ color: "#1A1A1A" }}>
                    {m.name}
                    {flip && <span style={{ color: "#8B3A3A", fontWeight: 600 }}> · станет «должен отработать» — проверь</span>}
                  </span>
                  <span style={{ color: changed ? (flip ? "#8B3A3A" : "#6B6355") : "#A89070", whiteSpace: "nowrap" }}>
                    {fmt(m.balance_before)} → <b style={{ color: flip ? "#8B3A3A" : "#1A1A1A" }}>{fmt(m.balance_after)}</b>
                    {changed ? <span style={{ color: "#A89070" }}> ({m.delta > 0 ? "+" : "−"}{fmt(Math.abs(m.delta))})</span>
                             : <span style={{ color: "#A89070" }}> · без изменений</span>}
                  </span>
                </div>
              );
            })}
            {unbound.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 11, color: "#8B3A3A", lineHeight: 1.5 }}>
                Признать долгом нельзя: {unbound.map(u => `«${u.name ?? u.id}»`).join(", ")} не привязаны ни к одному
                мастеру — некому начислить. Укажи исполнителя в строке сметы или списывай.
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
