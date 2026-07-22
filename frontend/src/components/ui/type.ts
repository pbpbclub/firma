// Единая шкала типографики. Текст — Onest (наследуется от body), числа — Space
// Grotesk (MONO). Раньше размеры/веса жили инлайном вразнобой по страницам; здесь
// один источник, который катится по всему приложению.
import type { CSSProperties } from "react";
import { MONO } from "./Num";

// Полярность денег — общий цветовой словарь зон (нам должны / мы должны).
export const POLARITY = {
  in:      { key: "in",      color: "#4A7C59", tint: "#F2FDF5", rail: "#4A7C59" }, // деньги входят
  out:     { key: "out",     color: "#8B3A3A", tint: "#FBF3F2", rail: "#8B3A3A" }, // деньги выходят
  neutral: { key: "neutral", color: "#6B6355", tint: "#FAF8F5", rail: "#EDEBE6" },
} as const;

export const T = {
  // Крупная сумма-герой (леджерный Space Grotesk)
  hero: {
    fontFamily: MONO, fontVariantNumeric: "tabular-nums",
    fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05,
  } as CSSProperties,
  // Заголовок страницы (Onest)
  pageTitle: {
    fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", color: "#1A1A1A",
  } as CSSProperties,
  // Заголовок секции/карточки
  title: {
    fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em", color: "#1A1A1A",
  } as CSSProperties,
  // CAPS-метка раздела
  sectionLabel: {
    fontSize: 11, fontWeight: 600, color: "#A89070", letterSpacing: "0.08em", textTransform: "uppercase",
  } as CSSProperties,
  // Метка колонки таблицы
  colLabel: {
    fontSize: 10, fontWeight: 600, color: "#A89070", letterSpacing: "0.06em", textTransform: "uppercase",
  } as CSSProperties,
  body: { fontSize: 13, color: "#1A1A1A" } as CSSProperties,
  bodyMuted: { fontSize: 11, color: "#A89070" } as CSSProperties,
  // Числовая ячейка
  num: {
    fontFamily: MONO, fontVariantNumeric: "tabular-nums", fontSize: 13,
  } as CSSProperties,
  numBig: {
    fontFamily: MONO, fontVariantNumeric: "tabular-nums", fontSize: 15, fontWeight: 700,
  } as CSSProperties,
} as const;
