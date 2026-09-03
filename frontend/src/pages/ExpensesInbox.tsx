import { fmtMoneyDash as fmt } from "../components/ui/format";
import { useIsMobile, M } from "../components/ui/responsive";
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { MONO } from "../components/ui/Num";
import { Loading } from "../components/ui/Loading";
import { EmptyState } from "../components/ui/EmptyState";
import { PeriodFilter, AmountFilter, ColumnFilter } from "../components/TableFilters";
import { inboxApi, ordersApi, mastersApi, payeeRulesApi, estimatesApi, paymentsApi, accountableApi, customersApi } from "../api";
import { PaymentAllocator, allocReady, allocPayload, type Alloc as PayAlloc } from "../components/money/PaymentAllocator";
import { MoneyInput, parseMoney } from "../components/ui/MoneyInput";
import { EXPENSE_CATEGORIES } from "../components/ExpenseModal";
import { Modal } from "../components/ui/Modal";
import { PayeePicker, CustomerPicker } from "../components/ui/PayeePicker";
import { Pager, usePager } from "../components/ui/Pager";
import { MagnifyingGlass, X, Check, ArrowCounterClockwise, EyeSlash, HandCoins, User, FloppyDisk } from "@phosphor-icons/react";

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

const SOURCES = [
  { id: "bank", label: "ДДС (банк)" },
  { id: "zen",  label: "Личные" },
  { id: "in",   label: "Поступления" },
] as const;

// ── Строка разноски: раскрывается в форму ────────────────────────────────────
// order_id пуст + purpose заполнен → часть перевода уходит «мимо заказов»:
// запас / собственный образец / общехозяйственное (ТЗ stock_and_samples 01.08.2026).
type Alloc = { order_id: string; amount: string; category: string; master_id: string; creditor_id: string | null; purpose?: string };

const GENERAL_TARGETS = [
  { v: "stock", l: "Запас" },
  { v: "sample", l: "Образец" },
  { v: "overhead", l: "Общехоз" },
  // Вывод владельцу: tx-ссылка сохраняется (дедуп разноски), в себестоимость
  // и накладные не идёт (ТЗ 03.09.2026).
  { v: "owner_draw", l: "Себе" },
];

// Пикер плановой строки сметы: платёж привязывается к конкретному обязательству
// (напр. «Порошковая покраска · осталось 40 000»), а не «вообще к подрядчику».
// Обязательства появляются только после утверждения сметы.
function ObligationPicker({ orderId, categoryLabel, value, amount, onPick }: {
  orderId: string; categoryLabel: string; value: string | null; amount: string;
  onPick: (creditorId: string | null, remaining: number) => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["obligations", orderId],
    queryFn: () => ordersApi.obligations(orderId),
  });
  const all: any[] = data?.items ?? [];
  const activeSet = data?.active_set ?? null;
  // Утвердить смету прямо из разноски — обязательства по строкам генерятся на approve.
  // Через approveSet, а не PUT {status}: у второй двери нет force-диалога, и смета
  // без продажных цен обнуляла бы цену заказа молча (24.08.2026).
  const approve = useMutation({
    mutationFn: () => estimatesApi.approveSet(activeSet.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["obligations", orderId] }),
  });
  if (isLoading) return null;
  // Строки сметы той же категории, что и разноска (Работы/Материалы/…), ещё не закрытые.
  const list = all.filter((o: any) => o.category === categoryLabel && o.status !== "closed");
  if (all.length === 0) {
    // Смета есть, но не утверждена → предложить утвердить (тогда появятся плановые строки).
    if (activeSet && activeSet.status !== "approved") {
      return (
        <div style={{ marginTop: 8, fontSize: 10, color: "#A89070" }}>
          Смета не утверждена — плановых строк ещё нет.
          <button type="button" disabled={approve.isPending} onClick={() => approve.mutate()}
            style={{ marginLeft: 8, fontSize: 10, color: "#E8592A", background: "none",
                     border: "1px solid #E8592A", padding: "2px 8px",
                     cursor: approve.isPending ? "default" : "pointer", fontFamily: "inherit" }}>
            {approve.isPending ? "Утверждаю…" : "Утвердить смету"}
          </button>
        </div>
      );
    }
    return (
      <div style={{ marginTop: 8, fontSize: 10, color: "#A89070" }}>
        Сметы нет — платёж пойдёт расходом без привязки.
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
      {(() => {
        const picked = value ? list.find((x: any) => x.creditor_id === value) : null;
        if (!picked) return null;
        const after = Math.round((picked.remaining - (parseFloat(amount) || 0)) * 100) / 100;
        return (
          <div style={{ fontSize: 10, color: "#A89070", marginTop: 5 }}>
            по плану осталось <span style={{ fontFamily: MONO, color: "#6B6355" }}>{fmt(picked.remaining)}</span>
            {" → после этой оплаты "}
            {after > 0
              ? <span style={{ fontFamily: MONO, color: "#6B6355" }}>осталось оплатить {fmt(after)}</span>
              : after < 0
                ? <span style={{ fontFamily: MONO, color: "#8B3A3A" }}>переплата {fmt(-after)}</span>
                : <span style={{ fontFamily: MONO, color: "#4A7C59" }}>план закрыт</span>}
          </div>
        );
      })()}
    </div>
  );
}

function AllocRow({ tx, onDone }: { tx: any; onDone: () => void }) {
  const isMobile = useIsMobile();
  const [title, setTitle] = useState(tx.counterparty || tx.purpose || "");
  // Режим строки — ОДНО значение, а не три булевых. Сейчас два режима сразу не
  // включить только потому, что кнопки входа отрисованы в else-ветке: добавь
  // кто-нибудь четвёртую кнопку в тулбар — и получится залипание, как было у
  // «Готовности» в заказах (24.08.2026).
  const [rowMode, setRowMode] = useState<"none" | "hide" | "personal" | "accountable">("none");
  // Каждая строка — свой заказ, сумма, категория, подрядчик и (опц.) обязательство.
  const [allocs, setAllocs] = useState<Alloc[]>([]);
  const [error, setError] = useState("");
  // Получатель платежа (уровень транзакции). Из правила — уверенно; из похожести —
  // предложение. По умолчанию запоминаем, когда угадано похожестью (не правилом).
  const [payeeMaster, setPayeeMaster] = useState<string>(tx.master_id || tx.master_suggested?.id || "");
  const payeeStr = (tx.counterparty || "").trim();
  const qcRow = useQueryClient();
  // Привязка сохранена, когда она пришла правилом и с тех пор не менялась вручную.
  const ruleSaved = tx.match_source === "rule" && payeeMaster === tx.master_id;

  const { data: suggestions = [] } = useQuery({
    // amount=0 намеренно: suggest скорит сумму против price_plan (выручки заказа),
    // для расхода это шум — ранжируем только по совпадению контрагента.
    queryKey: ["order-suggest", tx.counterparty],
    queryFn: () => ordersApi.suggest(tx.counterparty || "", 0),
  });
  const { data: masters = [] } = useQuery({ queryKey: ["masters"], queryFn: mastersApi.list });

  const masterName = (mid: string) => (masters as any[]).find((m: any) => m.id === mid)?.name;

  // Запомнить получателя отдельно от разноски: одно правило закрывает все платежи
  // этого контрагента сразу. Список обновляем БЕЗ onDone — строка не должна схлопнуться.
  const saveRule = useMutation({
    mutationFn: () => payeeRulesApi.create({
      pattern: payeeStr, match_type: "exact",
      entity_type: "master", entity_id: payeeMaster, entity_name: masterName(payeeMaster),
    }),
    onSuccess: () => qcRow.invalidateQueries({ queryKey: ["expenses-inbox"] }),
  });

  const save = useMutation({
    mutationFn: async () => {
      await inboxApi.fromTx({
        source: tx.source, tx_id: tx.id, title: title.trim() || null, category: "other",
        expense_date: (tx.date || "").slice(0, 10) || null,
        allocations: allocs.map(a => ({
          order_id: a.order_id || null, purpose: a.purpose || null,
          amount: parseMoney(a.amount) || 0,
          category: a.category, master_id: a.master_id || null,
          supplier: masterName(a.master_id) ?? tx.counterparty,
          creditor_id: a.creditor_id,
        })),
      });
      // Запомнить плательщика: строка банка → контрагент (правило на будущее).
      // Если уже сохранено кнопкой — повторно не пишем.
      if (!ruleSaved && payeeMaster && payeeStr) {
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

  // Скрыть списание: внутренний перевод между своими счетами, возврат… — это не
  // расход бизнеса, разносить на заказ нечего.
  const dismiss = useMutation({
    mutationFn: (reason: string) => inboxApi.dismiss(tx.id, tx.source, reason),
    onSuccess: onDone,
  });

  // Личное: не бизнес-расход (друг, разовая покупка). В личном ZM-леджере трата
  // остаётся, из Разноски убираем. «Запомнить» → правило entity_type='personal':
  // будущие платежи этому контрагенту авто-скрываются (инбокс их отсеивает).
  const [rememberPersonal, setRememberPersonal] = useState(false);
  const [personalSubcat, setPersonalSubcat] = useState("Прочее");
  const markPersonal = useMutation({
    mutationFn: async () => {
      if (rememberPersonal && payeeStr) {
        await payeeRulesApi.create({ pattern: payeeStr, match_type: "exact", entity_type: "personal", entity_name: "Личное", category: personalSubcat });
      } else {
        await inboxApi.dismiss(tx.id, tx.source, "Личное: " + personalSubcat);
      }
    },
    onSuccess: onDone,
  });

  // Выдача под отчёт: перевод доверенному лицу — НЕ расход по заказу (расход
  // возникнет при его оплате поставщику). Баланс лица «на руках» вырастет.
  const [accountablePick, setAccountablePick] = useState<string>(tx.master_id || tx.master_suggested?.id || "");
  const issueAccountable = useMutation({
    mutationFn: () => accountableApi.issueFromTx({
      tx_id: tx.id, source: tx.source, master_id: accountablePick,
      amount: tx.amount, date: (tx.date || "").slice(0, 10) || undefined,
    }),
    onSuccess: onDone,
  });

  const addOrder = (orderId: string) => {
    if (allocs.some(a => a.order_id === orderId)) return;
    // По умолчанию — остаток неразнесённого (первый заказ = полная сумма платежа).
    const other = allocs.reduce((s, a) => s + (parseMoney(a.amount) || 0), 0);
    const left = Math.round((tx.amount - other) * 100) / 100;
    setAllocs([...allocs, { order_id: orderId, amount: left > 0 ? String(left) : "", category: tx.category_hint || "material", master_id: payeeMaster || "", creditor_id: null }]);
  };
  // Часть, которая ни к какому заказу не относится (закупка впрок, свой образец).
  const addGeneral = (purpose: string) => {
    if (allocs.some(a => a.purpose === purpose)) return;
    const other = allocs.reduce((s, a) => s + (parseMoney(a.amount) || 0), 0);
    const left = Math.round((tx.amount - other) * 100) / 100;
    setAllocs([...allocs, { order_id: "", purpose, amount: left > 0 ? String(left) : "",
                            category: tx.category_hint || "material", master_id: payeeMaster || "", creditor_id: null }]);
  };
  const patch = (i: number, p: Partial<Alloc>) => setAllocs(allocs.map((x, j) => j === i ? { ...x, ...p } : x));
  const splitEvenly = () => {
    if (!allocs.length) return;
    const each = Math.floor((tx.amount / allocs.length) * 100) / 100;
    const rest = Math.round((tx.amount - each * allocs.length) * 100) / 100;
    // Остаток от деления кладём в первый заказ, иначе сумма не сойдётся с транзакцией.
    setAllocs(allocs.map((a, i) => ({ ...a, amount: String(i === 0 ? each + rest : each) })));
  };

  const sum = allocs.reduce((s, a) => s + (parseMoney(a.amount) || 0), 0);
  const diff = Math.round((tx.amount - sum) * 100) / 100;
  const ready = allocs.length > 0 && Math.abs(diff) < 0.01;

  const ordersById = new Map((suggestions as any[]).map((o: any) => [o.id, o]));

  return (
    <div style={{ padding: isMobile ? "12px 16px 16px" : "14px 28px 18px", background: "#FAF8F5", borderBottom: "1px solid #EDEBE6" }}>

      {/* Получатель: кому ушли деньги. Правило — уверенно, похожесть — предложение. */}
      <div style={{ marginBottom: 14, padding: "10px 12px", background: "#fff", border: "1px solid #EDEBE6" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em" }}>ПОЛУЧАТЕЛЬ</div>
          <div style={{ fontSize: 12, color: "#1A1A1A", flex: "0 0 auto" }}>{payeeStr || "—"}</div>
          <span style={{ color: "#C8C0B0" }}>→</span>
          {/* Контрагент любой роли (подрядчик/мастер/поставщик) + завести нового на месте */}
          <PayeePicker
            value={payeeMaster}
            onChange={setPayeeMaster}
            suggestName={payeeStr}
            highlight={tx.match_source === "suggest"}
            style={{ flex: 1, minWidth: isMobile ? "100%" : 260 }}
          />
          {/* Запомнить привязку сразу — не дожидаясь разноски платежа */}
          {payeeMaster && payeeStr && !ruleSaved && (
            <button type="button" onClick={() => saveRule.mutate()} disabled={saveRule.isPending}
              title={`Запомнить: все платежи «${payeeStr}» → ${masterName(payeeMaster)}`}
              style={{ display: "flex", alignItems: "center", gap: 5, fontSize: isMobile ? 13 : 10.5, padding: isMobile ? "9px 12px" : "5px 10px",
                       border: "1px solid #E8592A", background: "#fff", color: "#E8592A",
                       cursor: saveRule.isPending ? "default" : "pointer", fontFamily: "inherit",
                       fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
              <FloppyDisk size={12} /> {saveRule.isPending ? "..." : "Запомнить"}
            </button>
          )}
        </div>
        {tx.match_source === "suggest" && tx.master_suggested && !ruleSaved && (
          <div style={{ fontSize: 10, color: "#E8592A", marginTop: 6 }}>
            Похоже: {tx.master_suggested.name}? Проверь и нажми «Запомнить» — правило закроет
            все платежи этого контрагента.
          </div>
        )}
        {ruleSaved && (
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#4A7C59", marginTop: 6 }}>
            <Check size={11} /> запомнено: платежи «{payeeStr}» → {masterName(payeeMaster) || tx.payee_hint}
          </div>
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
          <button type="button" onClick={splitEvenly}
            style={{ marginLeft: 10, fontSize: 10, color: "#E8592A", background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
            Поровну
          </button>
        )}
      </div>

      {allocs.map((a, i) => {
        const o = ordersById.get(a.order_id);
        const catLabel = EXPENSE_CATEGORIES.find(c => c.v === a.category)?.l ?? "Прочее";
        const genLabel = a.purpose ? GENERAL_TARGETS.find(t => t.v === a.purpose)?.l : null;
        return (
          <div key={a.order_id || "p:" + a.purpose} style={{ background: "#fff", border: "1px solid #EDEBE6", padding: "8px 10px", marginBottom: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 110px 36px" : "1fr 120px 24px", gap: 8, alignItems: "center" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: genLabel ? "#E8592A" : "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {genLabel ? genLabel + " · без заказа" : (o?.title ?? a.order_id)}
                </div>
                {/* Себестоимость заказа прямо здесь: раньше, чтобы понять «сколько по
                    нему уже потрачено», надо было уйти с экрана разбора выписки. */}
                {!genLabel && o && (o.cost_plan > 0 || o.cost_fact > 0) && (
                  <OrderCost plan={o.cost_plan} fact={o.cost_fact} debt={o.debt} />
                )}
              </div>
              <MoneyInput value={a.amount} onChange={v => patch(i, { amount: v })} placeholder="сумма"
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: "5px 8px", fontSize: 12, outline: "none" }} />
              <button type="button" onClick={() => setAllocs(allocs.filter((_, j) => j !== i))}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: isMobile ? 8 : 0, display: "flex", justifyContent: "center" }}>
                <X size={isMobile ? 16 : 12} />
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
              {/* Категория — компактные чипы */}
              <div style={{ display: "flex" }}>
                {EXPENSE_CATEGORIES.map(c => (
                  <button type="button" key={c.v} onClick={() => patch(i, { category: c.v, creditor_id: null })}
                    style={{
                      padding: isMobile ? "9px 12px" : "3px 9px", fontSize: isMobile ? 13 : 10, cursor: "pointer", border: "1px solid",
                      borderColor: a.category === c.v ? "#1A1A1A" : "#EDEBE6",
                      background: a.category === c.v ? "#1A1A1A" : "#fff",
                      color: a.category === c.v ? "#FFFFFF" : "#A89070", marginRight: -1, fontFamily: "inherit",
                    }}>{c.l}</button>
                ))}
              </div>
              {/* Контрагент строки: может отличаться от получателя платежа */}
              <PayeePicker value={a.master_id} onChange={v => patch(i, { master_id: v })}
                suggestName={payeeStr} style={{ flex: 1, minWidth: isMobile ? "100%" : 220 }} />
            </div>
            {/* Обязательства бывают только у заказов — строке «без заказа» гасить нечего */}
            {!a.purpose && <ObligationPicker
              orderId={a.order_id}
              categoryLabel={catLabel}
              value={a.creditor_id}
              amount={a.amount}
              onPick={(cid, remaining) => {
                // Разносим ПЛАТЁЖ, а не план. В пустую сумму кладём неразнесённую часть
                // платежа, но не больше остатка по плановой строке. Введённую вручную не трогаем.
                let amount = a.amount;
                if (cid && !a.amount) {
                  const other = allocs.reduce((s, x, j) => j === i ? s : s + (parseMoney(x.amount) || 0), 0);
                  const txLeft = Math.max(0, tx.amount - other);
                  const def = Math.min(remaining, txLeft);
                  if (def > 0) amount = String(def);
                }
                patch(i, { creditor_id: cid, amount });
              }}
            />}
          </div>
        );
      })}

      {/* Подсказки заказов */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, marginBottom: 12 }}>
        {(suggestions as any[]).filter((o: any) => !allocs.some(a => a.order_id === o.id)).slice(0, 6).map((o: any) => (
          <button type="button" key={o.id} onClick={() => addOrder(o.id)}
            style={{ fontSize: 11, padding: "3px 9px", border: "1px solid #EDEBE6", background: "#fff", cursor: "pointer", color: "#6B6355", fontFamily: "inherit" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#E8592A"; e.currentTarget.style.color = "#E8592A"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#EDEBE6"; e.currentTarget.style.color = "#6B6355"; }}>
            + {o.title}
          </button>
        ))}
        {GENERAL_TARGETS.filter(t => !allocs.some(a => a.purpose === t.v)).map(t => (
          <button type="button" key={t.v} onClick={() => addGeneral(t.v)}
            title="Часть перевода не относится ни к какому заказу"
            style={{ fontSize: 11, padding: "3px 9px", border: "1px dashed #EDEBE6", background: "#fff", cursor: "pointer", color: "#A89070", fontFamily: "inherit" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#E8592A"; e.currentTarget.style.color = "#E8592A"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#EDEBE6"; e.currentTarget.style.color = "#A89070"; }}>
            + {t.l}
          </button>
        ))}
      </div>

      {/* Итог и кнопка */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #EDEBE6", paddingTop: 10, gap: 12, flexWrap: "wrap" }}>
        {/* Скрыть: перевод между своими счетами, возврат — не расход бизнеса */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {rowMode === "hide" ? (
            <>
              <span style={{ fontSize: 10, color: "#A89070" }}>Скрыть:</span>
              {DISMISS_REASONS.map(r => (
                <button type="button" key={r} disabled={dismiss.isPending} onClick={() => dismiss.mutate(r)}
                  style={{ fontSize: 10, padding: "3px 8px", border: "1px solid #EDEBE6", background: "#fff", cursor: "pointer", color: "#6B6355", fontFamily: "inherit" }}>
                  {r}
                </button>
              ))}
              <button type="button" onClick={() => setRowMode("none")} style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 2, display: "flex" }}>
                <X size={11} />
              </button>
            </>
          ) : rowMode === "accountable" ? (
            <>
              <span style={{ fontSize: 10, color: "#A89070" }}>Под отчёт:</span>
              <select value={accountablePick} onChange={e => setAccountablePick(e.target.value)}
                style={{ border: "1px solid #EDEBE6", padding: "3px 6px", fontSize: 11, outline: "none", background: "#fff", cursor: "pointer" }}>
                <option value="">— кому —</option>
                {(masters as any[]).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <button type="button" disabled={!accountablePick || issueAccountable.isPending} onClick={() => issueAccountable.mutate()}
                style={{ fontSize: 10, padding: "3px 10px", border: "none", background: accountablePick ? "#E8592A" : "#EDEBE6",
                  color: accountablePick ? "#fff" : "#A89070", cursor: accountablePick ? "pointer" : "default", fontFamily: "inherit", fontWeight: 600 }}>
                {issueAccountable.isPending ? "..." : "Выдать"}
              </button>
              <button type="button" onClick={() => setRowMode("none")} style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 2, display: "flex" }}>
                <X size={11} />
              </button>
            </>
          ) : rowMode === "personal" ? (
            <>
              <span style={{ fontSize: 10, color: "#A89070" }}>Личное:</span>
              {PERSONAL_SUBCATS.map(sc => {
                const on = personalSubcat === sc;
                return (
                  <button type="button" key={sc} onClick={() => setPersonalSubcat(sc)}
                    style={{ fontSize: 10, padding: "3px 8px", border: `1px solid ${on ? "#E8592A" : "#EDEBE6"}`,
                      background: on ? "#FFF4EE" : "#fff", color: on ? "#E8592A" : "#6B6355",
                      cursor: "pointer", fontFamily: "inherit", fontWeight: on ? 600 : 400 }}>
                    {sc}
                  </button>
                );
              })}
              {payeeStr && (
                <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#6B6355", cursor: "pointer" }}>
                  <input type="checkbox" checked={rememberPersonal} onChange={e => setRememberPersonal(e.target.checked)} />
                  запомнить «{payeeStr}»
                </label>
              )}
              <button type="button" disabled={markPersonal.isPending} onClick={() => markPersonal.mutate()}
                style={{ fontSize: 10, padding: "3px 10px", border: "none", background: "#E8592A", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
                {markPersonal.isPending ? "..." : (rememberPersonal && payeeStr ? "Запомнить" : "Скрыть")}
              </button>
              <button type="button" onClick={() => setRowMode("none")} style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 2, display: "flex" }}>
                <X size={11} />
              </button>
            </>
          ) : (
            <>
              <ActionChip icon={<EyeSlash size={12} />} label="Не расход"
                title="Скрыть: перевод между своими, возврат — не расход бизнеса"
                onClick={() => setRowMode("hide")} />
              <ActionChip icon={<HandCoins size={12} />} label="Под отчёт"
                title="Перевод доверенному лицу: не расход по заказу — деньги выданы под отчёт"
                onClick={() => setRowMode("accountable")} />
              <ActionChip icon={<User size={12} />} label="Личное"
                title="Личная трата (не бизнес): убрать из Разноски. В личном ZenMoney остаётся."
                onClick={() => setRowMode("personal")} />
            </>
          )}
        </div>
        <div style={{ fontSize: 11, color: Math.abs(diff) < 0.01 ? "#4A7C59" : "#8B3A3A", fontFamily: MONO }}>
          {allocs.length === 0 ? <span style={{ color: "#A89070" }}>выберите заказ</span> :
            Math.abs(diff) < 0.01 ? `✓ разнесено ${fmt(sum)} — сходится с платежом` :
            diff > 0 ? `осталось разнести ${fmt(diff)} из платежа ${fmt(tx.amount)}` :
                       `разнесено ${fmt(sum)} — больше платежа ${fmt(tx.amount)} на ${fmt(Math.abs(diff))}`}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {error && <span style={{ fontSize: 11, color: "#8B3A3A" }}>{error}</span>}
          <button type="button" disabled={!ready || save.isPending} onClick={() => { setError(""); save.mutate(); }}
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

// ── Строка разноски ПОСТУПЛЕНИЯ: входящий платёж банка → payments по заказам ──
const DISMISS_REASONS = ["Перевод между своими", "Возврат", "Не по заказам"];
// Под-категории личных трат (синхрон с PERSONAL_SUBCATS в backend/routers/finance.py).
const PERSONAL_SUBCATS = ["Подписки", "Еда", "Друзья", "Развлечения", "Прочее"];

// Кнопка-действие «иконка + подпись» с рамкой — явная кликабельность (не серый текст).
function ActionChip({ icon, label, title, onClick }:
  { icon: ReactNode; label: string; title?: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onClick={onClick} title={title}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, lineHeight: 1,
        padding: "4px 9px", cursor: "pointer", fontFamily: "inherit",
        border: `1px solid ${hover ? "#E8592A" : "#EDEBE6"}`,
        background: hover ? "#FFF4EE" : "#fff", color: hover ? "#E8592A" : "#6B6355",
      }}>
      {icon} {label}
    </button>
  );
}

/** Себестоимость заказа в строке разноски: план → факт, полоска покрытия,
 *  перерасход красным. Данные приходят из /orders/suggest (добавлены 24.08.2026). */
function OrderCost({ plan, fact, debt }: { plan: number; fact: number; debt?: number }) {
  const pct = plan > 0 ? Math.min(100, (fact / plan) * 100) : 0;
  const over = fact > plan && plan > 0;
  return (
    <div style={{ marginTop: 3 }}>
      <div style={{ fontSize: 10, color: "#A89070" }}>
        себест. план <span style={{ fontFamily: MONO }}>{fmt(plan)}</span>
        <span style={{ color: "#C8C0B0" }}> → </span>
        факт <span style={{ fontFamily: MONO, color: over ? "#8B3A3A" : "#6B6355", fontWeight: over ? 700 : 400 }}>{fmt(fact)}</span>
        {over && <span style={{ color: "#8B3A3A" }}> · перерасход {fmt(fact - plan)}</span>}
        {!over && (debt ?? 0) > 0 && <span> · клиент должен {fmt(debt!)}</span>}
      </div>
      <div style={{ height: 2, background: "#EDEBE6", marginTop: 3, maxWidth: 240 }}>
        <div style={{ height: 2, width: `${pct}%`, background: over ? "#8B3A3A" : "#4A7C59" }} />
      </div>
    </div>
  );
}

function PaymentAllocRow({ tx, onDone, onReservePrompt }: {
  tx: any; onDone: () => void;
  onReservePrompt: (p: { order_id: string; amount: number }) => void;
}) {
  const isMobile = useIsMobile();
  const [allocs, setAllocs] = useState<PayAlloc[]>([]);
  const [error, setError] = useState("");
  const [hideMode, setHideMode] = useState(false);
  // Плательщик поступления — клиент. Правило запоминает строку банка → клиент,
  // чтобы следующие платежи от него узнавались сами.
  const [payerCustomer, setPayerCustomer] = useState<string>(tx.customer_id || tx.customer_suggested?.id || "");
  const payerStr = (tx.counterparty || "").trim();
  const qcRow = useQueryClient();
  const { data: customers = [] } = useQuery({ queryKey: ["customers", ""], queryFn: () => customersApi.list("") });
  const customerName = (cid: string) => (customers as any[]).find((c: any) => c.id === cid)?.name;
  const payerSaved = tx.match_source === "rule" && payerCustomer === tx.customer_id;
  const savePayerRule = useMutation({
    mutationFn: () => payeeRulesApi.create({
      pattern: payerStr, match_type: "exact",
      entity_type: "customer", entity_id: payerCustomer, entity_name: customerName(payerCustomer),
    }),
    onSuccess: () => qcRow.invalidateQueries({ queryKey: ["expenses-inbox"] }),
  });

  const save = useMutation({
    mutationFn: () => paymentsApi.fromTx({
      tx_id: tx.id,
      allocations: allocPayload(allocs),
    }),
    onSuccess: (res: any) => {
      onDone();
      // Деньги пришли → предложить отложить под материалы (подсказку считает бэкенд).
      if (res?.order_id && res?.reserve_suggested > 0 && !res?.reserve_active) {
        onReservePrompt({ order_id: res.order_id, amount: res.reserve_suggested });
      }
    },
    onError: (e: any) => setError(e?.response?.data?.detail || "Не удалось разнести"),
  });

  const dismiss = useMutation({
    mutationFn: (reason: string) => paymentsApi.dismiss(tx.id, reason),
    onSuccess: onDone,
  });

  const ready = allocReady(allocs, tx.amount);

  return (
    <div style={{ padding: isMobile ? "12px 16px 16px" : "14px 28px 18px", background: "#FAF8F5", borderBottom: "1px solid #EDEBE6" }}>
      {/* Плательщик: кто прислал деньги. Правило учит систему узнавать его впредь. */}
      <div style={{ marginBottom: 14, padding: "10px 12px", background: "#fff", border: "1px solid #EDEBE6" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 9, color: "#A89070", letterSpacing: "0.06em" }}>ПЛАТЕЛЬЩИК</div>
          <div style={{ fontSize: 12, color: "#1A1A1A", flex: "0 0 auto" }}>{payerStr || "—"}</div>
          <span style={{ color: "#C8C0B0" }}>→</span>
          <CustomerPicker value={payerCustomer} onChange={setPayerCustomer} suggestName={payerStr}
            highlight={tx.match_source === "suggest"} style={{ flex: 1, minWidth: isMobile ? "100%" : 260 }} />
          {payerCustomer && payerStr && !payerSaved && (
            <button type="button" onClick={() => savePayerRule.mutate()} disabled={savePayerRule.isPending}
              title={`Запомнить: все платежи от «${payerStr}» → ${customerName(payerCustomer)}`}
              style={{ display: "flex", alignItems: "center", gap: 5, fontSize: isMobile ? 13 : 10.5, padding: isMobile ? "9px 12px" : "5px 10px",
                       border: "1px solid #E8592A", background: "#fff", color: "#E8592A",
                       cursor: savePayerRule.isPending ? "default" : "pointer", fontFamily: "inherit",
                       fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
              <FloppyDisk size={12} /> {savePayerRule.isPending ? "..." : "Запомнить"}
            </button>
          )}
        </div>
        {tx.match_source === "suggest" && tx.customer_suggested && !payerSaved && (
          <div style={{ fontSize: 10, color: "#E8592A", marginTop: 6 }}>
            Похоже: {tx.customer_suggested.name}? Проверь и нажми «Запомнить».
          </div>
        )}
        {payerSaved && (
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#4A7C59", marginTop: 6 }}>
            <Check size={11} /> запомнено: платежи от «{payerStr}» → {customerName(payerCustomer) || tx.payee_hint}
          </div>
        )}
      </div>

      <PaymentAllocator tx={tx} allocs={allocs} onChange={(next) => setAllocs(next)} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #EDEBE6", paddingTop: 10, gap: 12, flexWrap: "wrap" }}>
        {/* Скрыть: не по заказам (перевод между своими, возврат) */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {hideMode ? (
            <>
              <span style={{ fontSize: 10, color: "#A89070" }}>Скрыть:</span>
              {DISMISS_REASONS.map(r => (
                <button type="button" key={r} disabled={dismiss.isPending} onClick={() => dismiss.mutate(r)}
                  style={{ fontSize: 10, padding: "3px 8px", border: "1px solid #EDEBE6", background: "#fff", cursor: "pointer", color: "#6B6355", fontFamily: "inherit" }}>
                  {r}
                </button>
              ))}
              <button type="button" onClick={() => setHideMode(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 2, display: "flex" }}>
                <X size={11} />
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setHideMode(true)}
              style={{ fontSize: 10, color: "#A89070", background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
              Это не по заказам — скрыть
            </button>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {error && <span style={{ fontSize: 11, color: "#8B3A3A" }}>{error}</span>}
          <button type="button" disabled={!ready || save.isPending} onClick={() => { setError(""); save.mutate(); }}
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
  const isMobile = useIsMobile();
  const [source, setSource] = useState<"bank" | "zen" | "in">("bank");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amtMin, setAmtMin] = useState("");
  const [amtMax, setAmtMax] = useState("");
  const [cpFilter, setCpFilter] = useState("");   // контрагент (клиентская фильтрация)
  const [openId, setOpenId] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  // Разнесли платёж одним заказом → предложить отложить резерв под материалы.
  const [reservePrompt, setReservePrompt] = useState<{ order_id: string; amount: number } | null>(null);

  const isIncoming = source === "in";
  // Тянем широкий срез — страницы листаются на клиенте (Pager), чтобы был виден весь год.
  const params: Record<string, string | number> = { limit: 500 };
  if (!isIncoming) params.source = source;
  if (showDismissed) params.show_dismissed = "true";
  if (search) params.search = search;
  if (from) params.date_from = from;
  if (to) params.date_to = to;
  if (amtMin) params.amount_min = amtMin;
  if (amtMax) params.amount_max = amtMax;

  const { data, isLoading } = useQuery({
    queryKey: ["expenses-inbox", source, search, from, to, amtMin, amtMax, showDismissed],
    queryFn: () => (isIncoming ? paymentsApi.inbox(params) : inboxApi.list(params)),
  });

  const allItems: any[] = data?.items ?? [];
  const uniqueCps = [...new Set(allItems.map((t: any) => t.counterparty).filter(Boolean))].sort() as string[];
  const items: any[] = cpFilter ? allItems.filter((t: any) => t.counterparty === cpFilter) : allItems;
  // degraded: набор «уже разнесённых» неполон (сбой БД) — разноска отключена, иначе
  // риск двойного платежа. truncated: показаны не все неразнесённые — уточни фильтры.
  const degraded = !!data?.degraded;
  const truncated = !!data?.truncated;
  const pager = usePager(items.length, "inbox_page_size");
  const pageItems = pager.slice(items);

  const onDone = () => {
    setOpenId(null);
    qc.invalidateQueries({ queryKey: ["expenses-inbox"] });
    qc.invalidateQueries({ queryKey: ["orders-v2"] });
    qc.invalidateQueries({ queryKey: ["orders-plan-fact-summary"] });
    qc.invalidateQueries({ queryKey: ["order-detail"] });
  };

  const undismiss = useMutation({
    // Поступления и списания скрываются в одной таблице, но под разными source-ключами.
    mutationFn: (txId: string) => isIncoming ? paymentsApi.undismiss(txId) : inboxApi.undismiss(txId, source),
    onSuccess: onDone,
  });

  const setReserve = useMutation({
    mutationFn: (p: { order_id: string; amount: number }) => ordersApi.reserve(p.order_id, p.amount),
    onSuccess: () => { setReservePrompt(null); onDone(); },
  });

  const clearFilters = () => { setSearch(""); setFrom(""); setTo(""); setAmtMin(""); setAmtMax(""); setCpFilter(""); };
  const hasFilters = !!(search || from || to || amtMin || amtMax || cpFilter);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>

      {/* Шапка */}
      <div style={{ padding: isMobile ? "14px 16px 0" : "24px 28px 0" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: isMobile ? 10 : 16 }}>
          <div style={{ fontSize: isMobile ? 22 : 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Разноска</div>
          <div style={{ position: "relative" }}>
            <MagnifyingGlass size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#A89070" }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Контрагент..."
              style={{ paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6, border: "1px solid #EDEBE6", background: "transparent", fontSize: 12, color: "#1A1A1A", outline: "none", width: isMobile ? 150 : 200, borderRadius: 0 }} />
          </div>
        </div>

        <div style={{ display: "flex", gap: isMobile ? 18 : 24, borderBottom: "1px solid #EDEBE6", ...(isMobile ? M.tabStrip : null) }}>
          {SOURCES.map(s => (
            <button type="button" key={s.id} onClick={() => { setSource(s.id); setOpenId(null); }}
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
      <div style={{ padding: isMobile ? "8px 16px" : "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0, flexWrap: isMobile ? "wrap" : undefined, gap: isMobile ? 6 : 0 }}>
        <div style={{ display: "flex", gap: isMobile ? 10 : 16, alignItems: "center", fontSize: 11, color: "#6B6355", flexWrap: isMobile ? "wrap" : undefined }}>
          <span>{items.length}{truncated ? "+" : ""} неразнесённых</span>
          {/* Личные по умолчанию окном в 90 дней — раньше это был просто текст, теперь кнопка */}
          {source === "zen" && !from && (
            <button type="button" onClick={() => { setFrom("2020-01-01"); setTo(""); }}
              style={{ fontSize: 10, color: "#6B6355", background: "#fff", border: "1px solid #EDEBE6",
                       padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>
              показаны 90 дней — за всё время
            </button>
          )}
          {truncated && (
            <span style={{ fontSize: 10, color: "#8B3A3A" }}>показаны первые {items.length} — уточни период/фильтры</span>
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 10, color: "#A89070" }}>
            <input type="checkbox" checked={showDismissed} onChange={e => setShowDismissed(e.target.checked)} />
            показать скрытые
          </label>
        </div>
        <button type="button" onClick={hasFilters ? clearFilters : undefined}
          style={{ fontSize: 10, color: hasFilters ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: hasFilters ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
          <X size={10} /> Сбросить
        </button>
      </div>

      {/* Деградация: проверка «разнесено ли» неполна — разноску отключаем */}
      {degraded && (
        <div style={{ margin: "8px 28px 0", padding: "9px 12px", background: "#FDECEA", borderLeft: "3px solid #8B3A3A", fontSize: 11, color: "#8B3A3A" }}>
          ⚠ Не удалось полностью проверить, какие поступления уже разнесены (сбой доступа к базе).
          Разноска временно отключена, чтобы не провести платёж дважды. Обнови страницу через минуту.
        </div>
      )}

      {/* Заголовки = фильтры (единый формат таблиц: название столбца открывает фильтр) */}
      <div style={isMobile ? M.filterRow : { display: "grid", gridTemplateColumns: "80px 1fr 130px", gap: 12, padding: "8px 28px", borderBottom: "1px solid #F7F5F1" }}>
        <div><PeriodFilter label="ДАТА" from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /></div>
        <div><ColumnFilter label="КОНТРАГЕНТ / НАЗНАЧЕНИЕ" options={uniqueCps} value={cpFilter} onChange={setCpFilter} /></div>
        <div style={{ textAlign: "right" }}><AmountFilter label="СУММА" min={amtMin} max={amtMax} onChange={(mn, mx) => { setAmtMin(mn); setAmtMax(mx); }} align="right" /></div>
      </div>

      {/* Список */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {isLoading ? <Loading compact /> :
         items.length === 0 ? (
          isIncoming
            ? <EmptyState compact title="Все поступления разнесены" hint="Входящих платежей без привязки к заказам не осталось" />
            : <EmptyState compact title="Всё разнесено" hint="Списаний без привязки к заказам не осталось" />
         ) :
         pageItems.map((t: any) => (
          <div key={t.id}>
            <div onClick={() => { if (!degraded) setOpenId(openId === t.id ? null : t.id); }}
              style={{
                display: "grid", gridTemplateColumns: isMobile ? "1fr auto" : "80px 1fr 130px", gap: isMobile ? "2px 12px" : 12, padding: isMobile ? "12px 16px" : "11px 28px",
                borderBottom: "1px solid #F7F5F1", cursor: degraded ? "default" : "pointer", alignItems: "center",
                background: openId === t.id ? "#FFF8F5" : "transparent",
                opacity: t.dismissed_reason ? 0.55 : (degraded ? 0.6 : 1),
              }}
              onMouseEnter={e => { if (openId !== t.id) e.currentTarget.style.background = "#FAF8F5"; }}
              onMouseLeave={e => { if (openId !== t.id) e.currentTarget.style.background = "transparent"; }}>
              <div style={{ fontSize: 11, color: "#A89070", fontFamily: MONO, ...(isMobile ? { gridColumn: "1 / -1", order: 2 } : null) }}>{fmtDate(t.date)}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: isMobile ? 14 : 12, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.counterparty || "—"}
                  {/* Зелёное — привязка подтверждена правилом; оранжевое с «?» — только догадка */}
                  {t.payee_hint && t.payee_hint !== t.counterparty && (
                    <span style={{ color: t.match_source === "suggest" ? "#E8592A" : "#4A7C59", fontSize: 10, marginLeft: 6 }}>
                      → {t.payee_hint}{t.match_source === "suggest" ? "?" : ""}
                    </span>
                  )}
                  {t.dismissed_reason && (
                    <span style={{ color: "#A89070", fontSize: 10, marginLeft: 6 }}>· скрыто: {t.dismissed_reason}</span>
                  )}
                </div>
                {(t.purpose || t.zen_tag) && (
                  <div style={{ fontSize: 10, color: "#A89070", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.purpose}
                    {t.zen_tag && <span style={{ color: "#C8C0B0" }}>{t.purpose ? " · " : ""}ZenMoney: {t.zen_tag}</span>}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: isIncoming ? "#4A7C59" : "#8B3A3A", textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                {isIncoming ? "+" : "−"}{fmt(t.amount)}
              </div>
            </div>
            {openId === t.id && (
              t.dismissed_reason ? (
                <div style={{ padding: "12px 28px", background: "#FAF8F5", borderBottom: "1px solid #EDEBE6",
                  display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "#6B6355" }}>
                  Скрыто из инбокса: {t.dismissed_reason}
                  <button type="button" disabled={undismiss.isPending} onClick={() => undismiss.mutate(t.id)}
                    style={{ fontSize: 11, color: "#E8592A", background: "none", border: "1px solid #E8592A",
                      padding: "3px 10px", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
                    <ArrowCounterClockwise size={11} /> Вернуть в инбокс
                  </button>
                </div>
              ) : isIncoming ? (
                <PaymentAllocRow tx={t} onDone={onDone} onReservePrompt={setReservePrompt} />
              ) : (
                <AllocRow tx={t} onDone={onDone} />
              )
            )}
          </div>
        ))}
      </div>

      {items.length > 0 && <Pager pager={pager} totalCount={items.length} truncated={truncated} />}

      {/* Деньги пришли → предложение резерва под материалы */}
      {reservePrompt && (
        <Modal size="sm" eyebrow="РЕЗЕРВ ПОД МАТЕРИАЛЫ" onClose={() => setReservePrompt(null)}
          onCancel={() => setReservePrompt(null)}
          onSave={() => setReserve.mutate(reservePrompt)}
          saveLabel={setReserve.isPending ? "Откладываем..." : "Отложить"}>
          <div style={{ padding: "18px 24px", fontSize: 13, lineHeight: 1.5, color: "#1A1A1A" }}>
            Платёж разнесён. Отложить <span style={{ fontFamily: MONO, fontWeight: 600 }}>{fmt(reservePrompt.amount)}</span>{" "}
            под материалы по смете этого заказа, чтобы деньги не разошлись?
          </div>
        </Modal>
      )}
    </div>
  );
}
