import { fmtMoney as fmt } from "../components/ui/format";
import { QueryError } from "../components/ui/QueryError";
import { SkeletonRows } from "../components/ui/Loading";
import { useQuery } from "@tanstack/react-query";
import { financeApi, taxApi, ordersApi, reportsApi, estimatesApi, ledgerApi } from "../api";
import { CardButton } from "../components/CardButton";
import { useIsMobile } from "../components/ui/responsive";
import { WeekPanel } from "../components/dashboard/WeekPanel";
import { HeroPanel } from "../components/dashboard/HeroPanel";
import { LowerPanel } from "../components/dashboard/LowerPanel";


// Главная висит на мониторе днём — цифры обновляются сами, без F5.
const LIVE = { refetchInterval: 5 * 60_000 };

export default function Dashboard() {
  const freeCash = useQuery({ queryKey: ["free-cash"], queryFn: financeApi.freeCash, ...LIVE });
  const balance = useQuery({ queryKey: ["balance"], queryFn: financeApi.balance, ...LIVE });
  const taxes = useQuery({ queryKey: ["taxes"], queryFn: taxApi.summary, ...LIVE });
  const debtors = useQuery({ queryKey: ["debtors"], queryFn: financeApi.debtors, ...LIVE });
  const dds = useQuery({ queryKey: ["dds-summary"], queryFn: financeApi.summary, ...LIVE });
  const orders = useQuery({
    queryKey: ["orders-active"],
    queryFn: () => ordersApi.list({ status: "in_production" }),
    ...LIVE,
  });
  // Проектные работы — отдельной строкой: это свой вид деятельности, а не часть pbpb
  // (решение Юры 25.09.2026). Ключ под префиксом finance-by-brand — инвалидация из
  // карточки бренда задевает и его.
  const byBrand = useQuery({ queryKey: ["finance-by-brand", "split-design"], queryFn: () => financeApi.byBrand(true) });
  // «Что делать» — бэкенд считал это давно, а лежало оно за двумя кликами внутри Заказов.
  const silent = useQuery({ queryKey: ["orders-silent"], queryFn: ordersApi.silent, ...LIVE });
  const readiness = useQuery({ queryKey: ["estimates-readiness"], queryFn: estimatesApi.readiness });
  const pfSummary = useQuery({ queryKey: ["orders-plan-fact-summary", "active"],
                               queryFn: () => ordersApi.planFactSummary("active") });
  const creditors = useQuery({ queryKey: ["creditors"], queryFn: () => financeApi.creditors(), ...LIVE });
  // «Мы должны» — сальдо лицевых счетов, одно число на человека (ТЗ 03.09.2026).
  const ledger = useQuery({ queryKey: ["ledger-balances"], queryFn: () => ledgerApi.balances() });
  // A8: накладные месяца (аренда, расходники) и как они ложатся на заказы в работе
  const overhead = useQuery({ queryKey: ["overhead-summary"], queryFn: ordersApi.overheadSummary });

  // Любой упавший денежный запрос → баннер: раньше блоки просто исчезали
  // по одному и дашборд выглядел как «всё по нулям».
  const failed = [freeCash, balance, taxes, debtors, dds, orders].find(q => q.isError);

  const activeOrders: any[] = orders.data ?? [];


  // Телефон: гаттер 16, подписи секций («ЭТОТ МЕСЯЦ», «ПО БРЕНДАМ») стопкой над
  // содержимым вместо колонки width:80 + gap:48 — из 358px они съедали 128.
  const isMobile = useIsMobile();

  // ── Что горит: цифры уже посчитаны бэком, здесь только собраны в строку ──
  const rs = readiness.data?.summary ?? {};
  const holes = (rs.orders_with_duplicates ?? 0) + (rs.invoice_drift ?? 0)
              + (rs.transit_as_bank ?? 0) + (rs.tx_overspread ?? 0) + (rs.stub_items ?? 0);
  const overspent = ((pfSummary.data?.orders ?? []) as any[]).filter(o => o.overspent).length;
  const todo = [
    { label: "Молчат", value: silent.data?.total ?? 0,
      hint: (silent.data?.archive_candidates ?? 0) > 0 ? `${silent.data.archive_candidates} — кандидаты в архив` : "просчёты без движения",
      to: "/orders?mode=silent", tone: "#E8592A" },
    { label: "Дыры в сметах", value: holes,
      hint: "дубли, расхождение со счётом, заглушки", to: "/orders?mode=ready", tone: "#8B3A3A" },
    { label: "Перерасход", value: overspent,
      hint: "факт выше плана сметы", to: "/orders?mode=summary", tone: "#8B3A3A" },
    { label: "Можно закрыть", value: creditors.data?.closable_count ?? 0,
      hint: creditors.data?.closable_total ? `обязательств на ${fmt(creditors.data.closable_total)}` : "обязательств по завершённым",
      to: "/debtors", tone: "#4A7C59" },
  ].filter(t => t.value > 0);

  // Дашборд грузится восемью параллельными запросами, и каждый блок появлялся
  // сам по себе — экран прыгал 5–8 раз. Пока не пришли денежные ответы, держим
  // скелет: SkeletonRows был написан и не вызывался ни разу.
  const coreLoading = [freeCash, balance, taxes, debtors, dds, orders].some(q => q.isLoading);

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Любой упавший денежный запрос → баннер: раньше блоки просто исчезали
          по одному, и дашборд выглядел как «всё по нулям» */}
      {failed && <QueryError error={(failed as any).error} what="часть сводки" />}

      {/* Header */}
      <div style={{ padding: isMobile ? "16px 16px 14px" : "24px 28px 20px", borderBottom: "1px solid #EDEBE6" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: isMobile ? "wrap" : undefined }}>
          <div style={{ fontSize: isMobile ? 22 : 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>
            {new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}
            {freeCash.dataUpdatedAt > 0 && (
              <span style={{ fontSize: 11, fontWeight: 400, color: "#A89070", letterSpacing: 0, marginLeft: 14 }}>
                обновлено {new Date(freeCash.dataUpdatedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
          </div>
          {/* Тот же срез, что финагент присылает в Telegram: деньги месяца, заказы, долги. */}
          <CardButton label="Срез за месяц"
            filename={`Срез — ${new Date().toLocaleDateString("ru-RU", { month: "long", year: "numeric" })}.pdf`}
            fetcher={() => reportsApi.monthCard()} />
        </div>
      </div>

      {coreLoading && <SkeletonRows rows={9} cols={4} padding="18px 28px" />}

      {/* Шапка: свободные деньги, деньги по месяцам, пульс, плитки-двери */}
      {!coreLoading && (
        <HeroPanel freeCash={freeCash.data} balance={balance.data} taxes={taxes.data} creditors={creditors.data}
                   debtors={debtors.data} dds={dds.data} orders={activeOrders} isMobile={isMobile} />
      )}

      {/* Неделя — блоки недельного отчёта фин-агента: спидометры маржи, план/факт,
          «Молчат» с порогами, приход по неделям и кварталам */}
      <WeekPanel silent={silent.data} isMobile={isMobile} />

      {/* Что делать, производство, бренды, долги, накладные — в стиле шапки */}
      {!coreLoading && (
        <LowerPanel todo={todo} byBrand={byBrand.data ?? []} debtors={debtors.data} ledger={ledger.data}
                    creditors={creditors.data} overhead={overhead.data} orders={activeOrders} isMobile={isMobile} />
      )}
    </div>
  );
}
