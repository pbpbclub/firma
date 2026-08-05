// «Готовность» — один экран вместо обхода каждой сметы руками: дубли смет,
// расхождение сметы с выставленным счётом, себестоимость-заглушка
// (цена÷наценка вместо расчёта), дыры и мусор в ставках.
import { ESTIMATE_STATUS } from "../domain";
import { fmtMoneyDash as fmt } from "../ui/format";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { estimatesApi, ratesApi } from "../../api";
import { MONO } from "../ui/Num";
import { Loading } from "../ui/Loading";
import { Check, Warning } from "@phosphor-icons/react";


function Section({ label, count, hint, children }: {
  label: string; count?: number; hint?: string; children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 30 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>{label}</span>
        {count !== undefined && <span style={{ fontSize: 11, color: "#C8C0B0" }}>· {count}</span>}
      </div>
      {hint && <div style={{ fontSize: 11, color: "#A89070", marginBottom: 10 }}>{hint}</div>}
      {children}
    </div>
  );
}

// Ввод реальной себестоимости прямо в строке — без модалок, подряд по списку.
function StubRow({ it, onSaved }: { it: any; onSaved: () => void }) {
  const [val, setVal] = useState("");
  const save = useMutation({
    mutationFn: () => estimatesApi.updateItem(it.item_id, { cost_total: parseFloat(val) }),
    onSuccess: () => { setVal(""); onSaved(); },
  });
  const num = parseFloat(val);
  const ok = !isNaN(num) && num > 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1.6fr 110px 110px 200px",
                  gap: 10, alignItems: "center", padding: "9px 0", borderBottom: "1px solid #F2EFE9" }}>
      <span style={{ fontSize: 12, color: "#6B6355", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {it.brand || "—"} · {it.order_title}
      </span>
      <span style={{ fontSize: 13, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {it.title || "Без названия"}
      </span>
      <span style={{ fontSize: 12, color: "#6B6355", textAlign: "right", fontFamily: MONO }}>{fmt(it.sale_price)}</span>
      <span style={{ fontSize: 12, color: "#8B3A3A", textAlign: "right", fontFamily: MONO }} title="сейчас: ровно половина цены">
        {fmt(it.cost_total)}
      </span>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input value={val} onChange={e => setVal(e.target.value)} type="number" placeholder="сколько на самом деле"
          onKeyDown={e => { if (e.key === "Enter" && ok) save.mutate(); }}
          style={{ flex: 1, border: "1px solid #EDEBE6", padding: "4px 8px", fontSize: 12,
                   outline: "none", fontFamily: MONO, textAlign: "right", minWidth: 0 }} />
        <button disabled={!ok || save.isPending} onClick={() => save.mutate()}
          style={{ fontSize: 11, padding: "4px 10px", border: "none", fontFamily: "inherit", fontWeight: 600,
                   background: ok ? "#E8592A" : "#EDEBE6", color: ok ? "#fff" : "#A89070",
                   cursor: ok ? "pointer" : "default" }}>
          {save.isPending ? "..." : "OK"}
        </button>
      </div>
    </div>
  );
}

// Цены на работы: у Юры мастер называет сумму заново каждый раз, поэтому вместо
// «ставки» показываем историю — вилку и последние цифры.
function WorkPrices() {
  const { data } = useQuery({ queryKey: ["work-prices"], queryFn: ratesApi.prices });
  const items: any[] = data?.items ?? [];
  if (!items.length) return null;
  return (
    <Section label="ЦЕНЫ НА РАБОТЫ" count={items.length}
      hint="Ставки на работы не задаются: цена разовая. При заполнении сметы система спросит сумму и покажет эту подсказку.">
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 70px 150px 110px 1fr",
                    gap: 10, padding: "0 0 6px", fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>
        <span>РАБОТА</span><span style={{ textAlign: "right" }}>РАЗ</span>
        <span style={{ textAlign: "right" }}>ОБЫЧНО</span>
        <span style={{ textAlign: "right" }}>ПОСЛЕДНЯЯ</span><span>ВЕСЬ РАЗБРОС</span>
      </div>
      {items.map((it: any) => (
        <div key={it.title} style={{ display: "grid", gridTemplateColumns: "1.5fr 70px 150px 110px 1fr",
               gap: 10, alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
          <span style={{ fontSize: 13, color: "#1A1A1A" }}>{it.title}</span>
          <span style={{ fontSize: 12, color: "#A89070", textAlign: "right", fontFamily: MONO }}>{it.count}</span>
          <span style={{ fontSize: 12, color: "#1A1A1A", textAlign: "right", fontFamily: MONO }}>
            {it.typical_min === it.typical_max ? fmt(it.typical_min) : `${fmt(it.typical_min)} – ${fmt(it.typical_max)}`}
          </span>
          <span style={{ fontSize: 12, color: "#6B6355", textAlign: "right", fontFamily: MONO }}>{fmt(it.last)}</span>
          <span style={{ fontSize: 11, color: "#C8C0B0", fontFamily: MONO }}>{fmt(it.min)} … {fmt(it.max)}</span>
        </div>
      ))}
    </Section>
  );
}

export function ReadinessPanel() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["readiness"], queryFn: estimatesApi.readiness });
  const navigate = useNavigate();
  const refresh = () => qc.invalidateQueries({ queryKey: ["readiness"] });
  const delRate = useMutation({
    mutationFn: (id: string) => ratesApi.delete(id),
    onSuccess: refresh,
  });
  // Два разных действия с дублями: мягкое — просто показывать эту (варианты живы),
  // жёсткое — остальные в архив. Раньше было только жёсткое, и черновики,
  // которые заказчик ещё смотрит, хоронились одним кликом.
  const keep = useMutation({
    mutationFn: (setId: string) => estimatesApi.keepActual(setId),
    onSuccess: refresh,
  });
  const primary = useMutation({
    mutationFn: (setId: string) => estimatesApi.setPrimary(setId),
    onSuccess: refresh,
  });

  if (isLoading) return <Loading />;
  const s = data?.summary ?? {};
  const clean = !s.orders_with_duplicates && !s.invoice_drift && !s.stub_items
    && !s.rate_holes && !s.suspicious_rates && !s.tx_overspread;

  return (
    <div style={{ padding: "20px 28px 40px", overflow: "auto" }}>
      <div style={{ display: "flex", gap: 28, marginBottom: 26, flexWrap: "wrap" }}>
        {[["Дубли смет", s.orders_with_duplicates, "#8B3A3A"],
          ["Расходятся со счётом", s.invoice_drift, "#8B3A3A"],
          ["Разнесено сверх перевода", s.tx_overspread, "#8B3A3A"],
          ["Себестоимость-заглушка", s.stub_items, "#8B3A3A"],
          ["Подозрительные ставки", s.suspicious_rates, "#E8592A"],
          ["Суммы без состава", s.sum_only_items, "#A89070"]].map(([l, v, c]: any) => (
          <div key={l}>
            <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em", marginBottom: 3 }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO, color: v ? c : "#4A7C59" }}>{v ?? 0}</div>
          </div>
        ))}
      </div>

      {clean && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#4A7C59" }}>
          <Check size={14} /> Всё заполнено — можно заводить заказы.
        </div>
      )}

      {!!data?.duplicate_sets?.length && (
        <Section label="ДУБЛИ СМЕТ" count={data.duplicate_sets.length}
          hint="На заказе больше одной живой сметы — план-факт считается по одной из них. «Показывать эту» помечает основную, остальные варианты остаются черновиками. «Остальные в архив» помечает их «Заменена».">
          {data.duplicate_sets.map((o: any) => (
            <div key={o.order_id} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", marginBottom: 4 }}>
                {o.order_title} <span style={{ color: "#A89070", fontWeight: 400 }}>· {o.brand || "без бренда"}</span>
              </div>
              {o.sets.map((st: any) => (
                <div key={st.set_id} style={{ display: "grid", gridTemplateColumns: "90px 110px 1fr 120px 130px 130px",
                       gap: 10, alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F2EFE9",
                       background: st.is_primary ? "#FFF4EE" : undefined }}>
                  <span style={{ fontSize: 12, color: "#A89070", fontFamily: MONO }}>{(st.created_at || "").slice(0, 10)}</span>
                  <span style={{ fontSize: 11, color: st.status === "approved" ? "#4A7C59" : "#A89070" }}>
                    {ESTIMATE_STATUS[st.status]?.label ?? st.status}
                  </span>
                  <span style={{ fontSize: 12, color: "#6B6355" }}>позиций {st.items} · строк {st.lines}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, textAlign: "right", fontFamily: MONO }}>{fmt(st.sale_total)}</span>
                  {st.is_primary ? (
                    <span style={{ fontSize: 10, letterSpacing: "0.06em", color: "#E8592A", textAlign: "center",
                                   border: "1px solid #E8592A", padding: "4px 6px", fontWeight: 600 }}>ОСНОВНАЯ</span>
                  ) : (
                    <button onClick={() => primary.mutate(st.set_id)} disabled={primary.isPending}
                      style={{ fontSize: 11, padding: "4px 10px", border: "1px solid #E8592A", background: "#fff",
                               color: "#E8592A", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
                      показывать эту
                    </button>
                  )}
                  <button onClick={() => { if (confirm(`Пометить остальные сметы заказа «${o.order_title}» заменёнными? Варианты пропадут из работы.`)) keep.mutate(st.set_id); }}
                    disabled={keep.isPending}
                    style={{ fontSize: 11, padding: "4px 10px", border: "1px solid #EDEBE6", background: "#fff",
                             color: "#6B6355", cursor: "pointer", fontFamily: "inherit" }}>
                    остальные в архив
                  </button>
                </div>
              ))}
            </div>
          ))}
        </Section>
      )}

      {!!data?.invoice_drift?.length && (
        <Section label="СМЕТА РАСХОДИТСЯ СО СЧЁТОМ" count={data.invoice_drift.length}
          hint="Сумма счёта у заказа и живой итог активной сметы разошлись — клиент видел одну цифру, система считает по другой. Открой смету и сведи, либо поправь сумму заказа.">
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 120px 120px 120px 110px",
                        gap: 10, padding: "0 0 6px", borderBottom: "1px solid #EDEBE6" }}>
            {["", "", "СЧЁТ", "СМЕТА", "РАЗНИЦА"].map((h, i) => (
              <span key={i} style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em",
                                     textAlign: i >= 2 ? "right" : "left" }}>{h}</span>
            ))}
          </div>
          {data.invoice_drift.map((d: any) => (
            <div key={d.order_id}
              onClick={() => navigate(`/orders/${d.order_id}/estimate?set=${d.set_id}`)}
              style={{ display: "grid", gridTemplateColumns: "1.4fr 120px 120px 120px 110px",
                       gap: 10, alignItems: "center", padding: "9px 0", borderBottom: "1px solid #F2EFE9",
                       cursor: "pointer" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
              onMouseLeave={e => (e.currentTarget.style.background = "")}>
              <span style={{ fontSize: 13, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {d.order_title}
                <span style={{ color: "#A89070", fontSize: 11 }}> · {d.brand || "без бренда"}</span>
              </span>
              <span style={{ fontSize: 11, color: d.set_status === "approved" ? "#4A7C59" : "#A89070" }}>
                {ESTIMATE_STATUS[d.set_status]?.label ?? d.set_status}
                {d.payment_type === "bank" ? " · безнал" : ""}
              </span>
              <span style={{ fontSize: 13, textAlign: "right", fontFamily: MONO }} title="сумма счёта у заказа">
                {fmt(d.invoice)}
              </span>
              <span style={{ fontSize: 13, textAlign: "right", fontFamily: MONO }} title="живой итог сметы">
                {fmt(d.live)}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, textAlign: "right", fontFamily: MONO,
                             color: d.drift > 0 ? "#8B3A3A" : "#E8592A" }}>
                {d.drift > 0 ? "+" : "−"}{fmt(Math.abs(d.drift)).replace(" ₽", "")} ₽
              </span>
            </div>
          ))}
        </Section>
      )}

      {!!data?.tx_overspread?.length && (
        <Section label="РАЗНЕСЕНО БОЛЬШЕ, ЧЕМ БЫЛО В ПЕРЕВОДЕ" count={data.tx_overspread.length}
          hint="Один перевод может законно кормить несколько заказов — это нормально. Но здесь сумма частей больше самой транзакции: где-то расход задвоен или сумма набита руками. Открой заказ и поправь.">
          {data.tx_overspread.map((t: any) => (
            <div key={t.source + t.tx_id} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
                <Warning size={13} style={{ color: "#8B3A3A", flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>{t.tx_payee || "перевод"}</span>
                <span style={{ fontSize: 11, color: "#A89070", fontFamily: MONO }}>{(t.tx_date || "").slice(0, 10)}</span>
                <span style={{ fontSize: 12, color: "#6B6355", fontFamily: MONO, marginLeft: "auto" }}>
                  перевод {fmt(t.tx_amount)} · разнесено {fmt(t.spread)}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, fontFamily: MONO, color: "#8B3A3A" }}>
                  +{fmt(t.excess)}
                </span>
              </div>
              {t.parts.map((p: any, i: number) => (
                <div key={i} onClick={() => navigate(`/orders/${p.order_id}`)}
                  style={{ display: "grid", gridTemplateColumns: "1.3fr 1.4fr 120px", gap: 10,
                           alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F2EFE9",
                           cursor: "pointer" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#FAF8F5")}
                  onMouseLeave={e => (e.currentTarget.style.background = "")}>
                  <span style={{ fontSize: 13, color: "#1A1A1A", overflow: "hidden",
                                 textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.order_title}</span>
                  <span style={{ fontSize: 12, color: "#6B6355", overflow: "hidden",
                                 textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.title || "без названия"}{p.payee ? ` · ${p.payee}` : ""}
                  </span>
                  <span style={{ fontSize: 13, textAlign: "right", fontFamily: MONO }}>{fmt(p.amount)}</span>
                </div>
              ))}
            </div>
          ))}
        </Section>
      )}

      {!!data?.stub_items?.length && (
        <Section label="СЕБЕСТОИМОСТЬ — ЗАГЛУШКА" count={data.stub_items.length}
          hint="Здесь себестоимость не считалась: это цена, делённая на наценку 2. Впиши реальную сумму — Enter сохраняет.">
          {data.stub_items.map((it: any) => <StubRow key={it.item_id} it={it} onSaved={refresh} />)}
        </Section>
      )}

      {!!data?.suspicious_rates?.length && (
        <Section label="ПОДОЗРИТЕЛЬНЫЕ СТАВКИ" count={data.suspicious_rates.length}
          hint="Выучены из истории целых заказов — в новой смете подставятся как цена за штуку и раздуют себестоимость. Проверь в справочнике ставок.">
          {data.suspicious_rates.map((r: any) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
              <Warning size={13} style={{ color: "#E8592A", flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: "#1A1A1A" }}>{r.work_type_name}</span>
              <span style={{ fontSize: 12, color: "#A89070" }}>· {r.master_name || "любой"}</span>
              <span style={{ fontSize: 13, fontWeight: 600, fontFamily: MONO, color: "#8B3A3A", marginLeft: "auto" }}>
                {fmt(r.rate)} / {r.unit || "ед"}
              </span>
              <span style={{ fontSize: 10, color: "#C8C0B0" }}>источник: {r.source}</span>
              <button onClick={() => delRate.mutate(r.id)} disabled={delRate.isPending}
                title="Удалить ставку — она разовая, а не постоянная"
                style={{ fontSize: 10, padding: "3px 8px", border: "1px solid #EDEBE6", background: "#fff",
                         color: "#8B3A3A", cursor: "pointer", fontFamily: "inherit" }}>
                удалить
              </button>
            </div>
          ))}
        </Section>
      )}

      <WorkPrices />

      {!!data?.sum_only_items?.length && (
        <Section label="СУММЫ БЕЗ СОСТАВА" count={data.sum_only_items.length}
          hint="Себестоимость введена одной суммой осознанно (транзит, доставка) — это нормально, состав не нужен.">
          {data.sum_only_items.map((it: any) => (
            <div key={it.item_id} style={{ display: "grid", gridTemplateColumns: "1.1fr 1.6fr 110px 110px 90px",
                   gap: 10, alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
              <span style={{ fontSize: 12, color: "#6B6355", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {it.brand || "—"} · {it.order_title}
              </span>
              <span style={{ fontSize: 13, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</span>
              <span style={{ fontSize: 12, color: "#6B6355", textAlign: "right", fontFamily: MONO }}>{fmt(it.sale_price)}</span>
              <span style={{ fontSize: 12, color: "#6B6355", textAlign: "right", fontFamily: MONO }}>{fmt(it.cost_total)}</span>
              <span style={{ fontSize: 11, color: "#A89070", textAlign: "right" }}>
                {it.sale_price ? Math.round((1 - it.cost_total / it.sale_price) * 100) : 0}%
              </span>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
