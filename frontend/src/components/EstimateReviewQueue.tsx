// Очередь «Сметы к утверждению»: draft-сметы живых заказов (в т.ч. созданные
// финагентом) с дельтой «план заказа сейчас → станет после approve».
// Рендерится вкладкой-режимом внутри страницы Заказов (OrdersV2).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { estimatesApi } from "../api";
import { Loading } from "./ui/Loading";
import { EmptyState } from "./ui/EmptyState";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { MONO } from "./ui/Num";
import { fmtMoney, fmtDate } from "./ui/format";
import { Warning } from "@phosphor-icons/react";

const COLS = "28px 1.7fr 1.5fr 110px 110px 170px 165px";

function Delta({ value }: { value: number }) {
  if (!value) return <span style={{ color: "#A89070" }}>без изменений</span>;
  const up = value > 0;
  return (
    <span style={{ color: up ? "#4A7C59" : "#8B3A3A", fontWeight: 600 }}>
      {up ? "+" : ""}{fmtMoney(value)}
    </span>
  );
}

export function EstimateReviewQueue() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["estimates-review-queue"],
    queryFn: estimatesApi.reviewQueue,
  });
  const sets: any[] = data?.sets ?? [];

  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [forceSet, setForceSet] = useState<any>(null);   // сет без продажных цен: approve только через отдельный confirm
  const [busy, setBusy] = useState<string | null>(null); // set_id или "bulk"
  const [errors, setErrors] = useState<string[]>([]);

  const invalidate = () => {
    ["orders-v2", "orders-plan-fact-summary", "estimates-review-queue", "order-detail", "order-detail-v2", "order-estimates"]
      .forEach(k => qc.invalidateQueries({ queryKey: [k] }));
  };

  const approve = async (s: any, force = false) => {
    setBusy(s.set_id);
    try {
      await estimatesApi.approveSet(s.set_id, force);
      setSel(prev => { const n = new Set(prev); n.delete(s.set_id); return n; });
      invalidate();
    } catch (e: any) {
      setErrors([`${s.order_title}: ${e?.response?.data?.detail || e.message}`]);
    } finally {
      setBusy(null);
    }
  };

  const chosen = sets.filter(s => sel.has(s.set_id));
  const bulkApprove = async () => {
    setConfirmBulk(false);
    setBusy("bulk");
    const errs: string[] = [];
    for (const s of chosen) {
      try {
        await estimatesApi.approveSet(s.set_id);
      } catch (e: any) {
        errs.push(`${s.order_title}: ${e?.response?.data?.detail || e.message}`);
      }
    }
    setBusy(null);
    setErrors(errs);
    setSel(new Set());
    invalidate();
  };

  const toggle = (s: any) => {
    setSel(prev => {
      const n = new Set(prev);
      if (n.has(s.set_id)) { n.delete(s.set_id); return n; }
      // Одна активная смета на заказ: второй сет того же заказа выбрать нельзя
      // (approve первого отправит его в superseded).
      for (const other of sets) {
        if (other.order_id === s.order_id && n.has(other.set_id)) return n;
      }
      n.add(s.set_id);
      return n;
    });
  };

  if (isLoading) return <Loading compact />;
  if (!sets.length) {
    return <EmptyState compact title="Все сметы утверждены" hint="Черновиков, ждущих решения, нет" />;
  }

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "8px 28px 24px" }}>
      {/* Сводка + массовое действие */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0 12px" }}>
        <div style={{ fontSize: 11, color: "#6B6355" }}>
          {sets.length} черновиков ждут решения
          {chosen.length > 0 && (
            <span style={{ color: "#E8592A", fontWeight: 600 }}>
              {" "}· выбрано {chosen.length} на {fmtMoney(chosen.reduce((t, s) => t + s.set_price, 0))}
            </span>
          )}
        </div>
        <Button variant="primary" size="sm" disabled={!chosen.length || busy !== null} onClick={() => setConfirmBulk(true)}>
          {busy === "bulk" ? "Утверждаем..." : `Утвердить выбранные${chosen.length ? ` (${chosen.length})` : ""}`}
        </Button>
      </div>

      {errors.length > 0 && (
        <div style={{ background: "#FFF8F5", border: "1px solid #EDEBE6", padding: "10px 14px", marginBottom: 12, fontSize: 11, color: "#8B3A3A" }}>
          {errors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}

      {/* Шапка таблицы */}
      <div style={{ display: "grid", gridTemplateColumns: COLS, gap: "0 14px", padding: "8px 0",
        borderBottom: "1px solid #EDEBE6", fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>
        <span />
        <span>ЗАКАЗ</span>
        <span>СМЕТА</span>
        <span style={{ textAlign: "right" }}>СЕБЕСТ.</span>
        <span style={{ textAlign: "right" }}>ПРОДАЖА</span>
        <span style={{ textAlign: "right" }}>ЦЕНА ЗАКАЗА → СТАНЕТ</span>
        <span />
      </div>

      {sets.map(s => {
        const noPrices = s.set_price <= 0;
        const noLines = s.lines_count === 0;
        const orderTaken = !sel.has(s.set_id) && sets.some(o => o.order_id === s.order_id && o.set_id !== s.set_id && sel.has(o.set_id));
        const payLabel = s.payment_type === "bank" ? `Безнал ${s.bank_pct ?? 13}%` : "Нал";
        return (
          <div key={s.set_id} style={{ display: "grid", gridTemplateColumns: COLS, gap: "0 14px", padding: "12px 0",
            borderBottom: "1px solid #F2EFE9", alignItems: "center",
            opacity: orderTaken ? 0.45 : 1 }}>
            {/* чекбокс */}
            <div
              onClick={() => { if (!noPrices && !orderTaken) toggle(s); }}
              title={noPrices ? "Без продажных цен — только поштучно, с подтверждением" : orderTaken ? "Уже выбрана другая смета этого заказа" : undefined}
              style={{
                width: 14, height: 14, cursor: noPrices || orderTaken ? "default" : "pointer",
                border: `1.5px solid ${sel.has(s.set_id) ? "#E8592A" : "#D0C8C0"}`,
                background: sel.has(s.set_id) ? "#E8592A" : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              {sel.has(s.set_id) && <svg width="8" height="6" viewBox="0 0 8 6" fill="none"><path d="M1 3L3 5.5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </div>
            {/* заказ */}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {s.order_title}
              </div>
              <div style={{ fontSize: 9, color: "#A89070", marginTop: 2, fontFamily: MONO }}>
                {s.order_number}{s.customer_name ? ` · ${s.customer_name}` : ""}
              </div>
            </div>
            {/* смета */}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, color: "#1A1A1A", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {s.set_title || "Смета"} <span style={{ color: "#A89070" }}>· {fmtDate(s.set_created_at, false)}</span>
              </div>
              <div style={{ fontSize: 9, color: "#A89070", marginTop: 2, display: "flex", alignItems: "center", gap: 5 }}>
                {payLabel} · {s.items_count} поз. · {s.lines_count} строк
                {noLines && (
                  <span title="Смета без строк детализации: обязательства создадутся крупно, по позициям" style={{ color: "#E8592A", display: "inline-flex", alignItems: "center", gap: 2 }}>
                    <Warning size={11} /> без строк
                  </span>
                )}
              </div>
            </div>
            <span style={{ textAlign: "right", fontSize: 12, color: "#6B6355", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
              {fmtMoney(s.set_cost)}
            </span>
            <span style={{ textAlign: "right", fontSize: 12, fontFamily: MONO, fontVariantNumeric: "tabular-nums",
              color: noPrices ? "#8B3A3A" : "#1A1A1A", fontWeight: noPrices ? 600 : 400 }}
              title={noPrices ? "В смете нет продажных цен — утверждение обнулит цену заказа" : undefined}>
              {noPrices ? "0 ₽ ⚠" : fmtMoney(s.set_price)}
            </span>
            <div style={{ textAlign: "right", fontSize: 11, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
              <div style={{ color: "#6B6355" }}>{fmtMoney(s.price_plan_now)} → {fmtMoney(s.set_price)}</div>
              <div style={{ marginTop: 2 }}><Delta value={s.price_delta} /></div>
            </div>
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <Button size="sm" onClick={() => navigate(`/orders/${s.order_id}/estimate`)}>Открыть</Button>
              <Button size="sm" variant="primary" disabled={busy !== null}
                onClick={() => (noPrices ? setForceSet(s) : approve(s))}>
                {busy === s.set_id ? "..." : "Утвердить"}
              </Button>
            </div>
          </div>
        );
      })}

      <div style={{ fontSize: 10, color: "#A89070", marginTop: 12, lineHeight: 1.5 }}>
        Утверждение фиксирует смету (правки — только новой версией), пересчитывает цену и
        себестоимость заказа и создаёт обязательства перед исполнителями. Прочие сметы заказа
        уходят в «Заменена».
      </div>

      {/* Массовое подтверждение */}
      {confirmBulk && (
        <Modal size="md" eyebrow="УТВЕРЖДЕНИЕ СМЕТ" onClose={() => setConfirmBulk(false)}
          onCancel={() => setConfirmBulk(false)} onSave={bulkApprove} saveLabel={`Утвердить ${chosen.length}`}>
          <div style={{ padding: "18px 24px" }}>
            <div style={{ fontSize: 13, color: "#1A1A1A", marginBottom: 14 }}>
              Сметы будут зафиксированы, цены заказов пересчитаны, обязательства созданы:
            </div>
            {chosen.map(s => (
              <div key={s.set_id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0",
                borderBottom: "1px solid #F2EFE9", fontSize: 12 }}>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.order_title}</span>
                <span style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                  {fmtMoney(s.price_plan_now)} → {fmtMoney(s.set_price)}{" "}
                  <Delta value={s.price_delta} />
                </span>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {/* Force-подтверждение для сметы без продажных цен */}
      {forceSet && (
        <Modal size="sm" eyebrow="СМЕТА БЕЗ ЦЕН" onClose={() => setForceSet(null)}
          onCancel={() => setForceSet(null)}
          onSave={() => { const s = forceSet; setForceSet(null); approve(s, true); }}
          saveLabel="Всё равно утвердить">
          <div style={{ padding: "18px 24px", fontSize: 13, lineHeight: 1.5, color: "#1A1A1A" }}>
            В смете «{forceSet.order_title}» нет продажных цен — после утверждения цена заказа
            станет 0 ₽. Обычно сначала заполняют продажу в редакторе сметы.
          </div>
        </Modal>
      )}
    </div>
  );
}
