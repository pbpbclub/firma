import { useState } from "react";
import { MoneyInput, parseMoney } from "./ui/MoneyInput";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "./ui/Modal";
import { PayeePicker } from "./ui/PayeePicker";
import { MONO } from "./ui/Num";
import { mastersApi, financeApi, accountableApi, ledgerApi } from "../api";

// Источник оплаты (наличный контур): безнал — как раньше; касса — спишется из
// фонда «Касса (наличные)»; подотчётник — оплатило доверенное лицо из выданных
// под отчёт денег (его баланс «на руках» уменьшится).
const PAYMENT_SOURCES = [
  { v: "",            l: "Безнал" },
  { v: "cash_fund",   l: "Наличные (касса)" },
  { v: "accountable", l: "Через подотчётника" },
];

// 4 корзины план-факта. Свободный ввод запрещён: категория вне списка молча
// уедет в «Прочее» (backend _bucket тотальная) и потеряется в разбивке.
export const EXPENSE_CATEGORIES = [
  { v: "material", l: "Материалы" },
  { v: "work",     l: "Работы" },
  { v: "delivery", l: "Доставка" },
  { v: "other",    l: "Прочее" },
];

// A1 (ТЗ 24.08.2026): расход по заказу — это «работа принята». Двинул ли он деньги
// подрядчику, отдельный вопрос: до этого поля лицевой счёт считал выплатой любой
// расход, и разноска ORD-024 перевернула сальдо Кебры с «мы должны 1 800» на
// «должен отработать 22 200», хотя в тот день никто ничего не переводил.
const SETTLEMENTS = [
  { v: "cash",        l: "Деньгами",       hint: "Деньги ушли этим расходом — обычный случай." },
  { v: "advance",     l: "Авансом",        hint: "Закрыто ранее выданным авансом: себестоимость вырастет, сальдо не сдвинется." },
  { v: "offset",      l: "Зачётом",        hint: "Взаимозачёт встречных работ: денег не было, наш долг гасится." },
  { v: "third_party", l: "Оплатой за него", hint: "Закрыто оплатой, которую мы сделали за него третьему лицу." },
  { v: "none",        l: "Ещё должны",     hint: "Работа принята, деньги не уходили и долг остаётся." },
];
const NON_CASH = ["advance", "offset", "third_party", "none"];

const lbl: React.CSSProperties = { fontSize: 9, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 };
const inp: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6",
  padding: "7px 10px", fontSize: 12, outline: "none", background: "transparent", color: "#1A1A1A",
};

export function ExpenseModal({ orderId, expense, existingExpenses = [], extras = [], onSave, onClose, saving }: {
  orderId: string;
  expense?: any;               // если передан — режим правки
  existingExpenses?: any[];    // траты заказа — для предупреждения о дубле
  extras?: any[];              // допработы заказа — трата может быть по допу, а не по смете
  onSave: (data: any) => void;
  onClose: () => void;
  saving?: boolean;
}) {
  const [title, setTitle]       = useState(expense?.title ?? "");
  const [amount, setAmount]     = useState(expense?.amount != null ? String(expense.amount) : "");
  // Последняя категория запоминается по заказу: десять расходов «Работы» подряд
  // не должны требовать десяти переставлений чипа. Тот же приём, что у размера
  // страницы в пагинаторе (usePager с ключом localStorage).
  const catKey = `expense_cat_${orderId}`;
  const [category, setCategory] = useState<string>(() => {
    if (expense?.category) return expense.category;
    try { return localStorage.getItem(catKey) || "material"; } catch { return "material"; }
  });
  const [masterId, setMasterId] = useState(expense?.master_id ?? "");
  const [date, setDate]         = useState(expense?.expense_date ?? new Date().toISOString().slice(0, 10));
  const [creditorId, setCreditorId] = useState<string | null>(expense?.creditor_id ?? null);
  const [paySource, setPaySource] = useState(expense?.payment_source ?? "");
  const [accountableId, setAccountableId] = useState(expense?.accountable_person_id ?? "");
  const [dupConfirmed, setDupConfirmed] = useState(false);
  const [extraId, setExtraId] = useState<string>(expense?.extra_id ?? "");
  const [settledBy, setSettledBy] = useState<string>(expense?.settled_by ?? "cash");

  const { data: masters = [] } = useQuery({ queryKey: ["masters"], queryFn: mastersApi.list });
  const { data: accountables = [] } = useQuery({ queryKey: ["accountable"], queryFn: accountableApi.list });
  // Обязательства этого заказа — чтобы поймать двойной счёт до того, как он случится.
  // Эндпоинт отдаёт обёртку {items, total_*} — разворачиваем сразу, иначе .find по
  // объекту роняет рендер («Добавить расход» падал в ErrorBoundary).
  const { data: creditors = [] } = useQuery({
    queryKey: ["creditors"],
    queryFn: () => financeApi.creditors().then((r: any) => r?.items ?? r ?? []),
  });

  const master = (masters as any[]).find((m: any) => m.id === masterId);
  const supplier = master?.name ?? expense?.supplier ?? null;

  // Незакрытое обязательство того же заказа с тем же подрядчиком — вероятно, это оно и есть.
  const candidate = (creditors as any[]).find((c: any) =>
    c.order_id && String(c.order_id) === String(orderId) && supplier && c.name === supplier
  );

  // Сальдо подрядчика — чтобы «закрыто авансом» не оказалось закрытием
  // несуществующего аванса. balance < 0 = у него наши деньги.
  const noCash = NON_CASH.includes(settledBy);
  const { data: ledger } = useQuery({
    queryKey: ["ledger", "master", masterId],
    queryFn: () => ledgerApi.master(masterId),
    enabled: !!masterId && settledBy === "advance",
  });
  const advanceLeft = ledger?.balance != null ? Math.max(0, -ledger.balance) : null;

  const amountNum = parseMoney(amount);
  const valid = title.trim().length > 0 && !isNaN(amountNum) && amountNum > 0
    && (paySource !== "accountable" || !!accountableId)
    // Без подрядчика непонятно, чей аванс/зачёт закрывает расход — бэк такое отвергает.
    && (!noCash || !!masterId);

  // Похоже на дубль: та же сумма (±1 ₽) и тот же поставщик/название, дата ±3 дня.
  const dupCandidate = !expense && valid ? (existingExpenses as any[]).find((e: any) => {
    if (Math.abs((e.amount || 0) - amountNum) > 1) return false;
    const sameWho = (supplier && e.supplier === supplier) || (e.title || "").trim() === title.trim();
    if (!sameWho) return false;
    const d1 = new Date(e.expense_date || 0).getTime(), d2 = new Date(date || 0).getTime();
    return Math.abs(d1 - d2) <= 3 * 86400_000;
  }) : null;

  const submit = () => {
    if (!valid) return;
    if (dupCandidate && !dupConfirmed) { setDupConfirmed(true); return; }
    try { localStorage.setItem(catKey, category); } catch { /* приватный режим — не беда */ }
    onSave({
      title: title.trim(),
      amount: amountNum,
      category,
      supplier,
      master_id: masterId || null,
      expense_date: date || null,
      creditor_id: creditorId,
      // Денег не было — не было и наличного контура (бэк это тоже проверяет).
      payment_source: noCash ? null : (paySource || null),
      accountable_person_id: !noCash && paySource === "accountable" ? accountableId : null,
      extra_id: extraId || null,
      settled_by: settledBy,
    });
  };

  return (
    <Modal
      size="md"
      eyebrow={expense ? "РАСХОД · ПРАВКА" : "НОВЫЙ РАСХОД"}
      onClose={onClose}
      onCancel={onClose}
      onSave={submit}
      canSave={valid}
      saving={saving}
      saveLabel={expense ? "Сохранить" : "Добавить"}
    >
      <div style={{ padding: "16px 24px 20px" }}>

        <div style={lbl}>НАЗВАНИЕ</div>
        <input style={inp} autoFocus value={title} onChange={e => setTitle(e.target.value)}
          placeholder="Например: Плазменная резка столешниц" />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
          <div>
            <div style={lbl}>СУММА ₽</div>
            <MoneyInput style={inp} value={amount} onChange={setAmount} />
          </div>
          <div>
            <div style={lbl}>ДАТА</div>
            <input style={{ ...inp, fontFamily: MONO }} type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={lbl}>КАТЕГОРИЯ</div>
          <div style={{ display: "flex" }}>
            {EXPENSE_CATEGORIES.map(c => (
              <button type="button" key={c.v} onClick={() => setCategory(c.v)}
                style={{
                  padding: "5px 12px", fontSize: 11, cursor: "pointer", border: "1px solid",
                  borderColor: category === c.v ? "#1A1A1A" : "#EDEBE6",
                  background: category === c.v ? "#1A1A1A" : "transparent",
                  color: category === c.v ? "#FFFFFF" : "#A89070",
                  marginRight: -1, fontFamily: "inherit",
                }}>{c.l}</button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={lbl}>ЧЕМ ЗАКРЫТО</div>
          <div style={{ display: "flex", flexWrap: "wrap" }}>
            {SETTLEMENTS.map(p => (
              <button type="button" key={p.v} onClick={() => setSettledBy(p.v)} title={p.hint}
                style={{
                  padding: "5px 11px", fontSize: 11, cursor: "pointer", border: "1px solid",
                  borderColor: settledBy === p.v ? "#1A1A1A" : "#EDEBE6",
                  background: settledBy === p.v ? "#1A1A1A" : "transparent",
                  color: settledBy === p.v ? "#FFFFFF" : "#A89070",
                  marginRight: -1, fontFamily: "inherit",
                }}>{p.l}</button>
            ))}
          </div>
          <div style={{ fontSize: 10, color: "#A89070", marginTop: 5, lineHeight: 1.5 }}>
            {SETTLEMENTS.find(p => p.v === settledBy)?.hint}
          </div>
          {noCash && !masterId && (
            <div style={{ fontSize: 10, color: "#8B3A3A", marginTop: 4 }}>
              Укажи подрядчика ниже — иначе непонятно, чей аванс или зачёт это закрывает.
            </div>
          )}
          {settledBy === "advance" && masterId && advanceLeft != null && (
            <div style={{ fontSize: 10, marginTop: 4, color: advanceLeft >= (amountNum || 0) ? "#4A7C59" : "#8B3A3A" }}>
              {advanceLeft > 0
                ? `У подрядчика аванс ${new Intl.NumberFormat("ru-RU").format(advanceLeft)} ₽`
                : "У подрядчика нет невыбранного аванса — сальдо уйдёт в минус"}
              {advanceLeft > 0 && (amountNum || 0) > advanceLeft && " — этого расхода он не покрывает"}
            </div>
          )}
        </div>

        {!noCash && <div style={{ marginTop: 14 }}>
          <div style={lbl}>ИСТОЧНИК ОПЛАТЫ</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex" }}>
              {PAYMENT_SOURCES.map(p => (
                <button type="button" key={p.v} onClick={() => setPaySource(p.v)}
                  style={{
                    padding: "5px 12px", fontSize: 11, cursor: "pointer", border: "1px solid",
                    borderColor: paySource === p.v ? "#1A1A1A" : "#EDEBE6",
                    background: paySource === p.v ? "#1A1A1A" : "transparent",
                    color: paySource === p.v ? "#FFFFFF" : "#A89070",
                    marginRight: -1, fontFamily: "inherit",
                  }}>{p.l}</button>
              ))}
            </div>
            {paySource === "accountable" && (
              <select style={{ ...inp, width: "auto", minWidth: 160, cursor: "pointer" }}
                value={accountableId} onChange={e => setAccountableId(e.target.value)}>
                <option value="">— кто платил —</option>
                {(accountables as any[]).map((a: any) => (
                  <option key={a.id} value={a.id}>{a.name} · на руках {new Intl.NumberFormat("ru-RU").format(a.balance)} ₽</option>
                ))}
              </select>
            )}
          </div>
          {paySource === "cash_fund" && (
            <div style={{ fontSize: 10, color: "#A89070", marginTop: 5 }}>Спишется из кассы наличных — остаток виден в Фондах.</div>
          )}
        </div>}

        {/* Трата по допработе не идёт в план-факт основной сметы: транспорт на
            доработку не должен занижать маржу заказа (ТЗ extra_works 01.08.2026). */}
        {extras.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={lbl}>ОТНОСИТСЯ К</div>
            <select style={{ ...inp, cursor: "pointer" }} value={extraId}
              onChange={e => setExtraId(e.target.value)}>
              <option value="">Смета заказа</option>
              {extras.map((x: any) => (
                <option key={x.id} value={x.id}>Доп: {x.title}</option>
              ))}
            </select>
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <div style={lbl}>ПОДРЯДЧИК / ПОСТАВЩИК</div>
          <PayeePicker value={masterId} onChange={setMasterId} placeholder="— не указан —"
            suggestName={expense?.supplier} />
        </div>

        {/* Похоже на дубль: уже есть трата с тем же поставщиком/суммой в ±3 дня */}
        {dupCandidate && (
          <div style={{ marginTop: 14, padding: "10px 12px", background: "#FFF4EE", borderLeft: "2px solid #8B3A3A" }}>
            <div style={{ fontSize: 11, color: "#8B3A3A", lineHeight: 1.5 }}>
              Похоже на дубль: «{dupCandidate.title}» на <span style={{ fontFamily: MONO }}>{dupCandidate.amount} ₽</span> от {dupCandidate.expense_date} уже внесён.
              {dupConfirmed ? " Нажми «Добавить» ещё раз, чтобы всё равно сохранить." : ""}
            </div>
          </div>
        )}

        {/* Подсказка про двойной счёт: тот же подрядчик уже висит обязательством по заказу */}
        {candidate && (
          <div style={{ marginTop: 14, padding: "10px 12px", background: "#FFF4EE", borderLeft: "2px solid #E8592A" }}>
            <div style={{ fontSize: 11, color: "#6B6355", lineHeight: 1.5 }}>
              По заказу есть обязательство «{candidate.name}» на{" "}
              <span style={{ fontFamily: MONO }}>{candidate.total} ₽</span>
              {candidate.paid > 0 && <> (оплачено <span style={{ fontFamily: MONO }}>{candidate.paid} ₽</span>)</>}.
              Это оплата по нему?
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, cursor: "pointer", fontSize: 11, color: "#1A1A1A" }}>
              <input type="checkbox" checked={creditorId === candidate.id}
                onChange={e => setCreditorId(e.target.checked ? candidate.id : null)} />
              Да — засчитать один раз, не задваивать факт
            </label>
          </div>
        )}

      </div>
    </Modal>
  );
}
