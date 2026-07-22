// Блок «Себестоимость» в редакторе сметы: cost-check (что подставится и откуда,
// чего не хватает) + cost-fill (заполнить) + формы «введи и запомним» для дыр.
// Ответы уходят в справочники (price_book / work_rates / costing_rules) и в
// следующий раз подставляются сами.
import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { estimatesApi, materialsApi, workRatesApi, priceBookApi, costingRulesApi } from "../api";
import { Button } from "./ui/Button";
import { MONO } from "./ui/Num";
import { fmtMoney } from "./ui/format";
import { MaterialTitle } from "./ui/Calc";
import { CaretDown, CaretRight, Sparkle } from "@phosphor-icons/react";

const SOURCE_LABEL: Record<string, string> = {
  materials: "прайс",
  price_book: "выученная цена",
  work_rate: "ставка",
  percent: "% от цены",
  catalog: "каталог",
};

const SCHEME_LABEL: Record<string, string> = {
  per_unit: "₽/ед", hourly: "₽/час", fixed: "фикс за изделие", percent: "% от цены",
};

// ── Формы ответа на «нужен ввод» ─────────────────────────────────────────────

function MissingMaterialForm({ m, onDone }: { m: any; onDone: () => void }) {
  const [price, setPrice] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);

  // Вариант 1: привязать к номенклатуре (прайсы металла) — цена заморозится сама,
  // связка «название → код» запоминается правилом.
  const pickMaterial = async (mat: any) => {
    setBusy(true);
    try {
      await estimatesApi.updateLine(m.id, { material_code: mat.id, price_supplier: mat.supplier, price_date: mat.price_date, unit_price: mat.price ?? undefined });
      if (remember && m.title) {
        try { await costingRulesApi.create({ pattern: m.title, kind: "material", target_id: mat.id }); } catch { /* правило не критично */ }
      }
      onDone();
    } finally { setBusy(false); }
  };

  // Вариант 2: цена руками (материал вне прайсов) + запомнить в price_book.
  const savePrice = async () => {
    const p = parseFloat(price);
    if (!p || p <= 0) return;
    setBusy(true);
    try {
      await estimatesApi.updateLine(m.id, { unit_price: p });
      if (remember && m.title) {
        try { await priceBookApi.create({ title: m.title, price: p, unit: m.unit }); } catch { /* уже есть — ок */ }
      }
      onDone();
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
      <div style={{ width: 220 }}>
        <MaterialTitle value="" materialsFetch={materialsApi.search} onType={() => {}} onPick={pickMaterial} />
      </div>
      <span style={{ fontSize: 10, color: "#A89070" }}>или цена:</span>
      <input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder={`₽/${m.unit || "ед"}`}
        style={{ width: 90, border: "1px solid #EDEBE6", padding: "4px 8px", fontSize: 12, outline: "none", textAlign: "right", fontFamily: MONO }} />
      <Button size="sm" variant="primary" disabled={busy || !parseFloat(price)} onClick={savePrice} style={{ fontSize: 11, padding: "4px 10px" }}>
        {busy ? "..." : "Сохранить"}
      </Button>
      <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#6B6355", cursor: "pointer" }}>
        <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
        запомнить
      </label>
    </div>
  );
}

function MissingRateForm({ m, onDone }: { m: any; onDone: () => void }) {
  const [scheme, setScheme] = useState("per_unit");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const r = parseFloat(rate);
    if (!r || r <= 0) return;
    setBusy(true);
    try {
      // Ставка в справочник (запоминается всегда — в этом смысл), затем цена в строку.
      await workRatesApi.create({
        work_type_id: m.work_type_id || undefined,
        work_type_name: m.work_type_id ? undefined : (m.title || undefined),
        master_id: m.master_id || undefined,
        scheme, rate: r, unit: scheme === "hourly" ? "ч" : "шт",
      });
      onDone();
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
      <select value={scheme} onChange={e => setScheme(e.target.value)}
        style={{ border: "1px solid #EDEBE6", padding: "4px 8px", fontSize: 11, outline: "none", background: "#fff", cursor: "pointer", fontFamily: "inherit" }}>
        {Object.entries(SCHEME_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <input type="number" value={rate} onChange={e => setRate(e.target.value)} placeholder={scheme === "percent" ? "%" : "₽"}
        style={{ width: 90, border: "1px solid #EDEBE6", padding: "4px 8px", fontSize: 12, outline: "none", textAlign: "right", fontFamily: MONO }} />
      <Button size="sm" variant="primary" disabled={busy || !parseFloat(rate)} onClick={save} style={{ fontSize: 11, padding: "4px 10px" }}>
        {busy ? "..." : "Сохранить ставку"}
      </Button>
      <span style={{ fontSize: 10, color: "#A89070" }}>
        {m.master_name ? `для ${m.master_name}` : "дефолт вида работ"} · запомнится в справочнике
      </span>
    </div>
  );
}

// ── Сам блок ─────────────────────────────────────────────────────────────────

export function CostingBlock({ setId, editable, onChanged }: {
  setId: string; editable: boolean; onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);

  const { data: report, refetch } = useQuery({
    queryKey: ["cost-check", setId],
    queryFn: () => estimatesApi.costCheck(setId),
    enabled: !!setId,
  });

  const afterChange = async () => {
    await refetch();
    onChanged();
    qc.invalidateQueries({ queryKey: ["estimates-review-queue"] });
  };

  const fill = useMutation({
    mutationFn: (opts?: any) => estimatesApi.costFill(setId, opts),
    onSuccess: afterChange,
  });

  if (!report) return null;
  const s = report.summary || {};
  const toFill = (s.proposed || 0) + (s.items_expandable || 0);
  const missing: any[] = report.missing || [];
  const nothing = !toFill && !missing.length && !(s.refresh || 0);

  // Список предложений (что и откуда подставится) — для прозрачности перед «Заполнить»
  const proposals = (report.items || []).flatMap((it: any) =>
    (it.lines || []).filter((l: any) => l.status === "proposed").map((l: any) => ({ ...l, item_title: it.title })));
  const expandables = (report.items || []).filter((it: any) => it.catalog_match?.will_expand && !(it.lines || []).length);

  return (
    <div style={{ margin: "8px 28px 0", border: "1px solid #EDEBE6", flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
          background: missing.length ? "#FFF4EE" : "#FAF8F5", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
        {open ? <CaretDown size={11} style={{ color: "#A89070" }} /> : <CaretRight size={11} style={{ color: "#A89070" }} />}
        <Sparkle size={12} style={{ color: "#E8592A" }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: "#1A1A1A", letterSpacing: "0.04em" }}>СЕБЕСТОИМОСТЬ</span>
        <span style={{ fontSize: 11, color: "#6B6355" }}>
          {nothing
            ? "всё заполнено"
            : [
                toFill ? `подставится ${toFill}` : "",
                s.refresh ? `прайс уехал у ${s.refresh}` : "",
                missing.length ? `нужен ввод: ${missing.length}` : "",
              ].filter(Boolean).join(" · ")}
        </span>
        {editable && toFill > 0 && (
          <span style={{ marginLeft: "auto" }} onClick={e => e.stopPropagation()}>
            <Button size="sm" variant="primary" disabled={fill.isPending}
              onClick={() => fill.mutate({})} style={{ fontSize: 11 }}>
              {fill.isPending ? "Заполняю..." : `Заполнить (${toFill})`}
            </Button>
          </span>
        )}
      </button>

      {open && !nothing && (
        <div style={{ padding: "10px 14px", borderTop: "1px solid #F2EFE9" }}>
          {/* Что подставится */}
          {expandables.map((it: any) => (
            <div key={it.item_id} style={{ fontSize: 11, color: "#6B6355", padding: "3px 0" }}>
              «{it.title}» → рецептура «{it.catalog_match.title}» ({it.catalog_match.lines_count} строк, живые цены)
            </div>
          ))}
          {proposals.map((l: any) => (
            <div key={l.line_id} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11, padding: "3px 0" }}>
              <span style={{ color: "#1A1A1A" }}>{l.title || l.type}</span>
              <span style={{ fontFamily: MONO, color: "#4A7C59", fontVariantNumeric: "tabular-nums" }}>
                {fmtMoney(l.proposal?.unit_price)}
              </span>
              <span style={{ fontSize: 9, color: "#A89070", border: "1px solid #EDEBE6", padding: "1px 6px" }}>
                {SOURCE_LABEL[l.source] || l.source}{l.proposal?.price_supplier ? ` · ${l.proposal.price_supplier}` : ""}
              </span>
            </div>
          ))}

          {/* Прайс уехал */}
          {(s.refresh || 0) > 0 && editable && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0", fontSize: 11, color: "#8B3A3A" }}>
              Цены прайса изменились у {s.refresh} строк(и)
              <Button size="sm" disabled={fill.isPending}
                onClick={() => fill.mutate({ refresh_materials: true, expand_items: false })} style={{ fontSize: 10, padding: "3px 10px" }}>
                Перезаморозить по текущим
              </Button>
            </div>
          )}

          {/* Нужен ввод */}
          {missing.length > 0 && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #F2EFE9" }}>
              <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>НУЖЕН ВВОД</div>
              {missing.map((m: any) => (
                <div key={`${m.scope}-${m.id}`} style={{ padding: "6px 0", borderBottom: "1px solid #F7F5F1" }}>
                  <div style={{ fontSize: 11, color: "#1A1A1A" }}>{m.ask}</div>
                  {editable && m.scope === "line" && (m.kind === "no_material_match" || m.kind === "no_price") && (
                    <MissingMaterialForm m={m} onDone={afterChange} />
                  )}
                  {editable && m.scope === "line" && (m.kind === "no_rate" || m.kind === "no_work_type") && (
                    <MissingRateForm m={m} onDone={() => fill.mutate({})} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
