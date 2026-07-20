import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Loading } from "../components/ui/Loading";
import { EmptyState } from "../components/ui/EmptyState";
import { MONO } from "../components/ui/Num";
import { ColumnFilter } from "../components/TableFilters";
import { ContractorDetail, STATUS_COLORS } from "../components/ContractorDetail";
import { mastersApi } from "../api";
import { MagnifyingGlass, CaretRight } from "@phosphor-icons/react";

const PAGE_SIZE = 15;

function fmt(n: number) {
  if (!n) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

function initials(name: string | undefined) {
  if (!name) return "—";
  const cleaned = (name || "").trim().replace(/["«»„"]/g, "").replace(/^(ООО|ИП|ЗАО|ОАО|ПАО)\s+/i, "");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (!parts.length) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const STATUS_LABELS: Record<string, string> = {
  favorite: "Постоянный", stable: "Стабильный", available: "Доступен", risk: "Риск",
};

export default function Contractors() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [page, setPage] = useState(0);

  const { data: masters = [], isLoading } = useQuery({ queryKey: ["masters"], queryFn: mastersApi.list });
  // Контрагенты, живущие только в вики фин-агента — read-only, не мигрируем.
  const { data: wikiOnly = [] } = useQuery({ queryKey: ["masters-wiki-only"], queryFn: mastersApi.wikiOnly });

  const rightOpen = !!id;
  const all = masters as any[];

  const uniqueRoles = [...new Set(all.map((m: any) => m.role).filter(Boolean))].sort() as string[];
  const filtered = all.filter((m: any) => {
    if (roleFilter && m.role !== roleFilter) return false;
    if (search) {
      const hay = `${m.name} ${m.specialization ?? ""} ${m.phone ?? ""}`.toLowerCase();
      if (!hay.includes(search.toLowerCase())) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const cols = rightOpen ? "32px 1fr 110px" : "32px 1.6fr 1.2fr 150px 110px 110px 90px";

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>

      {/* Список */}
      <div style={{
        flex: rightOpen ? "0 0 50%" : "1 1 0",
        display: "flex", flexDirection: "column", minWidth: 0,
        borderRight: rightOpen ? "1px solid #EDEBE6" : "none",
        transition: "flex 0.2s ease",
      }}>
        <div style={{ padding: "24px 28px 0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Подрядчики</div>
            <div style={{ position: "relative" }}>
              <MagnifyingGlass size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#A89070" }} />
              <input value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} placeholder="Имя, специализация..."
                style={{ paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6, border: "1px solid #EDEBE6", background: "transparent", fontSize: 12, color: "#1A1A1A", outline: "none", width: 200, borderRadius: 0 }} />
            </div>
          </div>
        </div>

        <div style={{ padding: "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: "#6B6355" }}>
          <span>{filtered.length} подрядчиков</span>
          {wikiOnly.length > 0 && (
            <span style={{ fontSize: 10, color: "#A89070" }}>+ {wikiOnly.length} только в вики фин-агента</span>
          )}
        </div>

        {/* Заголовки */}
        <div style={{ display: "grid", gridTemplateColumns: cols, gap: 12, padding: "8px 28px", borderBottom: "1px solid #EDEBE6", alignItems: "center" }}>
          <div />
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>ИМЯ</div>
          {!rightOpen && <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>СПЕЦИАЛИЗАЦИЯ</div>}
          {!rightOpen && <div><ColumnFilter label="РОЛЬ" options={uniqueRoles} value={roleFilter} onChange={v => { setRoleFilter(v); setPage(0); }} /></div>}
          {!rightOpen && <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>СХЕМА</div>}
          {!rightOpen && <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em", textAlign: "right" }}>ВЫПЛАЧЕНО</div>}
          <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em", textAlign: "right" }}>ДОЛГ</div>
        </div>

        {/* Строки */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {isLoading ? <Loading compact /> :
           pageItems.length === 0 ? <EmptyState compact title="Подрядчиков нет" /> :
           pageItems.map((m: any) => {
            const active = id === m.id;
            return (
              <div key={m.id} onClick={() => navigate(active ? "/contractors" : `/contractors/${m.id}`)}
                style={{
                  display: "grid", gridTemplateColumns: cols, gap: 12, padding: "10px 28px",
                  borderBottom: "1px solid #F7F5F1", cursor: "pointer", alignItems: "center",
                  background: active ? "#FFF8F5" : "transparent", transition: "background 0.1s",
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = "#FAF8F5"; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                <div style={{
                  width: 28, height: 28, borderRadius: "50%",
                  background: m.debt > 0 ? "#FFF0EC" : "#F2EFE9",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 700, color: m.debt > 0 ? "#8B3A3A" : "#1A1A1A",
                  textTransform: "uppercase", letterSpacing: "0.08em",
                }}>{initials(m.name)}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.name}
                  </div>
                  {m.status && (
                    <div style={{ fontSize: 9, color: STATUS_COLORS[m.status] || "#A89070", marginTop: 1 }}>
                      {STATUS_LABELS[m.status] || m.status}
                    </div>
                  )}
                </div>
                {!rightOpen && <div style={{ fontSize: 11, color: "#6B6355", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.specialization || "—"}</div>}
                {!rightOpen && <div style={{ fontSize: 11, color: "#A89070" }}>{m.role || "—"}</div>}
                {!rightOpen && <div style={{ fontSize: 10, color: m.pay_label ? "#1A1A1A" : "#C8C0B0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.pay_label || "—"}</div>}
                {!rightOpen && <div style={{ fontSize: 12, color: m.paid_total > 0 ? "#4A7C59" : "#C8C0B0", textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{m.paid_total > 0 ? fmt(m.paid_total) : "—"}</div>}
                <div style={{ fontSize: 12, fontWeight: 600, color: m.debt > 0 ? "#8B3A3A" : "#C8C0B0", textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                  {m.debt > 0 ? fmt(m.debt) : "—"}
                </div>
              </div>
            );
          })}

          {/* Только в вики фин-агента — read-only */}
          {!rightOpen && wikiOnly.length > 0 && (
            <div style={{ padding: "18px 28px 24px" }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>ТОЛЬКО В ВИКИ ФИН-АГЕНТА</div>
              <div style={{ fontSize: 10, color: "#C8C0B0", marginBottom: 10, lineHeight: 1.5 }}>
                Есть у фин-агента, но не заведены в картотеке. Переносить автоматически не стали — среди них бывают тёзки и дубли.
              </div>
              {(wikiOnly as any[]).map((w: any) => (
                <div key={w.contractor_id} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 12, padding: "7px 0", borderBottom: "1px solid #F2EFE9" }}>
                  <div style={{ fontSize: 12, color: "#6B6355" }}>{w.name}</div>
                  <div style={{ fontSize: 11, color: "#A89070", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.specialization || "—"}</div>
                  <div style={{ fontSize: 10, color: "#A89070", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.pay_label || "—"}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Пагинация */}
        {filtered.length > PAGE_SIZE && (
          <div style={{ padding: "8px 28px", borderTop: "1px solid #F7F5F1", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
            <div style={{ fontSize: 10, color: "#A89070" }}>
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} из {filtered.length}
            </div>
            <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
              {Array.from({ length: totalPages }, (_, i) => (
                <button key={i} onClick={() => setPage(i)}
                  style={{
                    minWidth: 20, height: 20, background: "none", border: "none", cursor: "pointer", fontSize: 10,
                    fontWeight: page === i ? 600 : 400, color: page === i ? "#1A1A1A" : "#A89070",
                    borderBottom: page === i ? "2px solid #E8592A" : "2px solid transparent", padding: "0 2px",
                  }}>{i + 1}</button>
              ))}
              <button onClick={() => setPage(p => Math.min(p + 1, totalPages - 1))} disabled={page >= totalPages - 1}
                style={{ background: "none", border: "none", cursor: page >= totalPages - 1 ? "default" : "pointer", color: page >= totalPages - 1 ? "#D0C8C0" : "#A89070", display: "flex", alignItems: "center", padding: "0 2px" }}>
                <CaretRight size={11} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Карточка */}
      {rightOpen && (
        <div style={{ flex: "0 0 50%", display: "flex", flexDirection: "column", animation: "slideIn 0.18s ease", minWidth: 0 }}>
          <ContractorDetail masterId={id!} onClose={() => navigate("/contractors")} />
        </div>
      )}

      <style>{`@keyframes slideIn { from { opacity: 0; transform: translateX(10px); } to { opacity: 1; transform: translateX(0); } }`}</style>
    </div>
  );
}
