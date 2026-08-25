// Разделы приложения — один список для сайдбара (десктоп) и нижней панели (телефон).
import {
  SquaresFour, FileText, TrendUp, Package, Calculator, CurrencyDollar, BookOpen,
  Vault, HandCoins, Receipt, Stack,
} from "@phosphor-icons/react";

export const NAV = [
  { to: "/", icon: SquaresFour, label: "Главная" },
  { to: "/orders", icon: FileText, label: "Заказы" },
  { to: "/finance", icon: TrendUp, label: "ДДС" },
  { to: "/zenmoney", icon: HandCoins, label: "Личные" },
  { to: "/expenses", icon: Receipt, label: "Разноска" },
  { to: "/general-expenses", icon: Stack, label: "Запас" },
  { to: "/debtors", icon: CurrencyDollar, label: "Обязательства" },
  { to: "/wiki", icon: BookOpen, label: "Вики" },
  { to: "/catalog", icon: Package, label: "Каталог" },
  { to: "/taxes", icon: Calculator, label: "Налоги" },
  { to: "/funds", icon: Vault, label: "Фонды" },
];

// Нижняя панель телефона: четыре раздела сценария «посмотреть → внести», остальное — «Ещё».
export const MOBILE_TABS = ["/", "/orders", "/expenses", "/finance"];
