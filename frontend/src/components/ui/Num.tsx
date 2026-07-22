// Числовая гарнитура бренда — Space Grotesk (как на pbpb.club). Ставится на ячейки
// с суммами/датами; tabular-nums выстраивает колонки ровным столбиком. Кириллица
// внутри такой ячейки падает в Onest (следующий в стеке). Имя MONO сохранено, чтобы
// сотни существующих `fontFamily: MONO` продолжали значить «числовая гарнитура».
export const MONO = "'Space Grotesk', 'Onest', system-ui, sans-serif";

export const numStyle: React.CSSProperties = {
  fontFamily: MONO,
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "-0.01em",
};

// <Num>21 500 ₽</Num> — единое начертание для чисел/латиницы внутри текста.
export function Num({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <span style={{ ...numStyle, ...style }}>{children}</span>;
}
