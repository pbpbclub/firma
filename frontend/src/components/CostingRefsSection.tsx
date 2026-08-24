// Справочники себестоимости (страница Настройки): ставки работ + выученные цены.
// Наполняются тремя путями: bootstrap из вики подрядчиков, ответы «нужен ввод»
// в смете/у финагента, авто-обучение при утверждении смет.
import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Plus, ArrowsClockwise, Trash, X } from "@phosphor-icons/react";
import { workRatesApi, priceBookApi, workTypesApi, mastersApi } from "../api";
import { MONO } from "./ui/Num";
import { fmtMoney } from "./ui/format";

const SCHEME_LABEL: Record<string, string> = {
  per_unit: "₽/ед", hourly: "₽/час", fixed: "фикс/изделие", percent: "% от цены",
};
const SOURCE_LABEL: Record<string, string> = {
  manual: "вручную", wiki: "из вики", learned: "выучено", history: "из истории",
};

const label = { fontSize: 10, color: "#A89070", letterSpacing: "0.08em", fontWeight: 600 } as React.CSSProperties;
const inputStyle: React.CSSProperties = { boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "6px 8px", fontSize: 12, outline: "none", fontFamily: "inherit" };

export function CostingRefsSection() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["work-rates"] });

  const { data: ratesData } = useQuery({ queryKey: ["work-rates"], queryFn: workRatesApi.list });
  const { data: priceBook = [] } = useQuery({ queryKey: ["price-book"], queryFn: () => priceBookApi.list() });
  const { data: workTypes = [] } = useQuery({ queryKey: ["work-types"], queryFn: workTypesApi.list });
  const { data: masters = [] } = useQuery({ queryKey: ["masters-flat"], queryFn: () => mastersApi.list().then((d: any) => Array.isArray(d) ? d : d?.masters ?? []) });

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ work_type_id: "", master_id: "", scheme: "per_unit", rate: "", unit: "шт" });

  const bootstrap = useMutation({ mutationFn: workRatesApi.bootstrap, onSuccess: inv });
  const addRate = useMutation({
    mutationFn: () => workRatesApi.create({
      work_type_id: form.work_type_id, master_id: form.master_id || null,
      scheme: form.scheme, rate: parseFloat(form.rate) || 0, unit: form.unit || null,
    }),
    onSuccess: () => { inv(); setAdding(false); setForm({ work_type_id: "", master_id: "", scheme: "per_unit", rate: "", unit: "шт" }); },
  });
  const delRate = useMutation({ mutationFn: (id: string) => workRatesApi.delete(id), onSuccess: inv });

  // Ступени по объёму партии: гибка стоит 450 ₽ на разовом изделии и 325 ₽ от 10 штук
  const [tierFor, setTierFor] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [tierForm, setTierForm] = useState({ min_qty: "", rate: "" });
  const addTier = useMutation({
    mutationFn: ({ rateId }: { rateId: string }) => workRatesApi.addTier(rateId, {
      min_qty: parseInt(tierForm.min_qty, 10), rate: parseFloat(tierForm.rate),
    }),
    onSuccess: () => { inv(); setTierForm({ min_qty: "", rate: "" }); },
  });
  const delTier = useMutation({ mutationFn: (id: string) => workRatesApi.deleteTier(id), onSuccess: inv });
  const link = useMutation({
    mutationFn: ({ wt, master }: { wt: string; master: string }) => workTypesApi.linkMaster(wt, master),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["masters"] }),
  });
  const unlink = useMutation({
    mutationFn: ({ wt, master }: { wt: string; master: string }) => workTypesApi.unlinkMaster(wt, master),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["masters"] }),
  });
  const delPrice = useMutation({
    mutationFn: (id: number) => priceBookApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["price-book"] }),
  });

  const rates: any[] = ratesData?.rates ?? [];
  const holes: any[] = ratesData?.work_types_without_rate ?? [];

  return (
    <div style={{ marginBottom: 40 }}>
      {/* ── Ставки работ ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div style={label}>СТАВКИ РАБОТ (СЕБЕСТОИМОСТЬ)</div>
        <button onClick={() => bootstrap.mutate()} disabled={bootstrap.isPending}
          title="Первичное наполнение: схемы оплаты из вики подрядчиков + история обязательств"
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, background: "none", border: "1px solid #EDEBE6", padding: "4px 10px", fontSize: 11, cursor: "pointer", color: "#6B6355", fontFamily: "inherit" }}>
          <ArrowsClockwise size={11} /> {bootstrap.isPending ? "..." : "Импорт из вики"}
        </button>
        <button onClick={() => setAdding(v => !v)}
          style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "1px solid #EDEBE6", padding: "4px 10px", fontSize: 11, cursor: "pointer", color: "#6B6355", fontFamily: "inherit" }}>
          <Plus size={11} /> Добавить
        </button>
      </div>

      {bootstrap.data && (
        <div style={{ fontSize: 11, color: "#4A7C59", marginBottom: 10 }}>
          Импорт: создано {bootstrap.data.created}, уже было {bootstrap.data.skipped}
        </div>
      )}

      {adding && (
        <div style={{ border: "1px solid #EDEBE6", padding: 14, marginBottom: 14, background: "#FAF8F5", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", marginBottom: 3 }}>ВИД РАБОТ</div>
            <select value={form.work_type_id} onChange={e => setForm(f => ({ ...f, work_type_id: e.target.value }))} style={{ ...inputStyle, cursor: "pointer", minWidth: 150 }}>
              <option value="">—</option>
              {(workTypes as any[]).map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", marginBottom: 3 }}>ИСПОЛНИТЕЛЬ</div>
            <select value={form.master_id} onChange={e => setForm(f => ({ ...f, master_id: e.target.value }))} style={{ ...inputStyle, cursor: "pointer", minWidth: 150 }}>
              <option value="">— дефолт вида работ —</option>
              {(masters as any[]).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", marginBottom: 3 }}>СХЕМА</div>
            <select value={form.scheme} onChange={e => setForm(f => ({ ...f, scheme: e.target.value }))} style={{ ...inputStyle, cursor: "pointer" }}>
              {Object.entries(SCHEME_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#A89070", marginBottom: 3 }}>СТАВКА</div>
            <input type="number" value={form.rate} onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} style={{ ...inputStyle, width: 100, textAlign: "right", fontFamily: MONO }} />
          </div>
          <button onClick={() => addRate.mutate()} disabled={!form.work_type_id || !parseFloat(form.rate) || addRate.isPending}
            style={{ background: "#1A1A1A", color: "#FFF", border: "none", padding: "7px 18px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
            {addRate.isPending ? "..." : "Сохранить"}
          </button>
        </div>
      )}

      {holes.length > 0 && (
        <div style={{ fontSize: 11, color: "#8B3A3A", marginBottom: 10 }}>
          Без ставок: {holes.map((h: any) => h.name).join(", ")} — спросится при заполнении сметы
        </div>
      )}

      {rates.length === 0 ? (
        <div style={{ color: "#A89070", fontSize: 13 }}>Ставок пока нет — нажми «Импорт из вики» или отвечай на вопросы в сметах</div>
      ) : (
        <div style={{ border: "1px solid #EDEBE6" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 110px 110px 90px 40px", padding: "8px 12px", borderBottom: "1px solid #EDEBE6", background: "#FAF8F5" }}>
            {["ВИД РАБОТ", "ИСПОЛНИТЕЛЬ", "СХЕМА", "СТАВКА", "ОТКУДА", ""].map((h, i) => (
              <div key={i} style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.05em", textAlign: i === 3 ? "right" : "left", paddingRight: i === 3 ? 12 : 0 }}>{h}</div>
            ))}
          </div>
          {rates.map((r: any) => {
            const tiers: any[] = r.tiers ?? [];
            const open = tierFor === r.id;
            const showTierRow = open || tiers.length > 0 || hoverId === r.id;
            return (
            <div key={r.id} style={{ borderBottom: "1px solid #F2EFE9" }}
                 onMouseEnter={() => setHoverId(r.id)} onMouseLeave={() => setHoverId(null)}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 110px 110px 90px 40px", padding: "9px 12px", alignItems: "center" }}>
                <div style={{ fontSize: 12, color: "#1A1A1A" }}>{r.work_type_name}</div>
                <div style={{ fontSize: 12, color: r.master_name ? "#1A1A1A" : "#A89070" }}>{r.master_name || "дефолт"}</div>
                <div style={{ fontSize: 11, color: "#6B6355" }}>{SCHEME_LABEL[r.scheme] || r.scheme}</div>
                <div style={{ fontSize: 12, textAlign: "right", paddingRight: 12, fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                  {r.scheme === "percent" ? `${r.rate}%` : fmtMoney(r.rate)}
                </div>
                <div style={{ fontSize: 10, color: "#A89070" }} title={r.note || ""}>{SOURCE_LABEL[r.source] || r.source}</div>
                <button onClick={() => delRate.mutate(r.id)}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", display: "flex", justifyContent: "flex-end", padding: 2 }}
                  onMouseEnter={e => (e.currentTarget.style.color = "#8B3A3A")}
                  onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}>
                  <Trash size={13} />
                </button>
              </div>

              {/* Ступени по объёму: пусто — работает базовая ставка выше */}
              {showTierRow && <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "0 12px 9px 12px" }}>
                {tiers.map((t: any) => (
                  <span key={t.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #EDEBE6", background: "#FAF8F5", padding: "3px 6px", fontSize: 11, color: "#6B6355" }}>
                    <span>от {t.min_qty} шт —</span>
                    <span style={{ fontFamily: MONO, color: "#1A1A1A" }}>{r.scheme === "percent" ? `${t.rate}%` : fmtMoney(t.rate)}</span>
                    <button onClick={() => delTier.mutate(t.id)} title="Удалить ступень"
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 0, display: "flex" }}
                      onMouseEnter={e => (e.currentTarget.style.color = "#8B3A3A")}
                      onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}>
                      <Trash size={11} />
                    </button>
                  </span>
                ))}
                {open ? (
                  <>
                    <input type="number" placeholder="от N шт" value={tierForm.min_qty}
                      onChange={e => setTierForm(f => ({ ...f, min_qty: e.target.value }))}
                      style={{ ...inputStyle, width: 80, padding: "3px 6px", fontSize: 11, fontFamily: MONO }} />
                    <input type="number" placeholder="₽" value={tierForm.rate}
                      onChange={e => setTierForm(f => ({ ...f, rate: e.target.value }))}
                      style={{ ...inputStyle, width: 80, padding: "3px 6px", fontSize: 11, textAlign: "right", fontFamily: MONO }} />
                    <button onClick={() => addTier.mutate({ rateId: r.id })}
                      disabled={!parseInt(tierForm.min_qty, 10) || !parseFloat(tierForm.rate) || addTier.isPending}
                      style={{ border: "1px solid #E8592A", background: "#E8592A", color: "#fff", fontSize: 11, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit" }}>
                      {addTier.isPending ? "..." : "Добавить"}
                    </button>
                    <button onClick={() => { setTierFor(null); setTierForm({ min_qty: "", rate: "" }); }}
                      style={{ border: "1px solid #EDEBE6", background: "none", color: "#6B6355", fontSize: 11, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit" }}>
                      Готово
                    </button>
                  </>
                ) : (
                  <button onClick={() => { setTierFor(r.id); setTierForm({ min_qty: "", rate: "" }); }}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid #EDEBE6", background: "none", color: "#A89070", fontSize: 11, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>
                    <Plus size={11} /> {tiers.length ? "ступень" : "ступень по объёму"}
                  </button>
                )}
              </div>}
            </div>
            );
          })}
        </div>
      )}

      {/* ── Кто что делает: мастера ↔ виды работ ──
          Связки хранит master_work_types; ContractorSelect по ним группирует
          исполнителей «По этому виду работ» в строке сметы. Привязать существующего
          мастера из интерфейса было нельзя — связка рождалась только при создании
          нового мастера прямо из калькулятора. */}
      <div style={{ ...label, margin: "26px 0 6px" }}>КТО ЧТО ДЕЛАЕТ</div>
      <div style={{ fontSize: 11, color: "#A89070", marginBottom: 12, lineHeight: 1.5 }}>
        В смете такие исполнители поднимаются наверх списка для своего вида работ.
      </div>
      <div style={{ border: "1px solid #EDEBE6" }}>
        {(workTypes as any[]).map((wt: any) => {
          // Источник привязок — work_type_ids из уже загруженного списка мастеров:
          // запрос /work-types/{id}/masters на каждый вид дал бы N+1.
          const linked = (masters as any[]).filter((m: any) => (m.work_type_ids || []).includes(wt.id));
          const free = (masters as any[]).filter((m: any) => !(m.work_type_ids || []).includes(wt.id));
          return (
            <div key={wt.id} style={{ display: "grid", gridTemplateColumns: "160px 1fr 190px", gap: 10,
                   padding: "9px 12px", borderBottom: "1px solid #F2EFE9", alignItems: "center" }}>
              <div style={{ fontSize: 12, color: "#1A1A1A" }}>{wt.name}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {linked.length === 0 && <span style={{ fontSize: 11, color: "#C8C0B0" }}>никто не назначен</span>}
                {linked.map((m: any) => (
                  <span key={m.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11,
                         border: "1px solid #EDEBE6", padding: "3px 6px 3px 9px", color: "#6B6355" }}>
                    {m.name}
                    <button onClick={() => unlink.mutate({ wt: wt.id, master: m.id })} disabled={unlink.isPending}
                      title="Убрать из этого вида работ"
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 0, display: "flex" }}>
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
              <select value="" onChange={e => e.target.value && link.mutate({ wt: wt.id, master: e.target.value })}
                style={{ ...inputStyle, cursor: "pointer" }}>
                <option value="">+ добавить исполнителя…</option>
                {free.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          );
        })}
      </div>

      {/* ── Выученные цены (вне прайсов) ── */}
      {(priceBook as any[]).length > 0 && (
        <>
          <div style={{ ...label, margin: "26px 0 12px" }}>ВЫУЧЕННЫЕ ЦЕНЫ (ВНЕ ПРАЙСОВ)</div>
          <div style={{ border: "1px solid #EDEBE6" }}>
            {(priceBook as any[]).map((p: any) => (
              <div key={p.id} style={{ display: "grid", gridTemplateColumns: "1fr 90px 110px 90px 40px", padding: "8px 12px", borderBottom: "1px solid #F2EFE9", alignItems: "center" }}>
                <div style={{ fontSize: 12, color: "#1A1A1A" }}>{p.title || p.pattern}</div>
                <div style={{ fontSize: 11, color: "#A89070" }}>{p.unit || "—"}</div>
                <div style={{ fontSize: 12, textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(p.price)}</div>
                <div style={{ fontSize: 10, color: "#A89070" }}>{SOURCE_LABEL[p.source] || p.source}{p.times_used ? ` ·×${p.times_used}` : ""}</div>
                <button onClick={() => delPrice.mutate(p.id)}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", display: "flex", justifyContent: "flex-end", padding: 2 }}
                  onMouseEnter={e => (e.currentTarget.style.color = "#8B3A3A")}
                  onMouseLeave={e => (e.currentTarget.style.color = "#C8C0B0")}>
                  <Trash size={13} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
