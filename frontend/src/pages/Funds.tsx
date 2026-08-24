import { fmtMoney as fmt } from "../components/ui/format";
import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Loading } from "../components/ui/Loading";
import { EmptyState } from "../components/ui/EmptyState";
import { MONO } from "../components/ui/Num";
import { Modal } from "../components/ui/Modal";
import { IconButton } from "../components/ui/IconButton";
import { fundsApi, accountableApi } from "../api";
import { Plus, Minus, Trash } from "@phosphor-icons/react";
import { ColumnFilter, AmountFilter, PeriodFilter } from "../components/TableFilters";

const PRESET_COLORS = [
  "#E8592A", "#4A7C59", "#1A1A1A", "#A89070",
  "#8B3A3A", "#6B6355", "#3A5F8B", "#7C4A7C",
];


function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

// ── Модал пополнения / списания ──────────────────────────────────────────────

function TxModal({ fund, mode, onClose, onDone }: {
  fund: any; mode: "deposit" | "withdraw"; onClose: () => void; onDone: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [note, setNote]     = useState("");
  const [date, setDate]     = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(false);
  const isDeposit = mode === "deposit";

  const submit = async () => {
    const val = parseFloat(amount.replace(/\s/g, "").replace(",", "."));
    if (!val || val <= 0) return;
    setLoading(true);
    try {
      if (isDeposit) await fundsApi.deposit(fund.id, { amount: val, note: note || undefined, date });
      else           await fundsApi.withdraw(fund.id, { amount: val, note: note || undefined, date });
      onDone(); onClose();
    } finally { setLoading(false); }
  };

  return (
    <Modal
      size="sm"
      eyebrow={(isDeposit ? "ПОПОЛНИТЬ" : "СПИСАТЬ") + " — " + fund.name}
      onClose={onClose}
      onCancel={onClose}
      onSave={submit}
      saveLabel={isDeposit ? "Пополнить" : "Списать"}
      saving={loading}
      canSave={!!amount}
    >
        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.05em", marginBottom: 4 }}>СУММА, ₽</div>
            <input autoFocus value={amount} onChange={e => setAmount(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()}
              placeholder="0"
              style={{ width: "100%", border: "1px solid #EDEBE6", padding: "8px 10px", fontSize: 18, fontWeight: 700, outline: "none", boxSizing: "border-box", textAlign: "right", color: isDeposit ? "#4A7C59" : "#8B3A3A" }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.05em", marginBottom: 4 }}>КОММЕНТАРИЙ</div>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Необязательно"
              style={{ width: "100%", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 12, outline: "none", boxSizing: "border-box" }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.05em", marginBottom: 4 }}>ДАТА</div>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              style={{ width: "100%", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 12, outline: "none", boxSizing: "border-box" }} />
          </div>
        </div>
    </Modal>
  );
}

// ── Модал истории фонда ──────────────────────────────────────────────────────

function FundDetailModal({ fund, onClose, onRefresh }: {
  fund: any; onClose: () => void; onRefresh: () => void;
}) {
  const qc = useQueryClient();
  const [txModal, setTxModal] = useState<"deposit" | "withdraw" | null>(null);
  const [noteFilter, setNoteFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [amtMin, setAmtMin] = useState("");
  const [amtMax, setAmtMax] = useState("");

  const { data: txs = [], refetch } = useQuery({
    queryKey: ["fund-txs-modal", fund.id],
    queryFn: () => fundsApi.transactions(fund.id),
  });
  const allTx = txs as any[];
  const noteOptions = [...new Set(allTx.map((t: any) => t.note).filter(Boolean))].sort() as string[];
  const txList = allTx.filter((t: any) => {
    if (noteFilter && t.note !== noteFilter) return false;
    if (dateFrom && (!t.date || t.date.slice(0, 10) < dateFrom)) return false;
    if (dateTo && (!t.date || t.date.slice(0, 10) > dateTo)) return false;
    if (amtMin && (t.amount || 0) < parseFloat(amtMin)) return false;
    if (amtMax && (t.amount || 0) > parseFloat(amtMax)) return false;
    return true;
  });

  const deleteTx = async (txId: string) => {
    await fundsApi.deleteTx(txId);
    refetch();
    qc.invalidateQueries({ queryKey: ["funds"] });
    onRefresh();
  };

  const handleTxDone = () => {
    refetch();
    qc.invalidateQueries({ queryKey: ["funds"] });
    onRefresh();
  };

  return (
    <>
      <Modal size="lg" eyebrow="ФОНД" onClose={onClose}>

          {/* Шапка */}
          <div style={{ padding: "18px 24px", borderBottom: "1px solid #EDEBE6", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 10, height: 10, background: fund.color, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A" }}>{fund.name}</div>
              {fund.description && <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>{fund.description}</div>}
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.05em", marginBottom: 2 }}>БАЛАНС</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: fund.balance > 0 ? "#1A1A1A" : "#C8C0B0", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(fund.balance)}</div>
            </div>
          </div>

          {/* Кнопки действий */}
          <div style={{ padding: "12px 24px", borderBottom: "1px solid #EDEBE6", display: "flex", gap: 8 }}>
            <button
              onClick={() => setTxModal("deposit")}
              style={{ padding: "6px 14px", border: "1px solid #EDEBE6", background: "transparent", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "#4A7C59", display: "flex", alignItems: "center", gap: 5 }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#F0F7F2"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              <Plus size={11} /> Пополнить
            </button>
            <button
              onClick={() => setTxModal("withdraw")}
              style={{ padding: "6px 14px", border: "1px solid #EDEBE6", background: "transparent", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "#8B3A3A", display: "flex", alignItems: "center", gap: 5 }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#FBF3F3"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              <Minus size={11} /> Списать
            </button>
          </div>

          {/* Заголовок таблицы */}
          <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 120px 28px", padding: "7px 24px", borderBottom: "1px solid #EDEBE6" }}>
            <div><PeriodFilter label="Дата" from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} /></div>
            <div><ColumnFilter label="Комментарий" options={noteOptions} value={noteFilter} onChange={setNoteFilter} /></div>
            <div><AmountFilter label="Сумма" min={amtMin} max={amtMax} onChange={(mn, mx) => { setAmtMin(mn); setAmtMax(mx); }} align="right" /></div>
            <div />
          </div>

          {/* История */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {txList.length === 0 ? (
              <EmptyState title="Нет операций" />
            ) : (
              txList.map((tx: any) => (
                <div key={tx.id}
                  style={{ display: "grid", gridTemplateColumns: "110px 1fr 120px 28px", padding: "10px 24px", borderBottom: "1px solid #F2EFE9", alignItems: "center" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <div style={{ fontSize: 12, color: "#A89070" }}>{fmtDate(tx.date)}</div>
                  <div style={{ fontSize: 13, color: "#1A1A1A" }}>{tx.note || <span style={{ color: "#C8C0B0" }}>—</span>}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: tx.direction === "in" ? "#4A7C59" : "#8B3A3A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                    {tx.direction === "in" ? "+" : "−"}{fmt(tx.amount)}
                  </div>
                  <IconButton icon={Trash} title="Удалить операцию" tone="danger" size={22} iconSize={12} color="#D0C8C0" onClick={() => deleteTx(tx.id)} />
                </div>
              ))
            )}
          </div>
      </Modal>

      {txModal && (
        <TxModal fund={fund} mode={txModal} onClose={() => setTxModal(null)} onDone={handleTxDone} />
      )}
    </>
  );
}

// ── Модал создания нового фонда ──────────────────────────────────────────────

function CreateFundModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName]         = useState("");
  const [desc, setDesc]         = useState("");
  const [color, setColor]       = useState(PRESET_COLORS[0]);
  const [loading, setLoading]   = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setLoading(true);
    try {
      await fundsApi.create({ name: name.trim(), description: desc.trim() || undefined, color });
      onDone(); onClose();
    } finally { setLoading(false); }
  };

  return (
    <Modal
      size="sm"
      eyebrow="НОВЫЙ ФОНД"
      onClose={onClose}
      onCancel={onClose}
      onSave={submit}
      saveLabel="Создать"
      saving={loading}
      canSave={!!name.trim()}
    >
        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.05em", marginBottom: 4 }}>НАЗВАНИЕ</div>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()}
              placeholder="Например: Резервный"
              style={{ width: "100%", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.05em", marginBottom: 4 }}>ОПИСАНИЕ</div>
            <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Необязательно"
              style={{ width: "100%", border: "1px solid #EDEBE6", padding: "7px 10px", fontSize: 12, outline: "none", boxSizing: "border-box" }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.05em", marginBottom: 8 }}>ЦВЕТ</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {PRESET_COLORS.map(c => (
                <button key={c} onClick={() => setColor(c)}
                  style={{
                    width: 28, height: 28, background: c, border: "none", cursor: "pointer",
                    outline: color === c ? `2px solid ${c}` : "none",
                    outlineOffset: 2,
                    opacity: color === c ? 1 : 0.5,
                    transition: "opacity 0.1s",
                  }} />
              ))}
            </div>
          </div>
        </div>

    </Modal>
  );
}

// ── Под отчётом ──────────────────────────────────────────────────────────────
function AccountableSection() {
  const qc = useQueryClient();
  const { data: people = [] } = useQuery({ queryKey: ["accountable"], queryFn: accountableApi.list });
  const [opFor, setOpFor] = useState<{ person: any; kind: "issue" | "return" } | null>(null);
  const [histFor, setHistFor] = useState<any>(null);
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);

  const [unlinkedWarn, setUnlinkedWarn] = useState(false);

  const { data: hist } = useQuery({
    queryKey: ["accountable-ops", histFor?.id],
    queryFn: () => accountableApi.ops(histFor!.id),
    enabled: !!histFor,
  });

  const delOp = useMutation({
    mutationFn: (opId: string) => accountableApi.deleteOp(opId),
    onSuccess: (res: any) => {
      // fund_unlinked — у операции не нашлось парного движения кассы (заведена до
      // появления связи либо шла мимо кассы). Молчать нельзя: остаток мог поехать.
      setUnlinkedWarn(!!res?.fund_unlinked);
      qc.invalidateQueries({ queryKey: ["accountable"] });
      qc.invalidateQueries({ queryKey: ["accountable-ops", histFor?.id] });
      qc.invalidateQueries({ queryKey: ["funds"] });
    },
  });

  const doOp = async () => {
    const a = parseFloat(amount);
    if (!opFor || !a || a <= 0) return;
    setSaving(true);
    try {
      await accountableApi.addOp(opFor!.person.id, { kind: opFor!.kind, amount: a });
      qc.invalidateQueries({ queryKey: ["accountable"] });
      qc.invalidateQueries({ queryKey: ["funds"] });
      setOpFor(null); setAmount("");
    } finally { setSaving(false); }
  };

  if (!(people as any[]).length) return null;
  return (
    <div style={{ padding: "20px 28px", borderBottom: "1px solid #EDEBE6" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>ПОД ОТЧЁТОМ</div>
        <div style={{ fontSize: 10, color: "#C8C0B0" }}>выдача — не расход по заказу; расход появится при оплате поставщику</div>
      </div>
      {(people as any[]).map((p: any) => (
        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "9px 0", borderBottom: "1px solid #F2EFE9" }}>
          <button onClick={() => setHistFor(p)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 13, color: "#1A1A1A", textDecoration: "underline", textDecorationColor: "#EDEBE6", fontFamily: "inherit" }}>
            {p.name}
          </button>
          <span style={{ fontSize: 10, color: "#A89070" }}>на руках</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: p.balance > 0 ? "#E8592A" : "#1A1A1A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(p.balance)}</span>
          <div style={{ flex: 1 }} />
          {opFor?.person.id === p.id ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 10, color: "#A89070" }}>{opFor!.kind === "issue" ? "Выдать из кассы:" : "Возврат в кассу:"}</span>
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)} autoFocus
                style={{ width: 100, border: "1px solid #EDEBE6", padding: "4px 8px", fontSize: 12, outline: "none", textAlign: "right", fontFamily: MONO }} />
              <button disabled={saving || !parseFloat(amount)} onClick={doOp}
                style={{ fontSize: 11, padding: "4px 12px", border: "none", background: "#E8592A", color: "#fff", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>
                {saving ? "..." : "OK"}
              </button>
              <button onClick={() => { setOpFor(null); setAmount(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 2 }}>✕</button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setOpFor({ person: p, kind: "issue" })}
                style={{ fontSize: 11, padding: "4px 10px", border: "1px solid #EDEBE6", background: "transparent", color: "#4A7C59", cursor: "pointer", fontFamily: "inherit" }}>
                Выдать из кассы
              </button>
              <button onClick={() => setOpFor({ person: p, kind: "return" })} disabled={p.balance <= 0}
                style={{ fontSize: 11, padding: "4px 10px", border: "1px solid #EDEBE6", background: "transparent", color: p.balance > 0 ? "#8B3A3A" : "#C8C0B0", cursor: p.balance > 0 ? "pointer" : "default", fontFamily: "inherit" }}>
                Возврат в кассу
              </button>
            </div>
          )}
        </div>
      ))}

      {/* История операций лица */}
      {histFor && (
        <Modal size="md" eyebrow={`ПОД ОТЧЁТОМ · ${histFor.name.toUpperCase()}`} onClose={() => { setHistFor(null); setUnlinkedWarn(false); }} onCancel={() => { setHistFor(null); setUnlinkedWarn(false); }}>
          <div style={{ padding: "16px 24px 20px" }}>
            <div style={{ fontSize: 12, color: "#6B6355", marginBottom: 12 }}>
              На руках: <span style={{ fontFamily: MONO, fontWeight: 700, color: "#1A1A1A" }}>{fmt(hist?.balance ?? histFor.balance)}</span>
            </div>
            {(hist?.ops ?? []).map((o: any) => (
              <div key={o.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "7px 0", borderBottom: "1px solid #F2EFE9", fontSize: 12 }}>
                <span style={{ color: "#A89070", fontFamily: MONO }}>{o.date}</span>
                <span style={{ flex: 1, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.note || (o.kind === "issue" ? "Выдача" : "Возврат")}</span>
                <span style={{ fontFamily: MONO, fontWeight: 600, color: o.kind === "issue" ? "#4A7C59" : "#8B3A3A" }}>
                  {o.kind === "issue" ? "+" : "−"}{fmt(o.amount)}
                </span>
                {/* Удаление сносит и парное движение кассы (fund_transactions.
                    accountable_op_id) — иначе «на руках» и остаток кассы разъезжались. */}
                <button onClick={() => delOp.mutate(o.id)} disabled={delOp.isPending}
                  title="Удалить операцию — вместе с её движением кассы"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: "2px 4px", display: "flex" }}>
                  <Trash size={12} />
                </button>
              </div>
            ))}
            {unlinkedWarn && (
              <div style={{ marginTop: 10, padding: "9px 11px", background: "#FFF4EE", borderLeft: "2px solid #E8592A",
                            fontSize: 11, color: "#6B6355", lineHeight: 1.6 }}>
                Операция удалена, но парного движения кассы у неё не нашлось — она заведена
                до того, как появилась связь. Если та выдача шла через кассу, поправь остаток
                вручную в списке фондов.
              </div>
            )}
            {(hist?.expenses ?? []).map((e: any) => (
              <div key={e.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", borderBottom: "1px solid #F2EFE9", fontSize: 12 }}>
                <span style={{ color: "#A89070", fontFamily: MONO }}>{e.date}</span>
                <span style={{ flex: 1, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Оплата: {e.title}</span>
                <span style={{ fontFamily: MONO, fontWeight: 600, color: "#8B3A3A" }}>−{fmt(e.amount)}</span>
              </div>
            ))}
            {!(hist?.ops ?? []).length && !(hist?.expenses ?? []).length && (
              <div style={{ fontSize: 12, color: "#C8C0B0" }}>Операций нет</div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Главная страница ─────────────────────────────────────────────────────────

export default function Funds() {
  const qc = useQueryClient();
  const [detailFund, setDetailFund] = useState<any>(null);
  const [txModal, setTxModal]       = useState<{ fund: any; mode: "deposit" | "withdraw" } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const { data: funds = [], isLoading, refetch } = useQuery({
    queryKey: ["funds"],
    queryFn: fundsApi.list,
  });

  const fundList     = funds as any[];
  const totalBalance = fundList.reduce((s: number, f: any) => s + (f.balance || 0), 0);

  const refresh = () => {
    refetch();
    qc.invalidateQueries({ queryKey: ["transactions"] });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>

      {/* Header */}
      <div style={{ padding: "24px 28px 20px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Фонды</div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 2 }}>ВСЕГО В ФОНДАХ</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#1A1A1A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(totalBalance)}</div>
          </div>
          <button
            onClick={() => setCreateOpen(true)}
            style={{ padding: "7px 14px", background: "#E8592A", border: "none", color: "#FFFFFF", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
          >
            <Plus size={12} /> Новый фонд
          </button>
        </div>
      </div>

      {isLoading ? (
        <Loading />
      ) : fundList.length === 0 ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, color: "#A89070", fontSize: 13 }}>
          <div>Фондов нет — создайте первый</div>
          <button onClick={() => setCreateOpen(true)} style={{ padding: "7px 16px", background: "#E8592A", border: "none", color: "#FFFFFF", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            + Создать фонд
          </button>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto" }}>
          {/* Карточки фондов */}
          <div style={{
            display: "grid",
            gridTemplateColumns: `repeat(${Math.min(fundList.length, 4)}, 1fr)`,
            borderBottom: "1px solid #EDEBE6",
          }}>
            {fundList.map((f: any) => (
              <div key={f.id} style={{ padding: "20px 24px", borderRight: "1px solid #EDEBE6", boxSizing: "border-box" }}>

                {/* Название — кликабельное */}
                <button
                  onClick={() => setDetailFund(f)}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, marginBottom: 10, width: "100%", textAlign: "left" }}
                >
                  <div style={{ width: 8, height: 8, background: f.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#6B6355", letterSpacing: "0.02em", textDecoration: "underline", textDecorationColor: "#EDEBE6" }}>
                    {f.name.toUpperCase()}
                  </span>
                  {f.kind === "cash" && (
                    <span title="Физические наличные — вне банковских счетов, из свободных денег банка не вычитается"
                      style={{ fontSize: 9, color: "#A89070", background: "#F2EFE9", padding: "1px 5px", flexShrink: 0 }}>вне банка</span>
                  )}
                </button>

                <div style={{ fontSize: 22, fontWeight: 700, color: f.balance > 0 ? "#1A1A1A" : "#C8C0B0", letterSpacing: "-0.02em", marginBottom: 12, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                  {fmt(f.balance)}
                </div>

                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => setTxModal({ fund: f, mode: "deposit" })}
                    style={{ flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, border: "1px solid #EDEBE6", background: "transparent", color: "#4A7C59", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#F0F7F2"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                  >
                    <Plus size={10} /> Пополнить
                  </button>
                  <button
                    onClick={() => setTxModal({ fund: f, mode: "withdraw" })}
                    style={{ flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, border: "1px solid #EDEBE6", background: "transparent", color: "#8B3A3A", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#FBF3F3"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                  >
                    <Minus size={10} /> Списать
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Под отчётом: доверенные лица с выданными наличными на руках.
              Выдача — НЕ расход по заказу; расход возникает при их оплате
              поставщику (ExpenseModal → «Через подотчётника»). */}
          <AccountableSection />
        </div>
      )}

      {/* Модал: история фонда */}
      {detailFund && (
        <FundDetailModal
          fund={fundList.find((f: any) => f.id === detailFund.id) ?? detailFund}
          onClose={() => setDetailFund(null)}
          onRefresh={refresh}
        />
      )}

      {/* Модал: быстрое пополнение/списание с карточки */}
      {txModal && (
        <TxModal
          fund={txModal.fund}
          mode={txModal.mode}
          onClose={() => setTxModal(null)}
          onDone={refresh}
        />
      )}

      {/* Модал: создать фонд */}
      {createOpen && (
        <CreateFundModal
          onClose={() => setCreateOpen(false)}
          onDone={refresh}
        />
      )}
    </div>
  );
}
