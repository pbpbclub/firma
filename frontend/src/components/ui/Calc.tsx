import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "@phosphor-icons/react";
import { UnitSelect, WorkTypeSelect, ContractorSelect, EditableText } from "./Selects";
import { pctToMarkup, fmtMoney, fmtNum } from "./priceMath";
import { MONO } from "./Num";

// ── Единый калькулятор: шапка колонок, секция, строка, футер цены ─────────────
//
// Колонки (канон):  Наименование · Кол-во · Ед. · Цена · Сумма · [Исполнитель] · ×
// Строка презентационная: правки уходят через onPatch(partial); владелец данных
// (Catalog — локальный стейт, EstimateEditor — гранулярный API) решает, как сохранять.

const labelStyle: React.CSSProperties = { fontSize: 10, color: "#A89070", letterSpacing: "0.04em" };
const sectionLabelStyle: React.CSSProperties = { ...labelStyle, marginTop: 18, marginBottom: 6, textTransform: "uppercase" };
const numCell: React.CSSProperties = { fontSize: 12, color: "#1A1A1A", textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" };

function cols(withContractor?: boolean) {
  return withContractor
    ? "1fr 60px 72px 90px 80px 130px 20px"
    : "1fr 60px 72px 90px 80px 20px";
}

export function CalcHeader({ withContractor }: { withContractor?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: cols(withContractor), gap: 8, padding: "0 0 4px" }}>
      <div style={labelStyle}>Наименование</div>
      <div style={{ ...labelStyle, textAlign: "right" }}>Кол-во</div>
      <div style={labelStyle}>Ед.</div>
      <div style={{ ...labelStyle, textAlign: "right" }}>Цена</div>
      <div style={{ ...labelStyle, textAlign: "right" }}>Сумма</div>
      {withContractor && <div style={labelStyle}>Исполнитель</div>}
      <div />
    </div>
  );
}

export function CalcSection({ label, addLabel, onAdd, children }: {
  label: string;
  addLabel: string;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={sectionLabelStyle}>{label}</div>
      {children}
      <button
        onClick={onAdd}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#A89070", padding: "6px 0", display: "flex", alignItems: "center", gap: 4 }}
        onMouseEnter={e => (e.currentTarget.style.color = "#E8592A")}
        onMouseLeave={e => (e.currentTarget.style.color = "#A89070")}
      >
        <Plus size={11} /> {addLabel}
      </button>
    </div>
  );
}

function MaterialTitle({ value, materialsFetch, onType, onPick }: {
  value: string;
  materialsFetch: (q?: string) => Promise<any[]>;
  onType: (v: string) => void;
  onPick: (m: any) => void;
}) {
  const [search, setSearch] = useState(value);
  const [show, setShow] = useState(false);
  const { data: suggestions = [] } = useQuery({
    queryKey: ["materials-suggest", search],
    queryFn: () => materialsFetch(search || undefined),
    enabled: show && search.length > 0,
  });
  return (
    <div style={{ position: "relative" }}>
      <input
        value={search}
        placeholder="Материал"
        onChange={e => { setSearch(e.target.value); setShow(true); onType(e.target.value); }}
        onBlur={() => setTimeout(() => setShow(false), 150)}
        style={{ width: "100%", border: "none", borderBottom: "1px solid #EDEBE6", outline: "none", fontSize: 12, color: "#1A1A1A", background: "transparent", padding: "2px 0", boxSizing: "border-box" }}
      />
      {show && (suggestions as any[]).length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 100, background: "#FFFFFF", border: "1px solid #EDEBE6", boxShadow: "0 4px 16px rgba(0,0,0,0.08)", maxHeight: 180, overflowY: "auto" }}>
          {(suggestions as any[]).map((m: any) => (
            <div key={m.id}
              onMouseDown={() => { setSearch(m.name); setShow(false); onPick(m); }}
              style={{ padding: "7px 10px", fontSize: 12, cursor: "pointer", borderBottom: "1px solid #F2EFE9" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            >
              <span style={{ color: "#1A1A1A" }}>{m.name}</span>
              <span style={{ color: "#A89070", marginLeft: 8 }}>{m.unit} · {fmtMoney(m.price)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CalcRow({
  line, isMaterial, withContractor, withAutocomplete, materialsFetch,
  workTypes = [], masters = [],
  onPatch, onRemove, onPickMaterial, onPickWorkType, onCreateWorkType, onPickMaster, onCreateMaster,
}: {
  line: any;
  isMaterial: boolean;
  withContractor?: boolean;
  withAutocomplete?: boolean;
  materialsFetch?: (q?: string) => Promise<any[]>;
  workTypes?: any[];
  masters?: any[];
  onPatch: (patch: Record<string, any>) => void;
  onRemove: () => void;
  onPickMaterial?: (m: any) => void;
  onPickWorkType?: (wt: any | null) => void;
  onCreateWorkType?: (name: string) => void;
  onPickMaster?: (id: string) => void;
  onCreateMaster?: (name: string) => void;
}) {
  const sum = (line.qty || 0) * (line.unit_price || 0);
  return (
    <div style={{ display: "grid", gridTemplateColumns: cols(withContractor), gap: 8, alignItems: "center", padding: "6px 0", borderBottom: "1px solid #F2EFE9" }}>
      {/* Наименование */}
      <div style={{ fontSize: 12, color: "#1A1A1A" }}>
        {isMaterial && withAutocomplete && materialsFetch ? (
          <MaterialTitle
            value={line.title}
            materialsFetch={materialsFetch}
            onType={v => onPatch({ title: v, material_id: undefined })}
            onPick={m => (onPickMaterial ?? (() => {}))(m)}
          />
        ) : !isMaterial && onPickWorkType ? (
          <WorkTypeSelect
            workTypeId={line.work_type_id}
            workTypes={workTypes}
            onPick={wt => onPickWorkType(wt)}
            onCreate={name => (onCreateWorkType ?? (() => {}))(name)}
          />
        ) : (
          <EditableText value={line.title} placeholder="Наименование" onSave={v => onPatch({ title: v })} />
        )}
      </div>
      {/* Кол-во */}
      <div style={{ fontSize: 12 }}>
        <EditableText value={line.qty} numeric align="right" onSave={v => onPatch({ qty: parseFloat(v) || 0 })} />
      </div>
      {/* Ед. */}
      <div style={{ fontSize: 11, color: "#6B6355" }}>
        <UnitSelect value={line.unit} onSave={v => onPatch({ unit: v })} />
      </div>
      {/* Цена */}
      <div style={{ fontSize: 12 }}>
        <EditableText value={line.unit_price} numeric align="right" onSave={v => onPatch({ unit_price: parseFloat(v) || 0 })} />
      </div>
      {/* Сумма */}
      <div style={{ ...numCell, fontWeight: 600 }}>{sum > 0 ? fmtNum(sum) : "—"}</div>
      {/* Исполнитель */}
      {withContractor && (
        <ContractorSelect
          masterId={line.master_id}
          workTypeId={line.work_type_id}
          masters={masters}
          onPickMaster={id => (onPickMaster ?? (() => {}))(id)}
          onCreateMaster={name => (onCreateMaster ?? (() => {}))(name)}
        />
      )}
      {/* Удалить */}
      <button onClick={onRemove}
        style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 0, display: "flex", alignItems: "center" }}
        onMouseEnter={e => (e.currentTarget.style.color = "#8B3A3A")}
        onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}
      >
        <X size={13} />
      </button>
    </div>
  );
}

// ── Футер цены: Себестоимость → Наценка% (×mult) → Цена клиенту ────────────────
// withQuantity=false (каталог, per-1): одна колонка, наценка редактируется (onPctChange).
// withQuantity=true  (смета): «за шт» + «итого ×N», наценка read-only (P0: цена в смете отложена).
export function CalcFooter({ cost, pct, onPctChange, withQuantity, quantity = 1 }: {
  cost: number;
  pct: number;
  onPctChange?: (pct: number) => void;
  withQuantity?: boolean;
  quantity?: number;
}) {
  const mult = pctToMarkup(pct);
  const amt = cost * pct / 100;
  const price = cost + amt;
  const q = withQuantity ? (quantity || 1) : 1;

  const colLabel: React.CSSProperties = { ...labelStyle, textAlign: "right" };
  const rowLabel: React.CSSProperties = { fontSize: 12, color: "#A89070" };

  // grid: метка | [за шт] | итого
  const grid = withQuantity ? "1fr 110px 110px" : "1fr 130px";

  return (
    <div style={{ borderTop: "2px solid #EDEBE6", padding: "14px 24px 4px" }}>
      <div style={{ display: "grid", gridTemplateColumns: grid, gap: 8, alignItems: "center", marginBottom: 6 }}>
        <div />
        {withQuantity && <div style={colLabel}>ЗА ШТ</div>}
        <div style={colLabel}>{withQuantity ? `ИТОГО ·×${q}` : ""}</div>
      </div>

      {/* Себестоимость */}
      <div style={{ display: "grid", gridTemplateColumns: grid, gap: 8, alignItems: "center", padding: "3px 0" }}>
        <div style={rowLabel}>Себестоимость</div>
        {withQuantity && <div style={numCell}>{fmtMoney(cost)}</div>}
        <div style={{ ...numCell, fontWeight: 600 }}>{fmtMoney(cost * q)}</div>
      </div>

      {/* Наценка */}
      <div style={{ display: "grid", gridTemplateColumns: grid, gap: 8, alignItems: "center", padding: "3px 0" }}>
        <div style={{ ...rowLabel, display: "flex", alignItems: "center", gap: 6 }}>
          <span>Наценка</span>
          {onPctChange ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
              <input
                type="number" min="0" max="1000" value={pct}
                onChange={e => onPctChange(parseFloat(e.target.value) || 0)}
                style={{ width: 52, border: "1px solid #EDEBE6", background: "transparent", fontSize: 12, color: "#1A1A1A", outline: "none", padding: "3px 6px", textAlign: "right", fontFamily: MONO }}
              />
              <span style={{ fontSize: 11 }}>%</span>
            </span>
          ) : (
            <span style={{ color: "#1A1A1A", fontWeight: 600 }}>{pct}%</span>
          )}
          <span style={{ fontSize: 10, color: "#C8C0B0" }}>·×{mult}</span>
        </div>
        {withQuantity && <div style={numCell}>+{fmtNum(amt)}</div>}
        <div style={numCell}>+{fmtNum(amt * q)}</div>
      </div>

      {/* Цена клиенту */}
      <div style={{ display: "grid", gridTemplateColumns: grid, gap: 8, alignItems: "center", borderTop: "1px solid #EDEBE6", marginTop: 6, paddingTop: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1A1A" }}>Цена клиенту</div>
        {withQuantity && <div style={{ ...numCell, fontSize: 13, fontWeight: 700, color: "#6B6355" }}>{fmtMoney(price)}</div>}
        <div style={{ ...numCell, fontSize: 15, fontWeight: 700, color: "#E8592A" }}>{fmtMoney(price * q)}</div>
      </div>
    </div>
  );
}
