import { useEffect } from "react";
import { useBlocker } from "react-router-dom";

export function useNavigationGuard(isDirty: boolean) {
  const blocker = useBlocker(isDirty);

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  return blocker;
}

export function NavigationGuardModal({ blocker }: { blocker: ReturnType<typeof useBlocker> }) {
  if (blocker.state !== "blocked") return null;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => blocker.reset?.()}
    >
      <div
        style={{ background: "#FFF", width: 380, padding: "28px 32px", boxShadow: "0 8px 40px rgba(0,0,0,0.2)" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A", marginBottom: 8, letterSpacing: "-0.02em" }}>
          Несохранённые изменения
        </div>
        <div style={{ fontSize: 13, color: "#6B6355", marginBottom: 24, lineHeight: 1.6 }}>
          Если уйти сейчас, все незаписанные изменения будут потеряны.
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => blocker.proceed?.()}
            style={{ flex: 1, background: "#1A1A1A", color: "#FFF", border: "none", padding: "9px 0", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
          >
            Уйти без сохранения
          </button>
          <button
            onClick={() => blocker.reset?.()}
            style={{ flex: 1, background: "none", border: "1px solid #EDEBE6", padding: "9px 0", fontSize: 12, cursor: "pointer", fontFamily: "inherit", color: "#1A1A1A", fontWeight: 600 }}
          >
            Остаться
          </button>
        </div>
      </div>
    </div>
  );
}
