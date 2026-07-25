// «Готовность» — один экран вместо обхода каждой сметы руками: дубли смет,
// себестоимость-заглушка (цена÷наценка вместо расчёта), дыры и мусор в ставках.
import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { estimatesApi, ratesApi } from "../../api";
import { MONO } from "../ui/Num";
import { Loading } from "../ui/Loading";
import { Check, Warning } from "@phosphor-icons/react";

const fmt = (n: number | null | undefined) =>
  !n ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";

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
  const refresh = () => qc.invalidateQueries({ queryKey: ["readiness"] });
  const delRate = useMutation({
    mutationFn: (id: string) => ratesApi.delete(id),
    onSuccess: refresh,
  });
  const keep = useMutation({
    mutationFn: (setId: string) => estimatesApi.keepActual(setId),
    onSuccess: refresh,
  });

  if (isLoading) return <Loading />;
  const s = data?.summary ?? {};
  const clean = !s.orders_with_duplicates && !s.stub_items && !s.rate_holes && !s.suspicious_rates;

  return (
    <div style={{ padding: "20px 28px 40px", overflow: "auto" }}>
      <div style={{ display: "flex", gap: 28, marginBottom: 26, flexWrap: "wrap" }}>
        {[["Дубли смет", s.orders_with_duplicates, "#8B3A3A"],
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
          hint="На заказе больше одной живой сметы — план-факт считается по одной из них. Оставь актуальную, остальные уйдут в «Заменена».">
          {data.duplicate_sets.map((o: any) => (
            <div key={o.order_id} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A", marginBottom: 4 }}>
                {o.order_title} <span style={{ color: "#A89070", fontWeight: 400 }}>· {o.brand || "без бренда"}</span>
              </div>
              {o.sets.map((st: any) => (
                <div key={st.set_id} style={{ display: "grid", gridTemplateColumns: "90px 110px 1fr 120px 110px",
                       gap: 10, alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
                  <span style={{ fontSize: 12, color: "#A89070", fontFamily: MONO }}>{(st.created_at || "").slice(0, 10)}</span>
                  <span style={{ fontSize: 11, color: st.status === "approved" ? "#4A7C59" : "#A89070" }}>
                    {st.status === "approved" ? "Согласована" : "Черновик"}
                  </span>
                  <span style={{ fontSize: 12, color: "#6B6355" }}>позиций {st.items} · строк {st.lines}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, textAlign: "right", fontFamily: MONO }}>{fmt(st.sale_total)}</span>
                  <button onClick={() => keep.mutate(st.set_id)} disabled={keep.isPending}
                    style={{ fontSize: 11, padding: "4px 10px", border: "1px solid #E8592A", background: "#fff",
                             color: "#E8592A", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
                    оставить эту
                  </button>
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
