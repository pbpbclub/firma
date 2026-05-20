import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  SquaresFour,
  FileText,
  TrendUp,
  Package,
  Calculator,
  Users,
  User,
  SignOut,
  List,
} from "@phosphor-icons/react";
import { getUser, logout } from "../auth";

const nav = [
  { to: "/", icon: SquaresFour, label: "Главная" },
  { to: "/orders", icon: FileText, label: "Заказы" },
  { to: "/finance", icon: TrendUp, label: "ДДС" },
  { to: "/debtors", icon: Users, label: "Долги" },
  { to: "/customers", icon: User, label: "Клиенты" },
  { to: "/catalog", icon: Package, label: "Каталог" },
  { to: "/taxes", icon: Calculator, label: "Налоги" },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const user = getUser();
  const [expanded, setExpanded] = useState(false);
  const initials = user?.name ? user.name.slice(0, 2).toUpperCase() : "YN";
  const W = expanded ? 200 : 60;

  return (
    /* Outer beige frame */
    <div style={{
      background: "#E8E4DA",
      height: "100vh",
      padding: "36px 56px",
      boxSizing: "border-box",
      display: "flex",
    }}>
      {/* White container — everything inside */}
      <div style={{
        flex: 1,
        background: "#FFFFFF",
        display: "flex",
        overflow: "hidden",
        minHeight: 0,
        boxShadow: "0 2px 24px rgba(0,0,0,0.06)",
      }}>
        {/* Sidebar */}
        <aside style={{
          width: W,
          minWidth: W,
          borderRight: "1px solid #EDEBE6",
          display: "flex",
          flexDirection: "column",
          transition: "width 0.2s ease, min-width 0.2s ease",
          overflow: "hidden",
        }}>
          {/* Hamburger */}
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{
              height: 56,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "none",
              border: "none",
              borderBottom: "1px solid #EDEBE6",
              cursor: "pointer",
              color: "#A89070",
              flexShrink: 0,
              transition: "color 0.12s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#1A1A1A")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#A89070")}
          >
            <List size={18} />
          </button>

          {/* Nav */}
          <nav style={{ flex: 1, paddingTop: 8, paddingBottom: 8 }}>
            {nav.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                title={!expanded ? label : undefined}
                style={({ isActive }) => ({
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  height: 44,
                  paddingLeft: expanded ? 20 : 0,
                  justifyContent: expanded ? "flex-start" : "center",
                  color: isActive ? "#E8592A" : "#A89070",
                  background: isActive ? "#FFF3EF" : "transparent",
                  textDecoration: "none",
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  transition: "all 0.12s",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                })}
                onMouseEnter={(e) => {
                  const el = e.currentTarget as HTMLElement;
                  if (el.getAttribute("aria-current") !== "page") {
                    el.style.color = "#1A1A1A";
                    el.style.background = "#FAF8F5";
                  }
                }}
                onMouseLeave={(e) => {
                  const el = e.currentTarget as HTMLElement;
                  if (el.getAttribute("aria-current") !== "page") {
                    el.style.color = "#A89070";
                    el.style.background = "transparent";
                  }
                }}
              >
                <Icon size={18} style={{ flexShrink: 0 }} />
                {expanded && label}
              </NavLink>
            ))}
          </nav>

          {/* Bottom: avatar + logout */}
          <div style={{
            borderTop: "1px solid #EDEBE6",
            padding: "12px 0",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}>
            <div style={{
              width: 32, height: 32,
              background: "#E8E4DA",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
            }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#6B6355" }}>{initials}</span>
            </div>
            {expanded && (
              <div style={{ fontSize: 11, color: "#1A1A1A", fontWeight: 500, whiteSpace: "nowrap" }}>
                {user?.name}
              </div>
            )}
            <button
              onClick={logout}
              title="Выйти"
              style={{
                width: 32, height: 32,
                background: "none", border: "none",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#C8C0B0", cursor: "pointer",
                transition: "color 0.12s",
                flexShrink: 0,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#E8592A")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#C8C0B0")}
            >
              <SignOut size={15} />
            </button>
          </div>
        </aside>

        {/* Main content — on white surface */}
        <main style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
          {children}
        </main>
      </div>
    </div>
  );
}
