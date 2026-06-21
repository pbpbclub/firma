// Вторая гарнитура — JetBrains Mono — только для чисел/денег/латиницы/дат/бейджей.
// Моноширинные цифры (tabular-nums) выстраивают колонки сумм ровным столбиком.
// Интерфейсный текст и кириллица остаются на system-ui.

export const MONO = "'JetBrains Mono', ui-monospace, monospace";

export const numStyle: React.CSSProperties = {
  fontFamily: MONO,
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "-0.01em",
};

// <Num>21 500 ₽</Num> — единое начертание для чисел/латиницы внутри текста.
export function Num({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <span style={{ ...numStyle, ...style }}>{children}</span>;
}
