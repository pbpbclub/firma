import { useState, useEffect } from "react";
import { MONO } from "./Num";

// Общие селекты калькулятора — вынесены из EstimateEditor для переиспользования
// в калькуляторе сметы и каталога (единый паттерн).

export const selectStyle: React.CSSProperties = {
  width: "100%", border: "none", borderBottom: "1px solid #EDEBE6",
  outline: "none", fontSize: 11, color: "#1A1A1A", background: "transparent",
  padding: "2px 0", boxSizing: "border-box", cursor: "pointer", appearance: "none",
};

export const UNIT_OPTIONS = ["шт", "м.п.", "м²", "м³", "кг", "л", "компл.", "услуга", "ч"];

// Бренды — из domain.ts; реэкспорт сохраняет старые импорты из этого файла.
import { BRANDS } from "../domain";
export { BRANDS };

// ── Редактируемая ячейка (commit на blur/Enter) ───────────────────────────────
export function EditableText({
  value, onSave, numeric, placeholder, align, style,
}: {
  value: string | number | null | undefined;
  onSave: (v: string) => void;
  numeric?: boolean;
  placeholder?: string;
  align?: "left" | "right";
  style?: React.CSSProperties;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(value ?? ""));
  useEffect(() => { if (!editing) setVal(String(value ?? "")); }, [value, editing]);

  if (!editing) {
    return (
      <span
        onClick={e => { e.stopPropagation(); setEditing(true); }}
        style={{
          cursor: "text", display: "inline-block", minWidth: 12, width: "100%",
          textAlign: align ?? "left", fontFamily: numeric ? MONO : undefined, fontVariantNumeric: numeric ? "tabular-nums" : undefined, ...style,
        }}
      >
        {value !== null && value !== undefined && value !== ""
          ? value
          : <span style={{ color: "#C8C0B0" }}>{placeholder || ""}</span>}
      </span>
    );
  }
  return (
    <input
      autoFocus value={val}
      onClick={e => e.stopPropagation()}
      onChange={e => setVal(e.target.value)}
      onBlur={() => { setEditing(false); onSave(val); }}
      onKeyDown={e => {
        if (e.key === "Enter") { setEditing(false); onSave(val); }
        if (e.key === "Escape") setEditing(false);
      }}
      style={{
        width: "100%", border: "none", borderBottom: "1px solid #E8592A",
        outline: "none", fontSize: "inherit", fontFamily: numeric ? MONO : "inherit",
        background: "transparent", padding: "0 2px",
        textAlign: align ?? "left", fontVariantNumeric: numeric ? "tabular-nums" : undefined, ...style,
      }}
    />
  );
}

// ── Бренд (MeRA / pbpb / Транзит), value=null → «—» ───────────────────────────
export function BrandSelect({ value, onChange }: {
  value: string | null;
  onChange: (b: string | null) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {([null, ...BRANDS.map(b => b.value)] as (string | null)[]).map(b => {
        const meta = BRANDS.find(x => x.value === b);
        const color = meta?.color ?? "#A89070";
        const active = value === b;
        return (
          <button
            key={String(b)}
            onClick={() => onChange(active && b ? null : b)}
            style={{
              background: active ? color : "transparent",
              border: `1px solid ${active ? color : "#EDEBE6"}`,
              color: active ? "#FFFFFF" : color,
              fontSize: 11, fontWeight: 600, padding: "4px 8px", cursor: "pointer", fontFamily: MONO,
            }}
          >{b ?? "—"}</button>
        );
      })}
    </div>
  );
}

// ── Единица измерения: пресеты + своя ─────────────────────────────────────────
export function UnitSelect({ value, onSave }: {
  value: string;
  onSave: (unit: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState("");
  const current = value || "шт";
  const isCustom = !UNIT_OPTIONS.includes(current);
  if (adding) {
    return (
      <input
        autoFocus value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={() => { const t = val.trim(); if (t) onSave(t); setAdding(false); setVal(""); }}
        onKeyDown={e => { if (e.key === "Enter") { const t = val.trim(); if (t) onSave(t); setAdding(false); setVal(""); } if (e.key === "Escape") { setAdding(false); setVal(""); } }}
        placeholder="ед."
        style={{ ...selectStyle, borderBottom: "1px solid #E8592A", cursor: "text" }}
      />
    );
  }
  return (
    <select
      value={isCustom ? "__custom__" : current}
      onChange={e => {
        const v = e.target.value;
        if (v === "__add__") { setAdding(true); return; }
        if (v === "__custom__") return;
        onSave(v);
      }}
      style={{ ...selectStyle, color: "#6B6355" }}
    >
      {isCustom && <option value="__custom__">{current}</option>}
      {UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
      <option value="__add__">+ своя…</option>
    </select>
  );
}

// ── Вид работ (для не-материалов) ─────────────────────────────────────────────
export function WorkTypeSelect({ workTypeId, workTypes, onPick, onCreate }: {
  workTypeId: string | null | undefined;
  workTypes: any[];
  onPick: (wt: any | null) => void;
  onCreate: (name: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState("");
  if (adding) {
    return (
      <input
        autoFocus value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={() => { const t = val.trim(); if (t) onCreate(t); setAdding(false); setVal(""); }}
        onKeyDown={e => { if (e.key === "Enter") { const t = val.trim(); if (t) onCreate(t); setAdding(false); setVal(""); } if (e.key === "Escape") { setAdding(false); setVal(""); } }}
        placeholder="Новый вид работ"
        style={{ ...selectStyle, borderBottom: "1px solid #E8592A", cursor: "text", fontSize: 12 }}
      />
    );
  }
  return (
    <select
      value={workTypeId || ""}
      onChange={e => {
        const v = e.target.value;
        if (v === "__add__") { setAdding(true); return; }
        onPick(workTypes.find((w: any) => w.id === v) || null);
      }}
      style={{ ...selectStyle, fontSize: 12, color: workTypeId ? "#1A1A1A" : "#C8C0B0" }}
    >
      <option value="">— работа —</option>
      {workTypes.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
      <option value="__add__">+ Добавить вид работ…</option>
    </select>
  );
}

// ── Исполнитель (секции по виду работ + добавить) ─────────────────────────────
export function ContractorSelect({ masterId, workTypeId, masters, onPickMaster, onCreateMaster }: {
  masterId: string | null | undefined;
  workTypeId: string | null | undefined;
  masters: any[];
  onPickMaster: (masterId: string) => void;
  onCreateMaster: (name: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState("");
  const linked = workTypeId ? masters.filter((m: any) => (m.work_type_ids || []).includes(workTypeId)) : [];
  const linkedIds = new Set(linked.map((m: any) => m.id));
  const others = masters.filter((m: any) => !linkedIds.has(m.id));

  if (adding) {
    return (
      <input
        autoFocus value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={() => { const t = val.trim(); if (t) onCreateMaster(t); setAdding(false); setVal(""); }}
        onKeyDown={e => { if (e.key === "Enter") { const t = val.trim(); if (t) onCreateMaster(t); setAdding(false); setVal(""); } if (e.key === "Escape") { setAdding(false); setVal(""); } }}
        placeholder="Новый исполнитель"
        style={{ ...selectStyle, borderBottom: "1px solid #E8592A", cursor: "text", fontSize: 10 }}
      />
    );
  }
  return (
    <select
      value={masterId || ""}
      onChange={e => {
        const v = e.target.value;
        if (v === "__add__") { setAdding(true); return; }
        if (v) onPickMaster(v);
      }}
      style={{ ...selectStyle, fontSize: 10, color: masterId ? "#1A1A1A" : "#C8C0B0" }}
    >
      <option value="">— исполнитель —</option>
      {linked.length > 0 && (
        <optgroup label="По этому виду работ">
          {linked.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </optgroup>
      )}
      <optgroup label={linked.length > 0 ? "Все исполнители" : "Исполнители"}>
        {others.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </optgroup>
      <option value="__add__">+ Добавить исполнителя…</option>
    </select>
  );
}
