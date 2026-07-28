// Доменные константы, общие для страниц. Раньше жили копиями в
// OrdersV2/OrderDetail/ui/Selects — при изменении статусов/брендов править только здесь.

export const BRANDS: { value: string; color: string }[] = [
  { value: "MeRA",    color: "#2E6DA4" },
  { value: "pbpb",    color: "#7B4F9E" },
  { value: "Транзит", color: "#3D8C6B" },
];
export const BRAND_COLOR: Record<string, string> = Object.fromEntries(BRANDS.map(b => [b.value, b.color]));

export const ORDER_STATUSES = [
  { value: "draft",         label: "Черновик",       color: "#A89070" },
  { value: "estimate",      label: "Смета",          color: "#E8592A" },
  { value: "project",       label: "Проект",         color: "#E8592A" },
  { value: "in_production", label: "В производстве", color: "#1A1A1A" },
  // Счёт выставлен, работа не началась — заказчик тянет. Ставится только вручную.
  { value: "awaiting_payment", label: "Ждёт оплаты", color: "#B8860B" },
  { value: "completed",     label: "Завершён",       color: "#4A7C59" },
  { value: "cancelled",     label: "Отменён",        color: "#8B3A3A" },
];
export const ORDER_STATUS_MAP: Record<string, { label: string; color: string }> =
  Object.fromEntries(ORDER_STATUSES.map(s => [s.value, { label: s.label, color: s.color }]));

// Статусы сметы (у superseded раньше вовсе не было подписи в карточке заказа).
export const ESTIMATE_STATUS: Record<string, { label: string; color: string }> = {
  draft:      { label: "Черновик",    color: "#A89070" },
  approved:   { label: "Согласована", color: "#4A7C59" },
  superseded: { label: "Заменена",    color: "#6B6355" },
};

// Откуда взят план заказа (orders.plan_source): по draft-смете числа ещё не
// согласованы с клиентом — UI обязан это помечать.
export const PLAN_SOURCE_LABEL: Record<string, string> = {
  approved: "по утверждённой смете",
  draft: "по черновику сметы",
  manual: "без сметы",
};
