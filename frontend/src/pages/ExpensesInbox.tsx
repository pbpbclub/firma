import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { MONO } from "../components/ui/Num";
import { Loading } from "../components/ui/Loading";
import { EmptyState } from "../components/ui/EmptyState";
import { PeriodFilter, AmountFilter } from "../components/TableFilters";
import { inboxApi, ordersApi, mastersApi, payeeRulesApi } from "../api";
import { EXPENSE_CATEGORIES } from "../components/ExpenseModal";
import { MagnifyingGlass, X, Check } from "@phosphor-icons/react";

function fmt(n: number | null | undefined) {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}
function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

const SOURCES = [
  { id: "bank", label: "ДДС (банк)" },
  { id: "zen",  label: "Личные" },
] as const;

// ── Строка разноски: раскрывается в форму ────────────────────────────────────
type Alloc = { order_id: string; amount: string; category: string; master_id: string; creditor_id: string | null };

// Пикер плановой строки сметы: платёж привязывается к конкретному обязательству
// (напр. «Порошковая покраска · осталось 40 000»), а не «вообще к подрядчику».
// Обязательства появляются только после утверждения сметы.
function ObligationPicker({ orderId, categoryLabel, value, onPick }: {
  orderId: string; categoryLabel: string; value: string | null;
  onPick: (creditorId: string | null, remaining: number) => void;
}) {
  const { data: obls = [], isLoading } = useQuery({
    queryKey: ["obligations", orderId],
    queryFn: () => ordersApi.obligations(orderId).then((d: any) => d.items ?? []),
  });
  if (isLoading) return null;
  const all = obls as any[];
  // Строки сметы той же категории, что и разноска (Работы/Материалы/…), ещё не закрытые.
  const list = all.filter((o: any) => o.category === categoryLabel && o.status !== "closed");
  if (all.length === 0) {
    return (
      <div style={{ marginTop: 8, fontSize: 10, color: "#A89070" }}>
        Утвердите смету, чтобы привязать оплату к плановым строкам.
      </div>
    );
  }
  if (list.length === 0) {
    return (
      <div style={{ marginTop: 8, fontSize: 10, color: "#A89070" }}>
        Нет плановых строк категории «{categoryLabel}» — платёж пойдёт расходом без привязки.
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ПЛАНОВАЯ СТРОКА СМЕТЫ</div>
      <select value={value ?? ""}
        onChange={e => {
          const o = list.find((x: any) => x.creditor_id === e.target.value);
          onPick(o ? o.creditor_id : null, o ? o.remaining : 0);
        }}
        style={{ width: "100%", boxSizing: "border-box", border: "1px solid " + (value ? "#E8592A" : "#EDEBE6"), padding: "5px 8px", fontSize: 11, outline: "none", background: "#fff", cursor: "pointer" }}>
        <option value="">— не привязывать —</option>
        {list.map((o: any) => (
          <option key={o.creditor_id} value={o.creditor_id}>
            {o.title} · осталось {fmt(o.remaining)}{o.planned_executor ? ` · план: ${o.planned_executor}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

function AllocRow({ tx, onDone }: { tx: any; onDone: () => void }) {
  const [title, setTitle] = useState(tx.counterparty || tx.purpose || "");
  // Каждая строка — свой заказ, сумма, категория, подрядчик и (опц.) обязательство.
  const [allocs, setAllocs] = useState<Alloc[]>([]);
  const [error, setError] = useState("");
  // Получатель платежа (уровень транзакции). Из правила — уверенно; из похожести —
  // предложение. По умолчанию запоминаем, когда угадано похожестью (не правилом).
  const [payeeMaster, setPayeeMaster] = useState<string>(tx.master_id || tx.master_suggested?.id || "");
  const [remember, setRemember] = useState<boolean>(!!(tx.master_suggested && !tx.master_id));
  const payeeStr = (tx.counterparty || "").trim();

  const { data: suggestions = [] } = useQuery({
    // amount=0 намеренно: suggest скорит сумму против price_plan (выручки заказа),
    // для расхода это шум — ранжируем только по совпадению контрагента.
    queryKey: ["order-suggest", tx.counterparty],
    queryFn: () => ordersApi.suggest(tx.counterparty || "", 0),
  });
  const { data: masters = [] } = useQuery({ queryKey: ["masters"], queryFn: mastersApi.list });

  const masterName = (mid: string) => (masters as any[]).find((m: any) => m.id === mid)?.name;

  const save = useMutation({
    mutationFn: async () => {
      await inboxApi.fromTx({
        source: tx.source, tx_id: tx.id, title: title.trim() || null, category: "other",
        expense_date: (tx.date || "").slice(0, 10) || null,
        allocations: allocs.map(a => ({
          order_id: a.order_id, amount: parseFloat(a.amount) || 0,
          category: a.category, master_id: a.master_id || null,
          supplier: masterName(a.master_id) ?? tx.counterparty,
          creditor_id: a.creditor_id,
        })),
      });
      // Запомнить плательщика: строка банка → подрядчик (правило на будущее).
      if (remember && payeeMaster && payeeStr) {
        try {
          await payeeRulesApi.create({
            pattern: payeeStr, match_type: "exact",
            entity_type: "master", entity_id: payeeMaster, entity_name: masterName(payeeMaster),
          });
        } catch { /* правило не критично для разноски */ }
      }
    },
    onSuccess: onDone,
    onError: (e: any) => setError(e?.response?.data?.detail || "Не удалось разнести"),
  });

  const addOrder = (orderId: string) => {
    if (allocs.some(a => a.order_id === orderId)) return;
    setAllocs([...allocs, { order_id: orderId, amount: "", category: tx.category_hint || "material", master_id: payeeMaster || "", creditor_id: null }]);
  };
  const patch = (i: number, p: Partial<Alloc>) => setAllocs(allocs.map((x, j) => j === i ? { ...x, ...p } : x));
  const splitEvenly = () => {
    if (!allocs.length) return;
    const each = Math.floor((tx.amount / allocs.length) * 100) / 100;
    const rest = Math.round((tx.amount - each * allocs.length) * 100) / 100;
    // Остаток от деления кладём в первый заказ, иначе сумма не сойдётся с транзакцией.
    setAllocs(allocs.map((a, i) => ({ ...a, amount: String(i === 0 ? each + rest : each) })));
  };

  const sum = allocs.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
  const diff = Math.round((tx.amount - sum) * 100) / 100;
  const ready = allocs.length > 0 && Math.abs(diff) < 0.01;

  const ordersById = new Map((suggestions as any[]).map((o: any) => [o.id, o]));

  return (
    <div style={{ padding: "14px 28px 18px", background: "#FAF8F5", borderBottom: "1px solid #EDEBE6" }}>

      {/* Плательщик: кто получил перевод. Правило — уверенно, похожесть — предложение. */}
      <div style={{ marginBottom: 14, padding: "10px 12px", background: "#fff", border: "1px solid #EDEBE6" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em" }}>ПЛАТЕЛЬЩИК</div>
          <div style={{ fontSize: 12, color: "#1A1A1A", flex: "0 0 auto" }}>{payeeStr || "—"}</div>
          <span style={{ color: "#C8C0B0" }}>→</span>
          <select value={payeeMaster} onChange={e => { setPayeeMaster(e.target.value); setRemember(!!e.target.value); }}
            style={{ flex: 1, minWidth: 150, border: "1px solid " + (tx.match_source === "suggest" && payeeMaster ? "#E8592A" : "#EDEBE6"), padding: "5px 8px", fontSize: 12, outline: "none", background: "#fff", cursor: "pointer" }}>
            <option value="">— подрядчик —</option>
            {(masters as any[]).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        {tx.match_source === "suggest" && tx.master_suggested && (
          <div style={{ fontSize: 10, color: "#E8592A", marginTop: 6 }}>
            Похоже: {tx.master_suggested.name}? Проверь и подтверди.
          </div>
        )}
        {payeeMaster && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 11, color: "#6B6355", cursor: "pointer" }}>
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            Запомнить: платежи «{payeeStr}» → {masterName(payeeMaster)}
          </label>
        )}
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>НАЗВАНИЕ РАСХОДА</div>
        <input value={title} onChange={e => setTitle(e.target.value)}
          style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "6px 10px", fontSize: 12, outline: "none", background: "#fff" }} />
      </div>

      {/* Выбранные заказы — у каждого своя категория, подрядчик, обязательство */}
      <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>
        РАЗНЕСТИ НА ЗАКАЗЫ
        {allocs.length > 1 && (
          <button onClick={splitEvenly}
            style={{ marginLeft: 10, fontSize: 10, color: "#E8592A", background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
            Поровну
          </button>
        )}
      </div>

      {allocs.map((a, i) => {
        const o = ordersById.get(a.order_id);
        const catLabel = EXPENSE_CATEGORIES.find(c => c.v === a.category)?.l ?? "Прочее";
        return (
          <div key={a.order_id} style={{ background: "#fff", border: "1px solid #EDEBE6", padding: "8px 10px", marginBottom: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 24px", gap: 8, alignItems: "center" }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {o?.title ?? a.order_id}
              </div>
              <input value={a.amount} onChange={e => patch(i, { amount: e.target.value })}
                placeholder="сумма" type="number"
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none", textAlign: "right", fontFamily: MONO }} />
              <button onClick={() => setAllocs(allocs.filter((_, j) => j !== i))}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 0, display: "flex", justifyContent: "center" }}>
                <X size={12} />
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
              {/* Категория — компактные чипы */}
              <div style={{ display: "flex" }}>
                {EXPENSE_CATEGORIES.map(c => (
                  <button key={c.v} onClick={() => patch(i, { category: c.v, creditor_id: null })}
                    style={{
                      padding: "3px 9px", fontSize: 10, cursor: "pointer", border: "1px solid",
                      borderColor: a.category === c.v ? "#1A1A1A" : "#EDEBE6",
                      background: a.category === c.v ? "#1A1A1A" : "#fff",
                      color: a.category === c.v ? "#FFFFFF" : "#A89070", marginRight: -1, fontFamily: "inherit",
                    }}>{c.l}</button>
                ))}
              </div>
              {/* Подрядчик */}
              <select value={a.master_id} onChange={e => patch(i, { master_id: e.target.value })}
                style={{ flex: 1, minWidth: 130, border: "1px solid #EDEBE6", padding: "4px 8px", fontSize: 11, outline: "none", background: "#fff", cursor: "pointer" }}>
                <option value="">— подрядчик —</option>
                {(masters as any[]).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            {/* Плановая строка сметы — привязка платежа к конкретному обязательству */}
            <ObligationPicker
              orderId={a.order_id}
              categoryLabel={catLabel}
              value={a.creditor_id}
              onPick={(cid, remaining) => patch(i, {
                creditor_id: cid,
                // Пустую сумму подставляем из остатка по строке; заполненную не трогаем.
                amount: cid && !a.amount ? String(remaining) : a.amount,
              })}
            />
          </div>
        );
      })}

      {/* Подсказки заказов */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, marginBottom: 12 }}>
        {(suggestions as any[]).filter((o: any) => !allocs.some(a => a.order_id === o.id)).slice(0, 6).map((o: any) => (
          <button key={o.id} onClick={() => addOrder(o.id)}
            style={{ fontSize: 11, padding: "3px 9px", border: "1px solid #EDEBE6", background: "#fff", cursor: "pointer", color: "#6B6355", fontFamily: "inherit" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#E8592A"; e.currentTarget.style.color = "#E8592A"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#EDEBE6"; e.currentTarget.style.color = "#6B6355"; }}>
            + {o.title}
          </button>
        ))}
      </div>

      {/* Итог и кнопка */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #EDEBE6", paddingTop: 10 }}>
        <div style={{ fontSize: 11, color: Math.abs(diff) < 0.01 ? "#4A7C59" : "#8B3A3A", fontFamily: MONO }}>
          {allocs.length === 0 ? <span style={{ color: "#A89070" }}>выберите заказ</span> :
            Math.abs(diff) < 0.01 ? `✓ сходится: ${fmt(sum)}` : `разница ${fmt(Math.abs(diff))} ${diff > 0 ? "не разнесено" : "перебор"}`}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {error && <span style={{ fontSize: 11, color: "#8B3A3A" }}>{error}</span>}
          <button disabled={!ready || save.isPending} onClick={() => { setError(""); save.mutate(); }}
            style={{
              padding: "6px 16px", border: "none", fontSize: 12, fontWeight: 600,
              background: ready ? "#E8592A" : "#EDEBE6", color: ready ? "#fff" : "#A89070",
              cursor: ready && !save.isPending ? "pointer" : "default", fontFamily: "inherit",
              display: "flex", alignItems: "center", gap: 5,
            }}>
            <Check size={12} /> {save.isPending ? "Разносим..." : "Разнести"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Страница ─────────────────────────────────────────────────────────────────
export default function ExpensesInbox() {
  const qc = useQueryClient();
  const [source, setSource] = useState<"bank" | "zen">("bank");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amtMin, setAmtMin] = useState("");
  const [amtMax, setAmtMax] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const params: Record<string, string | number> = { source, limit: 100 };
  if (search) params.search = search;
  if (from) params.date_from = from;
  if (to) params.date_to = to;
  if (amtMin) params.amount_min = amtMin;
  if (amtMax) params.amount_max = amtMax;

  const { data, isLoading } = useQuery({
    queryKey: ["expenses-inbox", source, search, from, to, amtMin, amtMax],
    queryFn: () => inboxApi.list(params),
  });

  const items: any[] = data?.items ?? [];

  const onDone = () => {
    setOpenId(null);
    qc.invalidateQueries({ queryKey: ["expenses-inbox"] });
    qc.invalidateQueries({ queryKey: ["orders-v2"] });
    qc.invalidateQueries({ queryKey: ["orders-plan-fact-summary"] });
  };

  const clearFilters = () => { setSearch(""); setFrom(""); setTo(""); setAmtMin(""); setAmtMax(""); };
  const hasFilters = !!(search || from || to || amtMin || amtMax);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>

      {/* Шапка */}
      <div style={{ padding: "24px 28px 0" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Разноска</div>
          <div style={{ position: "relative" }}>
            <MagnifyingGlass size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#A89070" }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Контрагент..."
              style={{ paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6, border: "1px solid #EDEBE6", background: "transparent", fontSize: 12, color: "#1A1A1A", outline: "none", width: 200, borderRadius: 0 }} />
          </div>
        </div>

        <div style={{ display: "flex", gap: 24, borderBottom: "1px solid #EDEBE6" }}>
          {SOURCES.map(s => (
            <button key={s.id} onClick={() => { setSource(s.id); setOpenId(null); }}
              style={{
                fontSize: 13, padding: "0 0 12px", border: "none", background: "none", cursor: "pointer",
                color: source === s.id ? "#1A1A1A" : "#A89070",
                fontWeight: source === s.id ? 600 : 400,
                borderBottom: source === s.id ? "2px solid #E8592A" : "2px solid transparent",
                marginBottom: -1, transition: "all 0.15s",
              }}>{s.label}</button>
          ))}
        </div>
      </div>

      {/* Панель фильтров */}
      <div style={{ padding: "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 16, alignItems: "center", fontSize: 11, color: "#6B6355" }}>
          <span>{items.length} неразнесённых</span>
          <PeriodFilter label="ПЕРИОД" from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
          <AmountFilter label="СУММА" min={amtMin} max={amtMax} onChange={(mn, mx) => { setAmtMin(mn); setAmtMax(mx); }} />
          {source === "zen" && !from && (
            <span style={{ fontSize: 10, color: "#C8C0B0" }}>показаны последние 90 дней — расширь период</span>
          )}
        </div>
        <button onClick={hasFilters ? clearFilters : undefined}
          style={{ fontSize: 10, color: hasFilters ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: hasFilters ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
          <X size={10} /> Сбросить
        </button>
      </div>

      {/* Заголовки */}
      <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 130px", gap: 12, padding: "8px 28px", borderBottom: "1px solid #F7F5F1" }}>
        {["ДАТА", "КОНТРАГЕНТ / НАЗНАЧЕНИЕ", "СУММА"].map((h, i) => (
          <div key={h} style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em", textAlign: i === 2 ? "right" : "left" }}>{h}</div>
        ))}
      </div>

      {/* Список */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {isLoading ? <Loading compact /> :
         items.length === 0 ? <EmptyState compact title="Всё разнесено" hint="Списаний без привязки к заказам не осталось" /> :
         items.map((t: any) => (
          <div key={t.id}>
            <div onClick={() => setOpenId(openId === t.id ? null : t.id)}
              style={{
                display: "grid", gridTemplateColumns: "80px 1fr 130px", gap: 12, padding: "11px 28px",
                borderBottom: "1px solid #F7F5F1", cursor: "pointer", alignItems: "center",
                background: openId === t.id ? "#FFF8F5" : "transparent",
              }}
              onMouseEnter={e => { if (openId !== t.id) e.currentTarget.style.background = "#FAF8F5"; }}
              onMouseLeave={e => { if (openId !== t.id) e.currentTarget.style.background = "transparent"; }}>
              <div style={{ fontSize: 11, color: "#A89070", fontFamily: MONO }}>{fmtDate(t.date)}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.counterparty || "—"}
                  {t.payee_hint && t.payee_hint !== t.counterparty && (
                    <span style={{ color: "#4A7C59", fontSize: 10, marginLeft: 6 }}>→ {t.payee_hint}</span>
                  )}
                </div>
                {(t.purpose || t.zen_tag) && (
                  <div style={{ fontSize: 10, color: "#A89070", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.purpose}{t.zen_tag ? ` · ${t.zen_tag}` : ""}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#8B3A3A", textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                −{fmt(t.amount)}
              </div>
            </div>
            {openId === t.id && <AllocRow tx={t} onDone={onDone} />}
          </div>
        ))}
      </div>
    </div>
  );
}
