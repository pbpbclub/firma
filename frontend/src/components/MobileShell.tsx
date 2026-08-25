/**
 * Каркас телефона: без бежевой рамки и сайдбара, нижняя таб-панель.
 *
 * Сайдбар на 390px не живёт (60–200px из 390), а бургер — два тапа на каждый
 * переход при сценарии «посмотреть → внести». Нижняя панель — один тап в зоне
 * большого пальца, iOS-стандарт. Цепочка высот та же, что на десктопе
 * (100dvh → main flex:1 overflow:auto), поэтому экраны с внутренними скроллерами
 * (заказы, ДДС, обязательства, разноска) работают без правок: шапка и вкладки
 * закреплены, крутится список.
 */
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { DotsThreeOutline, SignOut, X } from "@phosphor-icons/react";
import { NAV, MOBILE_TABS } from "./nav";
import { getUser, logout } from "../auth";

const ACTIVE = "#E8592A", IDLE = "#A89070";

export function MobileShell({ children }: { children: ReactNode }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();
  const user = getUser();
  useEffect(() => { setMoreOpen(false); }, [location.pathname]);   // ушли по ссылке — лист закрыт

  const tabs = MOBILE_TABS.map(to => NAV.find(n => n.to === to)!);
  const rest = NAV.filter(n => !MOBILE_TABS.includes(n.to));
  const moreActive = rest.some(n => location.pathname.startsWith(n.to)) || location.pathname === "/admin";

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "#FFFFFF" }}>
      <main style={{ flex: 1, overflow: "auto", minWidth: 0, WebkitOverflowScrolling: "touch" }}>
        {children}
      </main>

      <nav style={{
        flexShrink: 0, borderTop: "1px solid #EDEBE6", background: "#FFFFFF",
        paddingBottom: "env(safe-area-inset-bottom)",
        display: "grid", gridTemplateColumns: "repeat(5, 1fr)",
      }}>
        {tabs.map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to} end={to === "/"}
            style={({ isActive }) => ({
              height: 56, display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", gap: 3, textDecoration: "none",
              color: isActive ? ACTIVE : IDLE, background: isActive ? "#FFF3EF" : "transparent",
              fontSize: 10, fontWeight: isActive ? 600 : 500, letterSpacing: "0.02em",
            })}>
            <Icon size={22} />
            {label}
          </NavLink>
        ))}
        <button type="button" onClick={() => setMoreOpen(v => !v)}
          style={{
            height: 56, display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", gap: 3, background: moreActive ? "#FFF3EF" : "none",
            border: "none", color: moreActive || moreOpen ? ACTIVE : IDLE, fontFamily: "inherit",
            fontSize: 10, fontWeight: moreActive ? 600 : 500, letterSpacing: "0.02em", cursor: "pointer",
          }}>
          <DotsThreeOutline size={22} weight={moreOpen ? "fill" : "regular"} />
          Ещё
        </button>
      </nav>

      {moreOpen && (
        <div onClick={() => setMoreOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 900, background: "rgba(0,0,0,0.4)",
                   display: "flex", alignItems: "flex-end" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: "#FFFFFF", width: "100%", maxHeight: "80dvh", overflowY: "auto",
                     paddingBottom: "calc(env(safe-area-inset-bottom) + 8px)",
                     boxShadow: "0 -8px 40px rgba(0,0,0,0.16)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "14px 16px", borderBottom: "1px solid #EDEBE6" }}>
              <span style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em" }}>РАЗДЕЛЫ</span>
              <button type="button" onClick={() => setMoreOpen(false)}
                style={{ background: "none", border: "none", color: "#A89070", padding: 8, display: "flex", cursor: "pointer" }}>
                <X size={18} />
              </button>
            </div>
            {rest.map(({ to, icon: Icon, label }) => (
              <NavLink key={to} to={to}
                style={({ isActive }) => ({
                  display: "flex", alignItems: "center", gap: 14, height: 48, padding: "0 16px",
                  textDecoration: "none", fontSize: 15,
                  color: isActive ? ACTIVE : "#1A1A1A", background: isActive ? "#FFF3EF" : "transparent",
                  fontWeight: isActive ? 600 : 400, borderBottom: "1px solid #F2EFE9",
                })}>
                <Icon size={20} style={{ color: "inherit" }} />
                {label}
              </NavLink>
            ))}
            <NavLink to="/admin"
              style={({ isActive }) => ({
                display: "flex", alignItems: "center", gap: 14, height: 48, padding: "0 16px",
                textDecoration: "none", fontSize: 15, color: isActive ? ACTIVE : "#1A1A1A",
                background: isActive ? "#FFF3EF" : "transparent", borderBottom: "1px solid #F2EFE9",
              })}>
              <span style={{ width: 20, height: 20, background: "#E8E4DA", display: "inline-flex",
                             alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 600, color: "#6B6355" }}>
                {user?.name ? user.name.slice(0, 2).toUpperCase() : "YN"}
              </span>
              Настройки{user?.name ? <span style={{ color: "#A89070", fontSize: 12 }}>· {user.name}</span> : null}
            </NavLink>
            <button type="button" onClick={logout}
              style={{ display: "flex", alignItems: "center", gap: 14, height: 48, padding: "0 16px", width: "100%",
                       background: "none", border: "none", fontFamily: "inherit", fontSize: 15, color: "#8B3A3A", cursor: "pointer" }}>
              <SignOut size={20} /> Выйти
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
