// «Чужие деньги» — транзит третьим лицам через личные карты (ТЗ Юры 23.09.2026).
// Помеченная нога не доход и не трата Юры: бэк выводит её из итогов «Грузии» и
// «Личных». Здесь — метка в ленте, окно пометки и блок «по человеку».
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { thirdPartyApi } from "../../api";
import { Modal } from "../ui/Modal";
import { MONO } from "../ui/Num";
import { fmtAmount } from "../ui/format";
import { debtColor } from "../ui/type";

export type ThirdPartyTx = {
  id: string; date?: string; payee?: string | null; comment?: string | null;
  income: number; outcome: number; income_currency?: string | null; outcome_currency?: string | null;
};

export function useThirdParty(enabled: boolean) {
  const { data } = useQuery({ queryKey: ["third-party"], queryFn: thirdPartyApi.list, enabled });
  const byTx = new Map<string, any>((data?.entries ?? []).map((e: any) => [String(e.tx_id), e]));
  return { byTx, people: (data?.people ?? []) as any[] };
}

/** Метка в строке ленты: «чужие · Жанна» либо тихая кнопка «чужие?». */
export function ThirdPartyTag({ mark, onOpen }: { mark?: any; onOpen: () => void }) {
  return (
    <button type="button" onClick={e => { e.stopPropagation(); onOpen(); }}
      title={mark ? "Чужие деньги — изменить пометку" : "Пометить как чужие деньги (транзит)"}
      style={{ background: "none", border: mark ? "1px solid #E6D6A8" : "none", padding: mark ? "1px 5px" : 0,
               fontFamily: "inherit", fontSize: 9, cursor: "pointer",
               color: mark ? "#B8860B" : "#C8C0B0", minHeight: 0 }}>
      {mark ? `чужие · ${mark.person}${mark.partial ? " (часть)" : ""}` : "чужие?"}
    </button>
  );
}

const inp: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "7px 9px", fontSize: 13,
                                   fontFamily: "inherit", border: "1px solid #EDEBE6" };
const lbl: React.CSSProperties = { fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 };

export function ThirdPartyModal({ tx, mark, people, onClose }: {
  tx: ThirdPartyTx; mark?: any; people: any[]; onClose: () => void;
}) {
  const qc = useQueryClient();
  const both = tx.income > 0 && tx.outcome > 0;
  const [person, setPerson] = useState<string>(mark?.person ?? "");
  const [direction, setDirection] = useState<string>(mark?.direction ?? (tx.income > 0 && !both ? "received" : "given"));
  const leg = direction === "received" ? tx.income : tx.outcome;
  const cur = direction === "received" ? tx.income_currency : tx.outcome_currency;
  const [amount, setAmount] = useState<string>(mark?.partial ? String(mark.amount) : "");
  const [amountRub, setAmountRub] = useState<string>(mark?.amount_rub && cur !== "RUB" ? String(mark.amount_rub) : "");
  const [note, setNote] = useState<string>(mark?.note ?? "");
  const [err, setErr] = useState<string>("");

  const done = () => {
    ["third-party", "zm-transactions", "zm-report", "zm-cashflow"].forEach(k =>
      qc.invalidateQueries({ queryKey: [k] }));
    ["region-tx", "region-stats", "region-summary"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));
    onClose();
  };
  const onErr = (e: any) => {
    const d = e?.response?.data?.detail;
    setErr(typeof d === "string" ? d : d?.message || "Не сохранилось");
  };
  const save = useMutation({
    mutationFn: () => thirdPartyApi.mark({
      tx_id: String(tx.id), person: person.trim(), direction,
      amount: amount ? Number(amount.replace(",", ".")) : null,
      amount_rub: amountRub ? Number(amountRub.replace(",", ".")) : null,
      note: note.trim() || null,
    }),
    onSuccess: done, onError: onErr,
  });
  const drop = useMutation({ mutationFn: () => thirdPartyApi.unmark(String(tx.id)), onSuccess: done, onError: onErr });

  return (
    <Modal size="sm" eyebrow="ЧУЖИЕ ДЕНЬГИ · ТРАНЗИТ" onClose={onClose}
      onCancel={onClose} onSave={() => save.mutate()} saving={save.isPending}
      canSave={!!person.trim()} saveLabel="Пометить"
      {...(mark ? { onDelete: () => drop.mutate(), deleteLabel: "Снять пометку" } : {})}>
      <div style={{ fontSize: 12, color: "#6B6355", marginBottom: 14, lineHeight: 1.5 }}>
        {String(tx.date || "").slice(0, 10)} · {tx.payee || tx.comment || "без получателя"}<br />
        Помеченная сумма не считается ни доходом, ни тратой — она уходит в расчёт с человеком.
      </div>
      <div style={lbl}>ЧЬИ ДЕНЬГИ</div>
      <input list="third-party-people" value={person} onChange={e => setPerson(e.target.value)}
        placeholder="Имя" style={{ ...inp, marginBottom: 12 }} autoFocus />
      <datalist id="third-party-people">
        {people.map(p => <option key={p.person} value={p.person} />)}
      </datalist>
      <div style={lbl}>ЧТО ЭТО</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {[["received", "Получено за него", tx.income], ["given", "Выдано ему", tx.outcome]].map(([k, l, v]) => (
          <button key={k as string} type="button" disabled={!(Number(v) > 0)} onClick={() => setDirection(k as string)}
            style={{ flex: 1, padding: "6px 8px", fontSize: 12, fontFamily: "inherit",
                     cursor: Number(v) > 0 ? "pointer" : "default", opacity: Number(v) > 0 ? 1 : 0.4,
                     border: `1px solid ${direction === k ? "#E8592A" : "#EDEBE6"}`,
                     background: direction === k ? "#FFF8F5" : "#FFFFFF", color: "#1A1A1A" }}>{l}</button>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        <div>
          <div style={lbl}>СУММА (ВСЯ — {fmtAmount(leg, cur)})</div>
          <input value={amount} onChange={e => setAmount(e.target.value)} placeholder="вся нога"
            inputMode="decimal" style={inp} />
        </div>
        {cur !== "RUB" && (
          <div>
            <div style={lbl}>В РУБЛЯХ</div>
            <input value={amountRub} onChange={e => setAmountRub(e.target.value)} placeholder="для остатка в ₽"
              inputMode="decimal" style={inp} />
          </div>
        )}
      </div>
      <div style={lbl}>ЗАМЕТКА</div>
      <input value={note} onChange={e => setNote(e.target.value)} style={inp} />
      {err && <div style={{ marginTop: 10, fontSize: 12, color: "#8B3A3A" }}>{err}</div>}
    </Modal>
  );
}

/** Расчёт по людям: получено за человека / выдано ему / остаток к выдаче. */
export function ThirdPartyBlock({ people }: { people: any[] }) {
  if (!people.length) return null;
  return (
    <div style={{ margin: "4px 0 18px" }}>
      <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>
        ЧУЖИЕ ДЕНЬГИ — НЕ ДОХОД И НЕ ТРАТА
      </div>
      {people.map(p => {
        // Остаток: > 0 — ещё должен отдать (наш долг, красный), < 0 — отдал лишнего (нам должны)
        const rub = p.balance_rub;
        return (
          <div key={p.person} style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", alignItems: "baseline",
                                       padding: "7px 0", borderBottom: "1px solid #F2EFE9", fontSize: 12 }}>
            <span style={{ color: "#1A1A1A", minWidth: 120 }}>{p.person}</span>
            {rub != null ? (
              <>
                <span style={{ color: "#6B6355" }}>получено <span style={{ fontFamily: MONO }}>{fmtAmount(p.received_rub, "RUB")}</span></span>
                <span style={{ color: "#6B6355" }}>выдано <span style={{ fontFamily: MONO }}>{fmtAmount(p.given_rub, "RUB")}</span></span>
                <span style={{ fontFamily: MONO, color: debtColor(Math.abs(rub), rub > 0 ? "out" : "in") }}>
                  {rub > 0 ? `отдать ещё ${fmtAmount(rub, "RUB")}` : rub < 0 ? `отдано лишнего ${fmtAmount(-rub, "RUB")}` : "в расчёте"}
                </span>
              </>
            ) : (
              p.by_currency.map((c: any) => (
                <span key={c.currency ?? "?"} style={{ color: "#6B6355" }}>
                  {c.currency ?? "валюта?"}: получено <span style={{ fontFamily: MONO }}>{fmtAmount(c.received, c.currency)}</span>
                  {" · "}выдано <span style={{ fontFamily: MONO }}>{fmtAmount(c.given, c.currency)}</span>
                </span>
              ))
            )}
            {rub == null && (
              <span style={{ fontSize: 10, color: "#B8860B" }}>остаток в ₽ — укажи рубли у выдач в валюте</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
