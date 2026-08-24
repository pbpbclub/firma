/**
 * Поле для денег.
 *
 * Раньше суммы вводились через `<input type="number">` в ~30 местах, и это молча
 * ломалось на самом частом действии: скопировал из банка или накладной «12 500,00 ₽»,
 * вставил — браузер отбрасывает всю строку целиком, поле остаётся ПУСТЫМ, ошибки нет.
 * Плюс запятая вместо точки вела себя по-разному в разных локалях, а разделителей
 * тысяч при вводе не было вовсе: 250000 набиралось вслепую.
 *
 * Здесь текст + inputMode="decimal": принимаем пробелы, неразрывные пробелы, ₽ и
 * запятую. Пока поле в фокусе — показываем как набрано; по блюру нормализуем и
 * форматируем с разделителями, чтобы число читалось глазами.
 *
 * Наружу отдаём строку (как и прежние поля), парсит вызывающий — либо через
 * parseMoney() отсюда.
 */
import { useState } from "react";
import { MONO } from "./Num";

/** «12 500,00 ₽» → 12500.5. Пусто/мусор → NaN (вызывающий решает, что с этим делать). */
export function parseMoney(raw: string): number {
  const cleaned = (raw ?? "")
    .replace(/[\s  ]/g, "")   // пробелы, в т.ч. неразрывные из буфера
    .replace(/[₽]/g, "")
    .replace(",", ".");
  return cleaned === "" ? NaN : parseFloat(cleaned);
}

/** Число к показу с разделителями: 12500.5 → «12 500,5». */
function formatMoney(raw: string): string {
  const n = parseMoney(raw);
  if (!Number.isFinite(n)) return raw;
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
}

export function MoneyInput({ value, onChange, placeholder = "0", autoFocus, style, disabled }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  style?: React.CSSProperties;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      value={focused ? value : (value ? formatMoney(value) : "")}
      onChange={e => onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        // Нормализуем один раз, на выходе: «12 500,00 ₽» → «12500.5». Дальше форма
        // работает с обычным числом и parseFloat не спотыкается.
        const n = parseMoney(value);
        if (Number.isFinite(n)) onChange(String(n));
      }}
      placeholder={placeholder}
      autoFocus={autoFocus}
      disabled={disabled}
      inputMode="decimal"
      style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums", textAlign: "right", ...style }}
    />
  );
}
