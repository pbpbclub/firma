import { useState, useEffect } from "react";
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

export function CalcSection({ label, addLabel, onAdd, children, readOnly }: {
  label: string;
  addLabel: string;
  onAdd: () => void;
  children: React.ReactNode;
  readOnly?: boolean;
}) {
  return (
    <div>
      <div style={sectionLabelStyle}>{label}</div>
      {children}
      {!readOnly && (
        <button type="button"
          onClick={onAdd}
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#A89070", padding: "6px 0", display: "flex", alignItems: "center", gap: 4 }}
          onMouseEnter={e => (e.currentTarget.style.color = "#E8592A")}
          onMouseLeave={e => (e.currentTarget.style.color = "#A89070")}
        >
          <Plus size={11} /> {addLabel}
        </button>
      )}
    </div>
  );
}

/** Самая дешёвая цена по каждому ПОСТАВЩИКУ.
 *
 *  materials.search.alternatives — это вся история цен по коду, отсортированная по
 *  возрастанию: один поставщик встречается там много раз с разными датами. Показывать
 *  список как есть — шум; нужен один ряд на поставщика. */
function bySupplier(m: any): any[] {
  const best = new Map<string, any>();
  for (const a of (m.alternatives || [])) {
    if (a.price == null) continue;
    const cur = best.get(a.supplier);
    if (!cur || a.price < cur.price) best.set(a.supplier, a);
  }
  return [...best.values()].sort((x, y) => x.price - y.price);
}

export function MaterialTitle({ value, materialsFetch, onType, onPick }: {
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
              <span style={{ color: "#A89070", marginLeft: 8 }}>{m.unit} · {m.no_price ? "нет цены" : fmtMoney(m.price)}</span>
              {m.supplier_label && !m.no_price && <span style={{ color: "#4A7C59", marginLeft: 6, fontSize: 10 }}>{m.supplier_label}</span>}
              {/* Раньше здесь стояла глухая пометка «(деш.)»: система знала цены всех
                  поставщиков и не показывала ни одной. Данные приходят в том же ответе
                  (materials.search.alternatives) — второго запроса не нужно. */}
              {bySupplier(m).length > 1 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                  {bySupplier(m).map((alt: any) => {
                    const active = alt.supplier === m.supplier && alt.price === m.price;
                    return (
                      <span key={alt.supplier}
                        onMouseDown={e => {
                          e.stopPropagation();
                          setSearch(m.name); setShow(false);
                          // Выбор поставщика = выбор его цены: пишем в строку сметы
                          // именно её, а не самую дешёвую по умолчанию.
                          onPick({ ...m, price: alt.price, unit: alt.unit || m.unit,
                                   supplier: alt.supplier, supplier_label: alt.supplier_label,
                                   price_date: alt.price_date });
                        }}
                        title={`Взять цену: ${alt.supplier_label} ${fmtMoney(alt.price)}${alt.price_date ? ` от ${alt.price_date}` : ""}`}
                        style={{ fontSize: 10, padding: "2px 6px", border: "1px solid",
                          borderColor: active ? "#4A7C59" : "#EDEBE6",
                          color: active ? "#4A7C59" : "#6B6355", background: "#fff" }}>
                        {alt.supplier_label} {fmtMoney(alt.price)}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CalcRow({
  line, isMaterial, withContractor, withAutocomplete, materialsFetch,
  workTypes = [], masters = [], readOnly,
  onPatch, onRemove, onPickMaterial, onPickWorkType, onCreateWorkType, onPickMaster, onCreateMaster,
}: {
  line: any;
  isMaterial: boolean;
  withContractor?: boolean;
  withAutocomplete?: boolean;
  materialsFetch?: (q?: string) => Promise<any[]>;
  workTypes?: any[];
  masters?: any[];
  readOnly?: boolean;
  onPatch: (patch: Record<string, any>) => void;
  onRemove: () => void;
  onPickMaterial?: (m: any) => void;
  onPickWorkType?: (wt: any | null) => void;
  onCreateWorkType?: (name: string) => void;
  onPickMaster?: (id: string) => void;
  onCreateMaster?: (name: string) => void;
}) {
  const sum = (line.qty || 0) * (line.unit_price || 0);

  if (readOnly) {
    const contractor = masters.find((m: any) => m.id === line.master_id)?.name || line.contractor_name || "";
    return (
      <div style={{ display: "grid", gridTemplateColumns: cols(withContractor), gap: 8, alignItems: "center", padding: "6px 0", borderBottom: "1px solid #F2EFE9" }}>
        <div style={{ fontSize: 12, color: "#1A1A1A" }}>
          {line.title || "—"}
          {!!line.internal && <span title="Внутренняя строка: в себестоимости есть, обязательства не рождает" style={{ marginLeft: 6, fontSize: 9, color: "#B8860B" }}>внутр.</span>}
        </div>
        <div style={numCell}>{line.qty ?? "—"}</div>
        <div style={{ fontSize: 11, color: "#6B6355" }}>{line.unit || ""}</div>
        <div style={numCell}>{line.unit_price ? fmtNum(line.unit_price) : "—"}</div>
        <div style={{ ...numCell, fontWeight: 600 }}>{sum > 0 ? fmtNum(sum) : "—"}</div>
        {withContractor && <div style={{ fontSize: 10, color: contractor ? "#1A1A1A" : "#C8C0B0" }}>{contractor || "—"}</div>}
        <div />
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: cols(withContractor), gap: 8, alignItems: "center", padding: "6px 0", borderBottom: "1px solid #F2EFE9" }}>
      {/* Наименование. «внутр.» — резерв/наценка: в себестоимость входит,
          обязательства при утверждении не рождает (ТЗ 03.09.2026, п.3). */}
      <div style={{ fontSize: 12, color: "#1A1A1A", display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
        {isMaterial && withAutocomplete && materialsFetch ? (
          <MaterialTitle
            value={line.title}
            materialsFetch={materialsFetch}
            onType={v => onPatch({ title: v, material_id: undefined, material_code: undefined, price_supplier: undefined, price_date: undefined })}
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
        {withContractor && (
          <button type="button" onClick={() => onPatch({ internal: !line.internal })}
            title={line.internal ? "Внутренняя строка (резерв, наценка): обязательства не рождает. Снять?" : "Пометить внутренней: резерв, наценка, округление — никому не должны"}
            style={{ fontSize: 9, padding: "1px 5px", border: `1px solid ${line.internal ? "#B8860B" : "#EDEBE6"}`,
                     color: line.internal ? "#B8860B" : "#C8C0B0", background: "none", cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
            внутр.
          </button>
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
      <button type="button" onClick={onRemove}
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
// withQuantity=false (каталог, per-1): одна колонка. withQuantity=true (смета): «за шт» + «итого ×N».
// Двусторонний ввод: onPctChange — коэффициент → цена; onPriceChange — цена (за шт) → наценка.
// Якорь = цена (решение Юры 23.07.2026): при изменении себестоимости цена клиенту держится,
// коэффициент подстраивается. При cost=0 наценка заблокирована (нечего умножать), цена — свободно.
export function CalcFooter({ cost, pct, price, onPctChange, onPriceChange, withQuantity, quantity = 1 }: {
  cost: number;
  pct: number;
  price?: number | null;   // зафиксированная цена (за шт): показывается точно, без дрейфа от округлённого %
  onPctChange?: (pct: number) => void;
  onPriceChange?: (pricePerUnit: number) => void;
  withQuantity?: boolean;
  quantity?: number;
}) {
  // Локальные драфты: живой пересчёт цифр при наборе, но коммит наверх (API) —
  // только по blur/Enter. editingPrice/editingPct — какое поле сейчас «ведёт».
  const [pctDraft, setPctDraft] = useState(String(pct));
  const [priceDraft, setPriceDraft] = useState("");
  const [editingPrice, setEditingPrice] = useState(false);
  const [editingPct, setEditingPct] = useState(false);
  useEffect(() => { setPctDraft(String(pct)); }, [pct]);

  const q = withQuantity ? (quantity || 1) : 1;
  const pctDisabled = !!onPctChange && cost <= 0;

  // Ведущее значение: набор цены → наценка производная; набор наценки → цена производная;
  // покой → приоритет у зафиксированной цены (якорь = цена), иначе цена из наценки.
  const priceVal = editingPrice
    ? (parseFloat(priceDraft) || 0)
    : editingPct
      ? cost * (1 + (parseFloat(pctDraft) || 0) / 100)
      : (price != null && price > 0 ? price : cost * (1 + (parseFloat(pctDraft) || 0) / 100));
  const priceLeads = editingPrice || (!editingPct && price != null && price > 0);
  const pctVal = priceLeads && cost > 0
    ? Math.round((priceVal / cost - 1) * 1000) / 10
    : (parseFloat(pctDraft) || 0);
  const mult = pctToMarkup(pctVal);
  const amt = priceVal - cost;

  const commitPct = () => { setEditingPct(false); onPctChange?.(parseFloat(pctDraft) || 0); };
  const commitPrice = () => {
    setEditingPrice(false);
    const v = parseFloat(priceDraft);
    if (!Number.isNaN(v) && v >= 0) onPriceChange?.(v);
    setPriceDraft("");
  };
  const onEnterBlur = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  };

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
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
              title={pctDisabled ? "Себестоимость пуста — наценке нечего умножать. Задай состав или цену." : undefined}>
              <input
                type="number" min="0" max="1000"
                value={editingPct ? pctDraft : pctVal}
                disabled={pctDisabled || editingPrice}
                onFocus={() => { setEditingPct(true); setPctDraft(String(pctVal)); }}
                onChange={e => setPctDraft(e.target.value)}
                onBlur={commitPct}
                onKeyDown={onEnterBlur}
                style={{ width: 64, border: "1px solid #EDEBE6", background: "transparent", fontSize: 12, color: pctDisabled ? "#C8C0B0" : "#1A1A1A", outline: "none", padding: "3px 6px", textAlign: "right", fontFamily: MONO, opacity: pctDisabled ? 0.6 : 1 }}
              />
              <span style={{ fontSize: 11 }}>%</span>
            </span>
          ) : (
            <span style={{ color: "#1A1A1A", fontWeight: 600 }}>{pctVal}%</span>
          )}
          <span style={{ fontSize: 10, color: "#C8C0B0" }}>·×{mult}</span>
        </div>
        {withQuantity && <div style={numCell}>+{fmtNum(amt)}</div>}
        <div style={numCell}>+{fmtNum(amt * q)}</div>
      </div>

      {/* Цена клиенту: с onPriceChange «за шт» (или единственная ячейка) — инпут */}
      <div style={{ display: "grid", gridTemplateColumns: grid, gap: 8, alignItems: "center", borderTop: "1px solid #EDEBE6", marginTop: 6, paddingTop: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#1A1A1A" }}>
          Цена клиенту
          {onPriceChange && <span style={{ fontSize: 10, fontWeight: 400, color: "#C8C0B0", marginLeft: 6 }}>{withQuantity ? "ввод — за шт" : "можно ввести"}</span>}
        </div>
        {onPriceChange ? (
          <>
            <div style={{ textAlign: "right" }}>
              <input
                type="number" min="0"
                value={editingPrice ? priceDraft : (Math.round(priceVal * 100) / 100 || "")}
                placeholder="0"
                onFocus={() => { setEditingPrice(true); setPriceDraft(priceVal > 0 ? String(Math.round(priceVal * 100) / 100) : ""); }}
                onChange={e => setPriceDraft(e.target.value)}
                onBlur={commitPrice}
                onKeyDown={onEnterBlur}
                style={{ width: 96, border: "1px solid #E8592A", background: "transparent", fontSize: withQuantity ? 13 : 15, fontWeight: 700, color: "#E8592A", outline: "none", padding: "4px 8px", textAlign: "right", fontFamily: MONO }}
              />
            </div>
            {withQuantity && <div style={{ ...numCell, fontSize: 15, fontWeight: 700, color: "#E8592A" }}>{fmtMoney(priceVal * q)}</div>}
          </>
        ) : (
          <>
            {withQuantity && <div style={{ ...numCell, fontSize: 13, fontWeight: 700, color: "#6B6355" }}>{fmtMoney(priceVal)}</div>}
            <div style={{ ...numCell, fontSize: 15, fontWeight: 700, color: "#E8592A" }}>{fmtMoney(priceVal * q)}</div>
          </>
        )}
      </div>
    </div>
  );
}
