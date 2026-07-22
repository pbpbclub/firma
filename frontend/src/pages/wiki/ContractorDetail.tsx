import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MONO } from "../../components/ui/Num";
import { useNavigationGuard, NavigationGuardModal } from "../../components/NavigationGuard";
import { EditModal, type FieldDef } from "../../components/EditModal";
import { PayeeRulesSection } from "../../components/PayeeRulesSection";
import { mastersApi, financeApi } from "../../api";
import { Check } from "@phosphor-icons/react";
import { fmt, fmtDate } from "./helpers";
import { DetailRow as Row } from "./DetailRow";
import { DetailShell, DetailSection, NoteBlock, type DetailMetric } from "./DetailShell";

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

export function ContractorDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [editCreditor, setEditCreditor] = useState<any>(null);
  const blocker = useNavigationGuard(editing || !!editCreditor);

  const { data, isLoading } = useQuery({
    queryKey: ["master", id],
    queryFn: () => mastersApi.get(id),
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
          if (totalDebt > 0) m.push({ label: "Долг", value: fmt(totalDebt), color: "#8B3A3A" });
          return m.length ? m : undefined;
        })()}
        onEdit={() => setEditing(true)}
        onClose={onClose}
      >
        <DetailSection label="КОНТАКТЫ" first>
          <Row label="Телефон"  value={master.phone} mono />
          <Row label="Telegram" value={master.telegram} />
          <Row label="Email"    value={master.email} />
        </DetailSection>

        {(wiki.pay_label || wiki.pay_note || wiki.prepay_pct) && (
          <DetailSection label="ОПЛАТА">
            {wiki.pay_label && <Row label="Схема" value={wiki.pay_label} />}
            {wiki.prepay_pct > 0 && <Row label="Предоплата" value={`${wiki.prepay_pct}%`} mono />}
          </DetailSection>
        )}

        {(master.notes || wiki.wiki_notes) && (
          <DetailSection label="ВИКИ">
            {(wiki.wiki_notes || master.notes) && <NoteBlock>{wiki.wiki_notes || master.notes}</NoteBlock>}
            {wiki.wiki_notes && master.notes && wiki.wiki_notes !== master.notes && (
              <div style={{ padding: "10px 12px", background: "#FFF8F5", fontSize: 12, color: "#6B6355", lineHeight: 1.7, borderLeft: "3px solid #FAD0C0", marginTop: 6 }}>
                {master.notes}
              </div>
            )}
          </DetailSection>
        )}

        <DetailSection label="ОБЯЗАТЕЛЬСТВА" extra={creditors.filter(c => c.status === "open").length > 0
          ? <span style={{ color: "#8B3A3A" }}>· {creditors.filter(c => c.status === "open").length} открытых</span> : undefined}>
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
        </DetailSection>

        {expenses.length > 0 && (
          <DetailSection label="РАСХОДЫ ПО ЗАКАЗАМ" extra={<span style={{ color: "#1A1A1A", fontFamily: MONO }}>{fmt(expensesTotal)}</span>}>
            {expenses.map((e: any) => (
              <div key={e.id} style={{ display: "grid", gridTemplateColumns: "70px 1fr 90px", gap: 8, alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
                <div style={{ fontSize: 10, color: "#A89070", fontFamily: MONO }}>{fmtDate(e.expense_date)}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</div>
                  {e.order_title && <div style={{ fontSize: 10, color: "#A89070", marginTop: 1 }}>{e.order_title}</div>}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#8B3A3A", textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(e.amount)}</div>
              </div>
            ))}
          </DetailSection>
        )}

        {events.length > 0 && (
          <DetailSection label="ИСТОРИЯ">
            <div style={{ fontSize: 10, color: "#C8C0B0", marginBottom: 10, marginTop: -2, lineHeight: 1.5 }}>
              Из вики фин-агента. Не суммируется с расходами: одна выплата бывает записана и там, и там.
            </div>
            {events.map((ev: any) => (
              <div key={ev.id} style={{ display: "grid", gridTemplateColumns: "70px 1fr 90px", gap: 8, alignItems: "start", padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
                <div style={{ fontSize: 10, color: "#A89070", fontFamily: MONO }}>{fmtDate(ev.happened_at)}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "#1A1A1A", lineHeight: 1.45 }}>{ev.description || "—"}</div>
                  <div style={{ fontSize: 9, color: "#A89070", marginTop: 2 }}>
                    {EVENT_LABELS[ev.event_type] || ev.event_type}{ev.order_title ? ` · ${ev.order_title}` : ""}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "#6B6355", textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                  {ev.amount ? fmt(ev.amount) : "—"}
                </div>
              </div>
            ))}
          </DetailSection>
        )}

        <PayeeRulesSection entityType="master" entityId={id} />
      </DetailShell>

      <NavigationGuardModal blocker={blocker} />
    </>
  );
}
