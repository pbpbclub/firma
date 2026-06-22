// Единое состояние загрузки.
export function Loading({ text = "Загружаем…", compact }: { text?: string; compact?: boolean }) {
  return (
    <div style={{ padding: compact ? "28px 20px" : "48px 24px", textAlign: "center", color: "#A89070", fontSize: 12 }}>
      {text}
    </div>
  );
}

// Скелетон строк таблицы — плавная загрузка вместо прыжка текста.
export function SkeletonRows({ rows = 6, cols = 4, padding = "11px 28px" }: {
  rows?: number; cols?: number; padding?: string;
}) {
  return (
    <div style={{ animation: "fpulse 1.2s ease-in-out infinite" }}>
      <style>{`@keyframes fpulse { 0%,100% { opacity: .5 } 50% { opacity: .85 } }`}</style>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: "flex", gap: 24, padding, borderBottom: "1px solid #F2EFE9" }}>
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} style={{
              height: 10, background: "#EDEBE6",
              flex: c === 0 ? 2 : 1, maxWidth: c === 0 ? 220 : 120,
            }} />
          ))}
        </div>
      ))}
    </div>
  );
}
