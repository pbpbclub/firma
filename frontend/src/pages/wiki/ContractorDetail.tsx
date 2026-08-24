import { useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MONO } from "../../components/ui/Num";
import { useNavigationGuard, NavigationGuardModal } from "../../components/NavigationGuard";
import { EditModal, type FieldDef } from "../../components/EditModal";
import { PayeeRulesSection } from "../../components/PayeeRulesSection";
import { useNavigate } from "react-router-dom";
import { mastersApi, financeApi, ledgerApi, ordersApi } from "../../api";
import { ContactStrip, contactHref } from "../../components/ui/ContactLinks";
import { PriceSync } from "./SupplierDetail";
import { Check, User, HandCoins, ArrowsLeftRight, Receipt } from "@phosphor-icons/react";
import { fmt, fmtDate } from "./helpers";
import { DetailRow as Row } from "./DetailRow";
import { DetailShell, DetailSection, NoteBlock, type DetailMetric } from "./DetailShell";
import { Modal } from "../../components/ui/Modal";

const LEDGER_ACTIONS = {
  advance: {
    label: "Выдать аванс", eyebrow: "АВАНС ПОДРЯДЧИКУ",
    hint: "Деньги ушли подрядчику вперёд. Пока заказ не указан — это просто минус по лицевому счёту; укажешь заказ, и аванс закроет обязательство по нему.",
  },
  third_party: {
    label: "Оплатить за него", eyebrow: "ОПЛАТА ЗА ПОДРЯДЧИКА",
    hint: "Мы заплатили третьему лицу по его просьбе (скань, ткань для его заказа). Деньги наши, себестоимость — не наша, пока не привяжешь к заказу.",
  },
  offset: {
    label: "Провести зачёт", eyebrow: "ВЗАИМОЗАЧЁТ",
    hint: "Денег не было: встречные работы гасят наш долг. С заказом — закроет обязательство и поднимет себестоимость заказа.",
  },
} as const;
type LedgerAction = keyof typeof LEDGER_ACTIONS;

function ActionChip({ icon, label, onClick }:
  { icon: ReactNode; label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, lineHeight: 1,
        padding: "5px 10px", cursor: "pointer", fontFamily: "inherit",
        border: `1px solid ${hover ? "#E8592A" : "#EDEBE6"}`,
        background: hover ? "#FFF4EE" : "#fff", color: hover ? "#E8592A" : "#6B6355",
      }}>
      {icon} {label}
    </button>
  );
}

const lgInp: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6",
  padding: "7px 10px", fontSize: 12, outline: "none", background: "transparent", color: "#1A1A1A",
};
const lgLbl: React.CSSProperties = { fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 };

/** Аванс / оплата за подрядчика / зачёт — из карточки подрядчика.
 *
 *  Второй вход в тот же механизм, что «ЧЕМ ЗАКРЫТО» в форме расхода: при указанном
 *  заказе бэк создаёт РАСХОД ПО ЗАКАЗУ (settled_by), а не строку регистра. Поэтому
 *  два экрана не могут разъехаться — пишут в одну таблицу. */
function LedgerActionModal({ action, master, creditors, onClose, onDone }: {
  action: LedgerAction; master: any; creditors: any[];
  onClose: () => void; onDone: () => void;
}) {
  const cfg = LEDGER_ACTIONS[action];
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [orderId, setOrderId] = useState("");
  const [creditorId, setCreditorId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const { data: orders = [] } = useQuery({ queryKey: ["orders-lite"], queryFn: () => ordersApi.list() });
  // Обязательства только выбранного заказа: чужое бэк и так отвергнет (400),
  // но показывать его в списке — приглашение к ошибке.
  const orderCreditors = creditors.filter(
    (c: any) => orderId && String(c.order_id) === String(orderId) && c.status !== "closed" && c.status !== "cancelled");

  const amountNum = parseFloat(amount);
  const valid = !isNaN(amountNum) && amountNum > 0;

  const save = useMutation({
    mutationFn: () => {
      const base: Record<string, any> = {
        master_id: master.id, amount: amountNum,
        order_id: orderId || null, creditor_id: creditorId || null,
        note: note.trim() || null,
      };
      return action === "offset"
        ? ledgerApi.offset({ ...base, happened_at: date })
        : ledgerApi.contractorPay({ ...base, kind: action, expense_date: date, category: "work" });
    },
    onSuccess: () => { onDone(); onClose(); },
    onError: (e: any) => setError(e?.response?.data?.detail || "Не удалось сохранить"),
  });

  return (
    <Modal size="md" eyebrow={`${cfg.eyebrow} · ${master.name}`} onClose={onClose} onCancel={onClose}
           onSave={() => valid && save.mutate()} canSave={valid} saving={save.isPending} saveLabel="Провести">
      <div style={{ fontSize: 11, color: "#6B6355", lineHeight: 1.6, marginBottom: 14 }}>{cfg.hint}</div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <div style={lgLbl}>СУММА ₽</div>
          <input style={lgInp} value={amount} onChange={e => setAmount(e.target.value)} autoFocus placeholder="0" />
        </div>
        <div>
          <div style={lgLbl}>ДАТА</div>
          <input style={lgInp} type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={lgLbl}>ЗАКАЗ — НЕОБЯЗАТЕЛЬНО</div>
        <select style={{ ...lgInp, cursor: "pointer" }} value={orderId}
                onChange={e => { setOrderId(e.target.value); setCreditorId(""); }}>
          <option value="">— только лицевой счёт, себестоимость не трогаем —</option>
          {(orders as any[]).map((o: any) => <option key={o.id} value={o.id}>{o.title}</option>)}
        </select>
      </div>

      {orderId && (
        <div style={{ marginTop: 14 }}>
          <div style={lgLbl}>ОБЯЗАТЕЛЬСТВО — НЕОБЯЗАТЕЛЬНО</div>
          <select style={{ ...lgInp, cursor: "pointer" }} value={creditorId} onChange={e => setCreditorId(e.target.value)}>
            <option value="">— не привязывать —</option>
            {orderCreditors.map((c: any) => (
              <option key={c.id} value={c.id}>{c.description || c.name} · остаток {fmt(c.debt)}</option>
            ))}
          </select>
          {orderCreditors.length === 0 && (
            <div style={{ fontSize: 10, color: "#A89070", marginTop: 4 }}>
              У этого заказа нет открытых обязательств перед подрядчиком — расход просто добавится в себестоимость.
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <div style={lgLbl}>ПРИМЕЧАНИЕ</div>
        <input style={lgInp} value={note} onChange={e => setNote(e.target.value)}
               placeholder={action === "offset" ? "за что зачёт" : "за что платим"} />
      </div>

      {error && <div style={{ marginTop: 12, fontSize: 11, color: "#8B3A3A" }}>{error}</div>}
    </Modal>
  );
}

export const STATUS_COLORS: Record<string, string> = {
  favorite: "#E8592A", stable: "#4A7C59", available: "#A89070", risk: "#8B3A3A",
};

export const CONTRACTOR_STATUS_LABELS: Record<string, string> = {
  favorite: "Постоянный", stable: "Стабильный", available: "Доступен", risk: "Риск",
};

const EVENT_LABELS: Record<string, string> = {
  payment: "Выплата", note: "Заметка", review: "Отзыв", order: "Заказ", issue: "Проблема",
};

export const CONTRACTOR_FIELDS: FieldDef[] = [
  { key: "name",           label: "Имя / Название" },
  { key: "role",           label: "Роль",
    type: "select", options: [{ v: "Мастер", l: "Мастер" }, { v: "Подрядчик", l: "Подрядчик" },
                              { v: "Поставщик", l: "Поставщик" }] },
  { key: "specialization", label: "Специализация" },
  { key: "phone",          label: "Телефон" },
  { key: "telegram",       label: "Telegram" },
  { key: "email",          label: "Email" },
  // Реквизиты организации — актуальны для поставщиков (та же картотека, роль различает)
  { key: "inn",            label: "ИНН" },
  { key: "contact",        label: "Контактное лицо" },
  { key: "website",        label: "Сайт" },
  { key: "price_supplier", label: "Прайс материалов",
    type: "select", options: [{ v: "vrep", l: "ВРЭП" }, { v: "metplus", l: "Металлинвест" }] },
  { key: "pay_scheme",     label: "Схема оплаты",
    type: "select", options: [
      { v: "percent",  l: "% от счёта" },
      { v: "fixed",    l: "Фиксированная ставка" },
      { v: "per_unit", l: "За единицу" },
      { v: "other",    l: "Другое" },
    ]},
  { key: "pay_rate",  label: "Ставка / %" },
  { key: "pay_note",  label: "Условия оплаты" },
  { key: "prepay_pct", label: "Предоплата, %" },
  { key: "notes",     label: "Заметки (карточка)", type: "textarea" },
  { key: "wiki_notes",label: "Вики (fin-agent)",   type: "textarea" },
  { key: "status",    label: "Статус",
    type: "select", options: [
      { v: "favorite",  l: "Постоянный" },
      { v: "stable",    l: "Стабильный" },
      { v: "available", l: "Доступен" },
      { v: "risk",      l: "Риск" },
    ]},
];

export function ContractorDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [editCreditor, setEditCreditor] = useState<any>(null);
  const [ledgerAction, setLedgerAction] = useState<LedgerAction | null>(null);
  const blocker = useNavigationGuard(editing || !!editCreditor);

  const { data, isLoading } = useQuery({
    queryKey: ["master", id],
    queryFn: () => mastersApi.get(id),
  });

  // Лицевой счёт: начисления (creditors) и выплаты (expenses) сходятся в одно сальдо.
  const { data: ledger } = useQuery({
    queryKey: ["ledger", "master", id],
    queryFn: () => ledgerApi.master(id),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["master", id] });
    qc.invalidateQueries({ queryKey: ["masters"] });
    qc.invalidateQueries({ queryKey: ["wiki", "contractors"] });
  };

  const save = useMutation({
    mutationFn: (patch: Record<string, any>) => mastersApi.update(id, patch),
    onSuccess: () => { invalidate(); setEditing(false); },
  });

  const del = useMutation({
    mutationFn: () => mastersApi.delete(id),
    onSuccess: () => { invalidate(); setEditing(false); onClose(); },
  });

  const saveCreditor = useMutation({
    mutationFn: (patch: any) => financeApi.updateCreditor(editCreditor.id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["master", id] });
      qc.invalidateQueries({ queryKey: ["creditors"] });
      setEditCreditor(null);
    },
  });

  if (isLoading) return <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 13 }}>Загружаем...</div>;
  const master = data?.master;
  if (!master) return null;
  const wiki = data?.wiki || {};
  const creditors: any[] = data?.creditors || [];
  const expenses: any[] = data?.expenses || [];
  const events: any[] = data?.events || [];
  const expensesTotal = expenses.reduce((s: number, e: any) => s + (e.amount || 0), 0);
  const totalDebt = data?.total_debt ?? 0;

  const editInitial = {
    name:           master.name,
    role:           master.role,
    specialization: master.specialization || wiki.wiki_spec || "",
    phone:          master.phone,
    telegram:       master.telegram,
    email:          master.email,
    pay_scheme:     wiki.pay_scheme || "",
    pay_rate:       wiki.pay_rate != null ? String(wiki.pay_rate) : "",
    pay_note:       wiki.pay_note || "",
    prepay_pct:     wiki.prepay_pct != null ? String(wiki.prepay_pct) : "",
    notes:          master.notes || "",
    wiki_notes:     wiki.wiki_notes || "",
    status:         master.status,
    inn:            master.inn || "",
    contact:        master.contact || "",
    website:        master.website || "",
    price_supplier: master.price_supplier || "",
  };

  return (
    <>
      {editing && (
        <EditModal
          title={`Редактировать: ${master.name}`}
          fields={CONTRACTOR_FIELDS}
          initial={editInitial}
          isPending={save.isPending}
          onSave={(d) => save.mutate(d)}
          onClose={() => setEditing(false)}
          onDelete={() => del.mutate()}
        />
      )}

      <DetailShell
        title={master.name}
        subtitle={`${master.role || ""}${master.specialization ? ` · ${master.specialization}` : ""}`}
        avatar={{ kind: "initials", name: master.name, tint: totalDebt > 0 ? "#FFF0EC" : undefined }}
        status={master.status ? { label: CONTRACTOR_STATUS_LABELS[master.status] || master.status, color: STATUS_COLORS[master.status] } : null}
        metrics={((): DetailMetric[] | undefined => {
          const m: DetailMetric[] = [];
          if (data?.paid_total > 0) m.push({ label: "Выплачено", value: fmt(data.paid_total), color: "#4A7C59" });
          // Долг берём из лицевого счёта: сумма открытых обязательств не учитывает
          // выплаты, прошедшие расходом, и на карточке спорила бы с сальдо ниже.
          if (ledger && Math.abs(ledger.balance) >= 1)
            m.push({ label: ledger.balance > 0 ? "Мы должны" : "Аванс у мастера",
                     value: fmt(Math.abs(ledger.balance)),
                     color: ledger.balance > 0 ? "#8B3A3A" : "#4A7C59" });
          else if (!ledger && totalDebt > 0) m.push({ label: "Долг", value: fmt(totalDebt), color: "#8B3A3A" });
          return m.length ? m : undefined;
        })()}
        onEdit={() => setEditing(true)}
        onClose={onClose}
      >
        <DetailSection label="КОНТАКТЫ" first>
          <ContactStrip entity={master} />
          {master.inn && <Row label="ИНН" value={master.inn} mono />}
          <Row label="Телефон"  value={master.phone} mono href={contactHref("phone", master.phone)} />
          <Row label="Telegram" value={master.telegram} href={contactHref("telegram", master.telegram)} />
          <Row label="Email"    value={master.email} href={contactHref("email", master.email)} />
          {master.contact && <Row label="Контактное лицо" value={master.contact} />}
          {master.website && (
            <Row label="Сайт" value={master.website}
              href={/^https?:\/\//.test(master.website) ? master.website : `https://${master.website}`} />
          )}
        </DetailSection>

        {/* Свежесть прайса — у поставщиков материалов (код прайса materials.db) */}
        {master.price_supplier && <PriceSync code={master.price_supplier} />}

        {data?.linked_customers?.length > 0 && (
          <DetailSection label="СВЯЗИ">
            {data.linked_customers.map((c: any) => (
              <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #F2EFE9" }}>
                <div style={{ fontSize: 11, color: "#A89070" }}>Он же клиент</div>
                <button onClick={() => nav(`/wiki/clients/${c.id}`)}
                  style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, fontWeight: 500, color: "#E8592A",
                           background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
                  <User size={12} /> {c.name} →
                </button>
              </div>
            ))}
          </DetailSection>
        )}

        {/* prepay_pct === 0 без сравнения утекал в разметку голым «0» */}
        {(wiki.pay_label || wiki.pay_note || wiki.prepay_pct > 0) && (
          <DetailSection label="ОПЛАТА">
            {wiki.pay_label && <Row label="Схема" value={wiki.pay_label} />}
            {wiki.prepay_pct > 0 && <Row label="Предоплата" value={`${wiki.prepay_pct}%`} mono />}
          </DetailSection>
        )}

        {ledger && (
          <DetailSection label="ЛИЦЕВОЙ СЧЁТ">
            {/* Аванс / оплата за него / зачёт: до этого всё заводилось через API
                руками — ledgerApi.contractorPay во фронте не вызывался ниоткуда. */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              <ActionChip icon={<HandCoins size={12} />} label="Выдать аванс" onClick={() => setLedgerAction("advance")} />
              <ActionChip icon={<Receipt size={12} />} label="Оплатить за него" onClick={() => setLedgerAction("third_party")} />
              <ActionChip icon={<ArrowsLeftRight size={12} />} label="Провести зачёт" onClick={() => setLedgerAction("offset")} />
            </div>
            <Row label={ledger.balance >= 0 ? "Мы должны" : "Аванс у мастера"}
                 value={fmt(Math.abs(ledger.balance))} mono
                 valueColor={ledger.balance > 0 ? "#8B3A3A" : ledger.balance < 0 ? "#4A7C59" : undefined} />
            <Row label="Начислено по сметам" value={fmt(ledger.accrued)} mono />
            <Row label="Выплачено" value={fmt(ledger.paid)} mono />
            {ledger.third_party > 0 && <Row label="Оплачено за него" value={fmt(ledger.third_party)} mono />}
            {ledger.offset > 0 && <Row label="Зачтено" value={fmt(ledger.offset)} mono />}
            {/* A1: работы приняты, но закрыты авансом/зачётом или ещё не оплачены.
                В сальдо не входит (знак 0) — это справка «за что мы ещё должны». */}
            {ledger.accepted > 0 && <Row label="Принято, не оплачено" value={fmt(ledger.accepted)} mono />}
            <div style={{ marginTop: 10 }}>
              {(ledger.entries || []).slice(0, 8).map((e: any, i: number) => (
                <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "6px 0",
                                      borderBottom: "1px solid #F2EFE9" }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: "#A89070", minWidth: 74 }}>{fmtDate(e.date)}</span>
                  <span style={{ fontSize: 11, color: "#A89070", minWidth: 108 }}>{e.kind_label}</span>
                  <span style={{ fontSize: 12, color: "#1A1A1A", flex: 1, overflow: "hidden",
                                 textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {e.order_title || e.title}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 12,
                                 color: e.sign > 0 ? "#8B3A3A" : e.sign < 0 ? "#4A7C59" : "#A89070" }}>
                    {e.sign > 0 ? "+" : e.sign < 0 ? "−" : ""}{fmt(e.amount)}
                  </span>
                </div>
              ))}
            </div>
          </DetailSection>
        )}

        {(master.notes || wiki.wiki_notes) && (
          <DetailSection label="ВИКИ">
            {(wiki.wiki_notes || master.notes) && <NoteBlock>{wiki.wiki_notes || master.notes}</NoteBlock>}
            {wiki.wiki_notes && master.notes && wiki.wiki_notes !== master.notes && (
              <div style={{ padding: "10px 12px", background: "#FFF8F5", fontSize: 13, color: "#6B6355", lineHeight: 1.7, borderLeft: "3px solid #FAD0C0", marginTop: 6 }}>
                {master.notes}
              </div>
            )}
          </DetailSection>
        )}

        <DetailSection label="ОБЯЗАТЕЛЬСТВА" extra={creditors.filter(c => c.status === "open").length > 0
          ? <span style={{ color: "#8B3A3A" }}>· {creditors.filter(c => c.status === "open").length} открытых</span> : undefined}>
        {creditors.length === 0 ? (
          <div style={{ fontSize: 13, color: "#C8C0B0" }}>Нет зафиксированных долгов</div>
        ) : (
          creditors.map((c: any) => (
            <div key={c.id}>
              <div
                onClick={() => setEditCreditor(editCreditor?.id === c.id ? null : c)}
                style={{
                  padding: "9px 12px", marginBottom: 6, cursor: "pointer",
                  background: c.status === "open" ? "#FFF8F5" : "#FAF8F5",
                  borderLeft: `3px solid ${c.status === "open" ? "#E8592A" : "#EDEBE6"}`,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "#F5EDE8")}
                onMouseLeave={e => (e.currentTarget.style.background = c.status === "open" ? "#FFF8F5" : "#FAF8F5")}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 13, color: "#6B6355", flex: 1, paddingRight: 8 }}>{c.description || "—"}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: c.status === "open" ? "#8B3A3A" : "#A89070", flexShrink: 0, fontFamily: c.status === "open" ? MONO : undefined, fontVariantNumeric: "tabular-nums" }}>
                    {c.status === "open" ? fmt(c.debt) : <span style={{ fontSize: 11 }}>Закрыт</span>}
                  </div>
                </div>
                {(c.paid > 0 || c.due_date) && (
                  <div style={{ fontSize: 11, color: "#A89070", marginTop: 3 }}>
                    {c.paid > 0 && `оплачено ${fmt(c.paid)} из ${fmt(c.total)}`}
                    {c.paid > 0 && c.due_date && " · "}
                    {c.due_date && `до ${fmtDate(c.due_date)}`}
                  </div>
                )}
              </div>

              {editCreditor?.id === c.id && (
                <div style={{ padding: "12px 14px", marginBottom: 8, background: "#fff", border: "1px solid #EDEBE6" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 11, color: "#A89070", marginBottom: 3 }}>СУММА ₽</div>
                      <input type="number" defaultValue={c.total} id={`ec-total-${c.id}`}
                        style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none" }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: "#A89070", marginBottom: 3 }}>ОПЛАЧЕНО ₽</div>
                      <input type="number" defaultValue={c.paid} id={`ec-paid-${c.id}`}
                        style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none" }} />
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button onClick={() => saveCreditor.mutate({ status: "closed" })}
                      style={{ padding: "4px 10px", border: "1px solid #4A7C59", background: "none", fontSize: 11, cursor: "pointer", color: "#4A7C59", display: "flex", alignItems: "center", gap: 4 }}>
                      <Check size={11} /> Закрыть
                    </button>
                    <button onClick={() => {
                      const t = parseFloat((document.getElementById(`ec-total-${c.id}`) as HTMLInputElement).value);
                      const p = parseFloat((document.getElementById(`ec-paid-${c.id}`) as HTMLInputElement).value);
                      saveCreditor.mutate({ total: isNaN(t) ? c.total : t, paid: isNaN(p) ? c.paid : p });
                    }} style={{ padding: "4px 10px", border: "none", background: "#E8592A", color: "#fff", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>
                      Сохранить
                    </button>
                    <button onClick={() => setEditCreditor(null)}
                      style={{ padding: "4px 10px", border: "1px solid #EDEBE6", background: "none", fontSize: 11, cursor: "pointer", color: "#A89070" }}>
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
        </DetailSection>

        {expenses.length > 0 && (
          <DetailSection label="РАСХОДЫ ПО ЗАКАЗАМ" extra={<span style={{ color: "#1A1A1A", fontFamily: MONO }}>{fmt(expensesTotal)}</span>}>
            {expenses.map((e: any) => (
              <div key={e.id} style={{ display: "grid", gridTemplateColumns: "70px 1fr 90px", gap: 8, alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
                <div style={{ fontSize: 11, color: "#A89070", fontFamily: MONO }}>{fmtDate(e.expense_date)}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</div>
                  {e.order_title && <div style={{ fontSize: 11, color: "#A89070", marginTop: 1 }}>{e.order_title}</div>}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#8B3A3A", textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(e.amount)}</div>
              </div>
            ))}
          </DetailSection>
        )}

        {events.length > 0 && (
          <DetailSection label="ИСТОРИЯ">
            <div style={{ fontSize: 11, color: "#C8C0B0", marginBottom: 10, marginTop: -2, lineHeight: 1.5 }}>
              Из вики фин-агента. Не суммируется с расходами: одна выплата бывает записана и там, и там.
            </div>
            {events.map((ev: any) => (
              <div key={ev.id} style={{ display: "grid", gridTemplateColumns: "70px 1fr 90px", gap: 8, alignItems: "start", padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
                <div style={{ fontSize: 11, color: "#A89070", fontFamily: MONO }}>{fmtDate(ev.happened_at)}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: "#1A1A1A", lineHeight: 1.45 }}>{ev.description || "—"}</div>
                  <div style={{ fontSize: 11, color: "#A89070", marginTop: 2 }}>
                    {EVENT_LABELS[ev.event_type] || ev.event_type}{ev.order_title ? ` · ${ev.order_title}` : ""}
                  </div>
                </div>
                <div style={{ fontSize: 13, color: "#6B6355", textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                  {ev.amount ? fmt(ev.amount) : "—"}
                </div>
              </div>
            ))}
          </DetailSection>
        )}

        <PayeeRulesSection entityType="master" entityId={id} />
      </DetailShell>

      {ledgerAction && master && (
        <LedgerActionModal
          action={ledgerAction} master={master} creditors={creditors}
          onClose={() => setLedgerAction(null)}
          onDone={() => {
            // Проводка меняет и лицевой счёт, и — при указанном заказе — факт
            // себестоимости: обновляем оба контура, иначе экраны разъедутся.
            qc.invalidateQueries({ queryKey: ["ledger", "master", id] });
            qc.invalidateQueries({ queryKey: ["master", id] });
            qc.invalidateQueries({ queryKey: ["orders"] });
            qc.invalidateQueries({ queryKey: ["orders-plan-fact-summary"] });
          }}
        />
      )}

      <NavigationGuardModal blocker={blocker} />
    </>
  );
}
