import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MONO } from "../components/ui/Num";
import { Modal } from "../components/ui/Modal";
import { fundsApi } from "../api";
import { Plus, Minus, Trash } from "@phosphor-icons/react";
import { ColumnFilter } from "../components/TableFilters";

const PRESET_COLORS = [
  "#E8592A", "#4A7C59", "#1A1A1A", "#A89070",
  "#8B3A3A", "#6B6355", "#3A5F8B", "#7C4A7C",
];

function fmt(n: number) {
  if (!n) return "0 ₽";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

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

  const { data: txs = [], refetch } = useQuery({
    queryKey: ["fund-txs-modal", fund.id],
    queryFn: () => fundsApi.transactions(fund.id),
  });
  const allTx = txs as any[];
  const noteOptions = [...new Set(allTx.map((t: any) => t.note).filter(Boolean))].sort() as string[];
  const txList = noteFilter ? allTx.filter((t: any) => t.note === noteFilter) : allTx;

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
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>Дата</div>
            <div><ColumnFilter label="Комментарий" options={noteOptions} value={noteFilter} onChange={setNoteFilter} /></div>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>Сумма</div>
            <div />
          </div>

          {/* История */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {txList.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 13 }}>Нет операций</div>
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
                  <button onClick={() => deleteTx(tx.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#D0C8C0", padding: 0, display: "flex" }}
                    onMouseEnter={e => (e.currentTarget.style.color = "#8B3A3A")}
                    onMouseLeave={e => (e.currentTarget.style.color = "#D0C8C0")}
                  ><Trash size={12} /></button>
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
        <div style={{ padding: 48, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>
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
