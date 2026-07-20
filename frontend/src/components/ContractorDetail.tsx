import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MONO } from "./ui/Num";
import { IconButton } from "./ui/IconButton";
import { useNavigationGuard, NavigationGuardModal } from "./NavigationGuard";
import { EditModal, type FieldDef } from "./EditModal";
import { PayeeRulesSection } from "./PayeeRulesSection";
import { mastersApi, financeApi } from "../api";
import { PencilSimple, DotsThree, Check } from "@phosphor-icons/react";

function fmt(n: number) {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}
function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

export const STATUS_COLORS: Record<string, string> = {
  favorite: "#E8592A", stable: "#4A7C59", available: "#A89070", risk: "#8B3A3A",
};

const EVENT_LABELS: Record<string, string> = {
  payment: "Выплата", note: "Заметка", review: "Отзыв", order: "Заказ", issue: "Проблема",
};

export const CONTRACTOR_FIELDS: FieldDef[] = [
  { key: "name",           label: "Имя / Название" },
  { key: "role",           label: "Роль",
    type: "select", options: [{ v: "Мастер", l: "Мастер" }, { v: "Подрядчик", l: "Подрядчик" }] },
  { key: "specialization", label: "Специализация" },
  { key: "phone",          label: "Телефон" },
  { key: "telegram",       label: "Telegram" },
  { key: "email",          label: "Email" },
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

export function ContractorDetail({ masterId, onClose }: { masterId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [editCreditor, setEditCreditor] = useState<any>(null);
  const blocker = useNavigationGuard(editing || !!editCreditor);

  const { data, isLoading } = useQuery({
    queryKey: ["master", masterId],
    queryFn: () => mastersApi.get(masterId),
  });

  const save = useMutation({
    mutationFn: (patch: Record<string, any>) => mastersApi.update(masterId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["master", masterId] });
      qc.invalidateQueries({ queryKey: ["masters"] });
      setEditing(false);
    },
  });

  const del = useMutation({
    mutationFn: () => mastersApi.delete(masterId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["masters"] });
      setEditing(false);
      onClose();
    },
  });

  const saveCreditor = useMutation({
    mutationFn: (patch: any) => financeApi.updateCreditor(editCreditor.id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["master", masterId] });
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

  const statusLabel: Record<string, string> = {
    favorite: "Постоянный", stable: "Стабильный", available: "Доступен", risk: "Риск",
  };

  // Initial values for edit modal include wiki fields
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
  };

  const Row = ({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
      <div style={{ fontSize: 11, color: "#A89070" }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 500, color: value ? "#1A1A1A" : "#C8C0B0", textAlign: "right", maxWidth: 240, fontFamily: mono && value ? MONO : undefined, fontVariantNumeric: mono ? "tabular-nums" : undefined }}>{value || "—"}</div>
    </div>
  );

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

      {/* Header */}
      <div style={{ padding: "22px 24px 16px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexShrink: 0 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <div style={{ fontSize: 21, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em", maxWidth: 260 }}>{master.name}</div>
            <span style={{ fontSize: 9, color: STATUS_COLORS[master.status] || "#A89070", border: `1px solid ${STATUS_COLORS[master.status] || "#EDEBE6"}`, padding: "2px 6px", letterSpacing: "0.04em" }}>
              {statusLabel[master.status] || master.status}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "#A89070" }}>{master.role}{master.specialization ? ` · ${master.specialization}` : ""}</div>
          {data?.paid_total > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: "#4A7C59" }}>Выплачено: <span style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{fmt(data.paid_total)}</span></div>
          )}
          {totalDebt > 0 && (
            <div style={{ marginTop: 6, fontSize: 13, fontWeight: 700, color: "#8B3A3A" }}>Долг: <span style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(totalDebt)}</span></div>
          )}
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <IconButton icon={PencilSimple} title="Редактировать" size={28} iconSize={16} color="#C8C0B0" onClick={() => setEditing(true)} />
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 6 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#1A1A1A")}
            onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}>
            <DotsThree size={20} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "18px 24px" }}>

        {/* Contacts */}
        <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10 }}>КОНТАКТЫ</div>
        <Row label="Телефон"  value={master.phone} mono />
        <Row label="Telegram" value={master.telegram} />
        <Row label="Email"    value={master.email} />

        {/* Payment */}
        {(wiki.pay_label || wiki.pay_note || wiki.prepay_pct) && (
          <>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10, marginTop: 18 }}>ОПЛАТА</div>
            {wiki.pay_label && <Row label="Схема" value={wiki.pay_label} />}
            {wiki.prepay_pct > 0 && <Row label="Предоплата" value={`${wiki.prepay_pct}%`} mono />}
          </>
        )}

        {/* Wiki notes */}
        {(master.notes || wiki.wiki_notes) && (
          <>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10, marginTop: 18 }}>ВИКИ</div>
            {(wiki.wiki_notes || master.notes) && (
              <div style={{ padding: "10px 12px", background: "#FAF8F5", fontSize: 12, color: "#1A1A1A", lineHeight: 1.7, borderLeft: "3px solid #EDEBE6" }}>
                {wiki.wiki_notes || master.notes}
              </div>
            )}
            {wiki.wiki_notes && master.notes && wiki.wiki_notes !== master.notes && (
              <div style={{ padding: "10px 12px", background: "#FFF8F5", fontSize: 12, color: "#6B6355", lineHeight: 1.7, borderLeft: "3px solid #FAD0C0", marginTop: 6 }}>
                {master.notes}
              </div>
            )}
          </>
        )}

        {/* Obligations */}
        <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10, marginTop: 18 }}>
          ОБЯЗАТЕЛЬСТВА
          {creditors.filter(c => c.status === "open").length > 0 &&
            <span style={{ color: "#8B3A3A", marginLeft: 6 }}>· {creditors.filter(c => c.status === "open").length} открытых</span>}
        </div>

        {creditors.length === 0 ? (
          <div style={{ fontSize: 12, color: "#C8C0B0" }}>Нет зафиксированных долгов</div>
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
                  <div style={{ fontSize: 11, color: "#6B6355", flex: 1, paddingRight: 8 }}>{c.description || "—"}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: c.status === "open" ? "#8B3A3A" : "#A89070", flexShrink: 0, fontFamily: c.status === "open" ? MONO : undefined, fontVariantNumeric: "tabular-nums" }}>
                    {c.status === "open" ? fmt(c.debt) : <span style={{ fontSize: 10 }}>Закрыт</span>}
                  </div>
                </div>
                {(c.paid > 0 || c.due_date) && (
                  <div style={{ fontSize: 10, color: "#A89070", marginTop: 3 }}>
                    {c.paid > 0 && `оплачено ${fmt(c.paid)} из ${fmt(c.total)}`}
                    {c.paid > 0 && c.due_date && " · "}
                    {c.due_date && `до ${fmtDate(c.due_date)}`}
                  </div>
                )}
              </div>

              {/* Inline creditor editor */}
              {editCreditor?.id === c.id && (
                <div style={{ padding: "12px 14px", marginBottom: 8, background: "#fff", border: "1px solid #EDEBE6" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 9, color: "#A89070", marginBottom: 3 }}>СУММА ₽</div>
                      <input type="number" defaultValue={c.total} id={`ec-total-${c.id}`}
                        style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none" }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#A89070", marginBottom: 3 }}>ОПЛАЧЕНО ₽</div>
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

        {/* Расходы по заказам */}
        {expenses.length > 0 && (
          <>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10, marginTop: 18 }}>
              РАСХОДЫ ПО ЗАКАЗАМ
              <span style={{ color: "#1A1A1A", marginLeft: 6, fontFamily: MONO }}>{fmt(expensesTotal)}</span>
            </div>
            {expenses.map((e: any) => (
              <div key={e.id} style={{ display: "grid", gridTemplateColumns: "70px 1fr 90px", gap: 8, alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
                <div style={{ fontSize: 10, color: "#A89070", fontFamily: MONO }}>{fmtDate(e.expense_date)}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</div>
                  {e.order_number && <div style={{ fontSize: 10, color: "#A89070", marginTop: 1 }}>{e.order_number} · {e.order_title}</div>}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#8B3A3A", textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(e.amount)}</div>
              </div>
            ))}
          </>
        )}

        {/* История из вики фин-агента */}
        {events.length > 0 && (
          <>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4, marginTop: 18 }}>ИСТОРИЯ</div>
            <div style={{ fontSize: 10, color: "#C8C0B0", marginBottom: 10, lineHeight: 1.5 }}>
              Из вики фин-агента. Не суммируется с расходами: одна выплата бывает записана и там, и там.
            </div>
            {events.map((ev: any) => (
              <div key={ev.id} style={{ display: "grid", gridTemplateColumns: "70px 1fr 90px", gap: 8, alignItems: "start", padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
                <div style={{ fontSize: 10, color: "#A89070", fontFamily: MONO }}>{fmtDate(ev.happened_at)}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "#1A1A1A", lineHeight: 1.45 }}>{ev.description || "—"}</div>
                  <div style={{ fontSize: 9, color: "#A89070", marginTop: 2 }}>
                    {EVENT_LABELS[ev.event_type] || ev.event_type}{ev.order_number ? ` · ${ev.order_number}` : ""}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "#6B6355", textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                  {ev.amount ? fmt(ev.amount) : "—"}
                </div>
              </div>
            ))}
          </>
        )}

        <PayeeRulesSection entityType="master" entityId={masterId} />
      </div>

      <NavigationGuardModal blocker={blocker} />
    </>
  );
}

