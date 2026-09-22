// Разделы приложения — один список для сайдбара (десктоп) и нижней панели (телефон).
import {
  SquaresFour, FileText, TrendUp, Package, Calculator, CurrencyDollar, BookOpen,
  Vault, HandCoins, Receipt, Stack, Cpu, Globe,
} from "@phosphor-icons/react";

export type NavItem = { to: string; icon: any; label: string; ownerOnly?: boolean };

export const NAV: NavItem[] = [
  { to: "/", icon: SquaresFour, label: "Главная" },
  { to: "/orders", icon: FileText, label: "Заказы" },
  { to: "/machine-time", icon: Cpu, label: "Машинное время" },
  { to: "/finance", icon: TrendUp, label: "ДДС" },
  { to: "/zenmoney", icon: HandCoins, label: "Личные" },
  // Личный заграничный контур: пункт видит только владелец (privacy.py).
  // Это удобство, не защита — данные закрыты на сервере, а не скрытием ссылки.
  { to: "/region/ge", icon: Globe, label: "Грузия", ownerOnly: true },
  { to: "/expenses", icon: Receipt, label: "Разноска" },
  { to: "/general-expenses", icon: Stack, label: "Запас" },
  { to: "/debtors", icon: CurrencyDollar, label: "Обязательства" },
  { to: "/wiki", icon: BookOpen, label: "Вики" },
  { to: "/catalog", icon: Package, label: "Каталог" },
  { to: "/taxes", icon: Calculator, label: "Налоги" },
  { to: "/funds", icon: Vault, label: "Фонды" },
];

// Разделы, доступные пользователю: ownerOnly отсекается флагом из /auth/me.
export function navFor(user?: { is_owner?: boolean } | null): NavItem[] {
  return NAV.filter(n => !n.ownerOnly || !!user?.is_owner);
}

// Нижняя панель телефона: четыре раздела сценария «посмотреть → внести», остальное — «Ещё».
export const MOBILE_TABS = ["/", "/orders", "/expenses", "/finance"];
