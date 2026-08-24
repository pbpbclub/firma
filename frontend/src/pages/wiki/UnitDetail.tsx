import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MONO } from "../../components/ui/Num";
import { Modal } from "../../components/ui/Modal";
import { businessUnitsApi } from "../../api";
import { Plus, Trash } from "@phosphor-icons/react";
import { fmt } from "./helpers";
import { DetailRow as Row } from "./DetailRow";
import { DetailShell, DetailSection, NoteBlock } from "./DetailShell";

const ACCOUNT_SOURCES = [
  { v: "bank", l: "Банк (р/с)" },
  { v: "zenmoney", l: "ZenMoney (личные)" },
  { v: "cash", l: "Наличные" },
  { v: "manual", l: "Вручную" },
];

// Панель юрлица (единый вид). Правка (со счётами) — через UnitModal по карандашу.
export function UnitDetail({ row, onClose }: { row: any; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  const u = row;
  if (!u) return null;
  const accounts: any[] = u.accounts ?? [];

  return (
    <>
      {editing && <UnitModal row={u} onClose={() => setEditing(false)} />}

      <DetailShell
        title={u.name}
        avatar={{ kind: "initials", name: u.name }}
        status={u.kind ? { label: u.kind } : null}
        metrics={[{ label: "Баланс", value: fmt(u.balance_total || 0), color: u.balance_total >= 0 ? "#1A1A1A" : "#8B3A3A" }]}
        onEdit={() => setEditing(true)}
        onClose={onClose}
      >
        <DetailSection label="РЕКВИЗИТЫ" first>
          <Row label="Тип"            value={u.kind} />
          <Row label="ИНН"            value={u.inn} mono />
          <Row label="Полное название" value={u.full_name} />
        </DetailSection>

        <DetailSection label="СЧЕТА" extra={accounts.length > 0 ? `· ${accounts.length}` : undefined}>
          {accounts.length === 0 ? (
            <div style={{ fontSize: 13, color: "#C8C0B0" }}>Счетов нет</div>
          ) : accounts.map((a: any) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 0", borderBottom: "1px solid #F2EFE9" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "#1A1A1A" }}>{a.name}</div>
                <div style={{ fontSize: 11, color: "#A89070" }}>
                  {ACCOUNT_SOURCES.find(s => s.v === a.source)?.l || a.source}{a.number ? ` · ${a.number}` : ""}
                </div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(a.balance || 0)}</div>
            </div>
          ))}
        </DetailSection>

        {u.notes && (
          <DetailSection label="ЗАМЕТКИ">
            <NoteBlock>{u.notes}</NoteBlock>
          </DetailSection>
        )}
      </DetailShell>
    </>
  );
}

// Юрлицо/бизнес-единица редактируется модалкой (row={} — создание). Первый UI для юрлиц.
export function UnitModal({ row, onClose }: { row: any; onClose: () => void }) {
  const qc = useQueryClient();
  const unit = row;
  const isNew = !unit?.id;
  const [form, setForm] = useState<Record<string, string>>({
    name: unit?.name ?? "", kind: unit?.kind ?? "ИП", inn: unit?.inn ?? "",
    full_name: unit?.full_name ?? "", notes: unit?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const accounts: any[] = unit?.accounts ?? [];
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));
  const refresh = () => qc.invalidateQueries({ queryKey: ["wiki", "units"] });

  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const payload: Record<string, any> = {};
      for (const [k, v] of Object.entries(form)) payload[k] = v.trim() || null;
      if (isNew) await businessUnitsApi.create(payload);
      else await businessUnitsApi.update(unit.id, payload);
      refresh();
      onClose();
    } finally { setSaving(false); }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6",
    padding: "7px 10px", fontSize: 13, outline: "none",
  };

  return (
    <Modal
      size="md"
      eyebrow={isNew ? "НОВОЕ ЮРЛИЦО" : "ЮРЛИЦО / БИЗНЕС-ЕДИНИЦА"}
      onClose={onClose}
      onCancel={onClose}
      onSave={save}
      saveLabel="Сохранить"
      saving={saving}
      canSave={!!form.name.trim()}
      footerLeft={!isNew ? (
        confirmDel ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "#8B3A3A" }}>Удалить?</span>
            <button onClick={async () => { await businessUnitsApi.delete(unit.id); refresh(); onClose(); }} style={{ fontSize: 11, color: "#fff", background: "#8B3A3A", border: "none", padding: "4px 10px", cursor: "pointer" }}>Да</button>
            <button onClick={() => setConfirmDel(false)} style={{ fontSize: 11, color: "#6B6355", background: "none", border: "none", cursor: "pointer" }}>Нет</button>
          </div>
        ) : (
          <button onClick={() => setConfirmDel(true)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#8B3A3A", display: "flex", alignItems: "center", gap: 5 }}>
            <Trash size={13} /> Удалить
          </button>
        )
      ) : undefined}
    >
        <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 10 }}>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>НАЗВАНИЕ</div>
              <input value={form.name} onChange={e => set("name", e.target.value)} style={inputStyle} autoFocus={isNew} />
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ТИП</div>
              <select value={form.kind} onChange={e => set("kind", e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
                <option value="ИП">ИП</option>
                <option value="Физлицо">Физлицо</option>
                <option value="ООО">ООО</option>
              </select>
            </div>
          </div>
          {[
            { k: "full_name", l: "ПОЛНОЕ НАЗВАНИЕ" },
            { k: "inn", l: "ИНН" },
            { k: "notes", l: "ЗАМЕТКИ" },
          ].map(f => (
            <div key={f.k}>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>{f.l}</div>
              <input value={form[f.k]} onChange={e => set(f.k, e.target.value)} style={inputStyle} />
            </div>
          ))}

          {!isNew && (
            <div>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>СЧЕТА</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {accounts.map((a: any) => (
                  <AccountRow key={a.id} a={a}
                    onChanged={() => { refresh(); onClose(); }} />
                ))}
                <AddAccountRow unitId={unit.id} onAdded={() => { refresh(); onClose(); }} />
              </div>
            </div>
          )}
          {isNew && <div style={{ fontSize: 11, color: "#A89070" }}>Счета можно добавить после создания.</div>}
        </div>
    </Modal>
  );
}

/** Строка счёта юрлица с правкой на месте.
 *
 *  Раньше счёт был read-only: поправить название, тип или номер можно было только
 *  «удалить и завести заново» — при том что PATCH /business-units/accounts/{id}
 *  существует (обёртка updateAccount была мёртвой). Поля те же, что при добавлении. */
function AccountRow({ a, onChanged }: { a: any; onChanged: () => void }) {
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(a.name || "");
  const [source, setSource] = useState(a.source || "bank");
  const [number, setNumber] = useState(a.number || "");
  const [busy, setBusy] = useState(false);
  const inp: React.CSSProperties = { boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "6px 9px", fontSize: 12, outline: "none" };

  if (edit) {
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center", border: "1px solid #E8592A", padding: "7px 10px" }}>
        <input value={name} onChange={e => setName(e.target.value)} style={{ ...inp, flex: 1 }} autoFocus />
        <select value={source} onChange={e => setSource(e.target.value)} style={{ ...inp, background: "#fff" }}>
          {ACCOUNT_SOURCES.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
        </select>
        {source === "bank" && <input placeholder="№ счёта" value={number} onChange={e => setNumber(e.target.value)} style={{ ...inp, width: 130 }} />}
        <button disabled={!name.trim() || busy} onClick={async () => {
          setBusy(true);
          try {
            await businessUnitsApi.updateAccount(a.id, {
              name: name.trim(), source, number: number.trim() || null,
            });
            onChanged();
          } finally { setBusy(false); }
        }} style={{ padding: "6px 12px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600, opacity: name.trim() ? 1 : 0.5 }}>
          {busy ? "..." : "OK"}
        </button>
        <button onClick={() => setEdit(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", fontSize: 12, fontFamily: "inherit" }}>Отмена</button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #F2EFE9", padding: "7px 10px" }}>
      <div style={{ flex: 1, cursor: "pointer" }} onClick={() => setEdit(true)} title="Нажми, чтобы поправить">
        <div style={{ fontSize: 12, color: "#1A1A1A" }}>{a.name}</div>
        <div style={{ fontSize: 10, color: "#A89070" }}>
          {ACCOUNT_SOURCES.find(s => s.v === a.source)?.l || a.source}{a.number ? ` · ${a.number}` : ""}
        </div>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmt(a.balance || 0)}</div>
      <button onClick={async () => { await businessUnitsApi.deleteAccount(a.id); onChanged(); }}
        style={{ background: "none", border: "none", cursor: "pointer", color: "#D0C8C0", padding: 0, display: "flex" }}
        onMouseEnter={e => (e.currentTarget.style.color = "#8B3A3A")}
        onMouseLeave={e => (e.currentTarget.style.color = "#D0C8C0")}>
        <Trash size={13} />
      </button>
    </div>
  );
}

function AddAccountRow({ unitId, onAdded }: { unitId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [source, setSource] = useState("bank");
  const [number, setNumber] = useState("");
  const inputStyle: React.CSSProperties = { boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "6px 9px", fontSize: 12, outline: "none" };
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ background: "none", border: "1px dashed #EDEBE6", cursor: "pointer", fontSize: 12, color: "#A89070", padding: "7px 10px", display: "flex", alignItems: "center", gap: 5 }}>
        <Plus size={11} /> Добавить счёт
      </button>
    );
  }
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", border: "1px solid #E8592A", padding: "7px 10px" }}>
      <input placeholder="Название" value={name} onChange={e => setName(e.target.value)} style={{ ...inputStyle, flex: 1 }} autoFocus />
      <select value={source} onChange={e => setSource(e.target.value)} style={{ ...inputStyle, background: "#fff" }}>
        {ACCOUNT_SOURCES.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
      </select>
      {source === "bank" && <input placeholder="№ счёта" value={number} onChange={e => setNumber(e.target.value)} style={{ ...inputStyle, width: 130 }} />}
      <button disabled={!name.trim()} onClick={async () => {
        await businessUnitsApi.addAccount({ business_unit_id: unitId, name: name.trim(), source, number: number.trim() || null });
        onAdded();
      }} style={{ padding: "6px 12px", border: "none", background: "#E8592A", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600, opacity: name.trim() ? 1 : 0.5 }}>OK</button>
    </div>
  );
}
