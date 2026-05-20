import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { MagnifyingGlass, DotsThree, Plus, Files, CaretRight } from "@phosphor-icons/react";
import { customersApi } from "../api";

function initials(name: string | undefined) {
  if (!name) return "—";
  const cleaned = name.trim().replace(/["«»„"]/g, "").replace(/^(ООО|ИП|ЗАО|ОАО|ПАО)\s+/i, "");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function fmtPhone(phone: string | undefined) {
  if (!phone) return "—";
  return phone;
}

function fmt(n: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

const PAGE_SIZE = 12;

function IconBtn({ onClick, children, orange }: { onClick?: () => void; children: React.ReactNode; orange?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 28, height: 28,
        background: orange ? "#E8592A" : "#F2EFE9",
        border: "none",
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: orange ? "#FFFFFF" : "#6B6355",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

export default function Customers() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [page, setPage] = useState(0);

  const { data: customers = [], isLoading } = useQuery({
    queryKey: ["customers", search],
    queryFn: () => customersApi.list(search),
  });

  const { data: detail } = useQuery({
    queryKey: ["customer", id],
    queryFn: () => customersApi.get(id!),
    enabled: !!id,
  });

  useEffect(() => {
    if (!id) return;
  }, [id]);

  const customer = detail?.customer;
  const summary = detail?.transaction_summary;

  const allCustomers = customers as any[];
  const totalCount = allCustomers.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageCustomers = allCustomers.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const cols = id ? "48px 2fr 110px 120px 40px" : "48px 2.3fr 100px 120px 120px 40px";

  function renderPageNums() {
    const pages: (number | "…")[] = [];
    if (totalPages <= 5) {
      for (let i = 0; i < totalPages; i++) pages.push(i);
    } else {
      pages.push(0, 1, 2);
      if (page > 3) pages.push("…");
      if (page > 2 && page < totalPages - 2) pages.push(page);
      if (page < totalPages - 3) pages.push("…");
      pages.push(totalPages - 1);
    }
    return [...new Set(pages)].map((p, i) =>
      p === "…" ? (
        <span key={`e${i}`} style={{ fontSize: 10, color: "#A89070", padding: "0 2px" }}>…</span>
      ) : (
        <button
          key={p}
          onClick={() => setPage(p as number)}
          style={{
            minWidth: 20, height: 20,
            background: "none", border: "none", cursor: "pointer",
            fontSize: 10,
            fontWeight: page === p ? 600 : 400,
            color: page === p ? "#1A1A1A" : "#A89070",
            borderBottom: page === p ? "2px solid #E8592A" : "2px solid transparent",
            padding: "0 2px",
          }}
        >
          {(p as number) + 1}
        </button>
      )
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* Left: list panel */}
      <div style={{
        flex: id ? "0 0 56%" : "1 1 0",
        display: "flex", flexDirection: "column", minWidth: 0,
        borderRight: id ? "1px solid #EDEBE6" : "none",
        transition: "flex 0.2s ease",
      }}>
        <div style={{ padding: "24px 28px 0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>
              Клиенты
            </div>
            {searchOpen ? (
              <div style={{ position: "relative" }}>
                <MagnifyingGlass size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#A89070" }} />
                <input
                  autoFocus
                  style={{
                    paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6,
                    border: "1px solid #EDEBE6",
                    background: "transparent",
                    fontSize: 12, color: "#1A1A1A",
                    outline: "none", width: 200,
                    borderRadius: 0,
                  }}
                  placeholder="Поиск клиента..."
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                  onKeyDown={(e) => { if (e.key === "Escape") { setSearchOpen(false); setSearch(""); setPage(0); } }}
                />
              </div>
            ) : (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <IconBtn onClick={() => setSearchOpen(true)}><MagnifyingGlass size={14} /></IconBtn>
                <IconBtn><Files size={14} /></IconBtn>
                <IconBtn orange><Plus size={14} /></IconBtn>
              </div>
            )}
          </div>
        </div>

        {/* Column headers */}
        <div style={{ display: "grid", gridTemplateColumns: cols, padding: "10px 28px", borderBottom: "1px solid #F7F5F1" }}>
          {["", "Контрагент", "ИНН", "Телефон", ...(id ? [] : ["Fin агент"]), ""].map((h, i) => (
            <div key={i} style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>{h}</div>
          ))}
        </div>

        {/* Rows */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {isLoading ? (
            <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 12 }}>Загружаем...</div>
          ) : pageCustomers.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 12 }}>Клиентов не найдено</div>
          ) : (
            pageCustomers.map((c: any) => {
              const isActive = id === c.id;
              return (
                <div
                  key={c.id}
                  onClick={() => navigate(isActive ? "/customers" : `/customers/${c.id}`)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: cols,
                    padding: "12px 28px",
                    borderBottom: "1px solid #F7F5F1",
                    cursor: "pointer",
                    background: isActive ? "#E8592A" : "transparent",
                    alignItems: "center",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#FAF8F5"; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                >
                  <div style={{
                    width: 28, height: 28,
                    borderRadius: "50%",
                    background: isActive ? "rgba(255,255,255,0.25)" : "#F2EFE9",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, fontWeight: 700,
                    color: isActive ? "#FFFFFF" : "#1A1A1A",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                  }}>
                    {initials(c.name)}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: isActive ? "#FFFFFF" : "#1A1A1A", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.name}
                  </div>
                  <div style={{ fontSize: 11, color: isActive ? "rgba(255,255,255,0.7)" : "#6B6355" }}>{c.inn || "—"}</div>
                  <div style={{ fontSize: 11, color: isActive ? "rgba(255,255,255,0.7)" : "#6B6355" }}>{fmtPhone(c.phone)}</div>
                  {!id && (
                    <div style={{ fontSize: 11, color: isActive ? "rgba(255,255,255,0.7)" : (c.finagent_ref ? "#1A1A1A" : "#C8C0B0") }}>
                      {c.finagent_ref || "—"}
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <DotsThree size={14} style={{ color: isActive ? "rgba(255,255,255,0.5)" : "#C8C0B0" }} />
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer with pagination */}
        <div style={{
          padding: "8px 28px",
          borderTop: "1px solid #F7F5F1",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 10, color: "#A89070" }}>
            {totalCount > 0
              ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, totalCount)} из ${totalCount}`
              : "0 клиентов"
            }
          </div>
          <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
            {renderPageNums()}
            <button
              onClick={() => setPage(p => Math.min(p + 1, totalPages - 1))}
              disabled={page >= totalPages - 1}
              style={{
                background: "none", border: "none", cursor: page >= totalPages - 1 ? "default" : "pointer",
                color: page >= totalPages - 1 ? "#D0C8C0" : "#A89070",
                display: "flex", alignItems: "center", padding: "0 2px",
              }}
            >
              <CaretRight size={11} />
            </button>
          </div>
        </div>
      </div>

      {/* Right: detail panel */}
      {id && customer && (
        <div style={{ flex: "0 0 44%", display: "flex", flexDirection: "column", animation: "slideIn 0.18s ease", minWidth: 0 }}>
          {/* Header */}
          <div style={{
            padding: "24px 24px 18px",
            borderBottom: "1px solid #EDEBE6",
            display: "flex", justifyContent: "space-between", alignItems: "flex-start",
          }}>
            <div>
              <div style={{ fontSize: 24, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em", maxWidth: 300 }}>
                {customer.name}
              </div>
              {customer.full_name && (
                <div style={{ fontSize: 11, color: "#A89070", marginTop: 6 }}>{customer.full_name}</div>
              )}
            </div>
            <button
              onClick={() => navigate("/customers")}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#C8C0B0", padding: 4, marginTop: -2 }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#1A1A1A")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#C8C0B0")}
            >
              <DotsThree size={20} />
            </button>
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflow: "auto", padding: "24px 24px 20px" }}>

            {/* Summary stats */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 16, textTransform: "uppercase" }}>Сводка</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "16px 32px" }}>
                {[
                  { label: "Заказов",    value: String(detail?.orders?.length ?? 0) },
                  { label: "Транзакций", value: String(summary?.count ?? 0) },
                  { label: "Доход",      value: summary ? fmt(summary.income) : "—" },
                  { label: "Расход",     value: summary ? fmt(summary.expense) : "—" },
                ].map((item) => (
                  <div key={item.label}>
                    <div style={{ fontSize: 10, color: "#A89070", marginBottom: 4 }}>{item.label}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#1A1A1A" }}>{item.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Contacts */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 14, textTransform: "uppercase" }}>Контакты</div>
              {[
                { label: "ИНН",     value: customer.inn || "—" },
                { label: "Телефон", value: customer.phone || "—" },
                { label: "Email",   value: customer.email || "—" },
                { label: "Контакт", value: customer.contact || "—" },
              ].map((item) => (
                <div key={item.label} style={{ display: "flex", justifyContent: "space-between", paddingBottom: 10, marginBottom: 10, borderBottom: "1px solid #F2EFE9" }}>
                  <div style={{ fontSize: 10, color: "#A89070" }}>{item.label}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>{item.value}</div>
                </div>
              ))}
            </div>

            {/* References */}
            {(customer.wiki_ref || customer.finagent_ref) && (
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 14, textTransform: "uppercase" }}>Ссылки</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 24px" }}>
                  {[
                    { label: "Wiki",      value: customer.wiki_ref },
                    { label: "Fin агент", value: customer.finagent_ref },
                  ].map((item) => (
                    <div key={item.label}>
                      <div style={{ fontSize: 10, color: "#A89070", marginBottom: 4 }}>{item.label}</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: item.value ? "#1A1A1A" : "#C8C0B0" }}>
                        {item.value || "—"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Notes */}
            {customer.notes && (
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 10, textTransform: "uppercase" }}>Примечание</div>
                <div style={{ fontSize: 12, color: "#1A1A1A", lineHeight: 1.6 }}>{customer.notes}</div>
              </div>
            )}

            {/* Orders */}
            {detail?.orders?.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 14, textTransform: "uppercase" }}>Заказы клиента</div>
                {detail.orders.slice(0, 4).map((order: any) => (
                  <div key={order.id} style={{ paddingBottom: 12, marginBottom: 12, borderBottom: "1px solid #F2EFE9" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>{order.title}</div>
                      <div style={{ fontSize: 10, color: "#A89070" }}>{order.status}</div>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#6B6355" }}>
                      <span>{fmt(order.price_plan)}</span>
                      <span>{order.debt > 0 ? fmt(order.debt) : "Оплачен"}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Transactions */}
            {detail?.transactions?.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 14, textTransform: "uppercase" }}>Транзакции</div>
                {detail.transactions.slice(0, 4).map((tx: any) => (
                  <div key={tx.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", paddingBottom: 10, marginBottom: 10, borderBottom: "1px solid #F2EFE9" }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>
                        {tx.direction === "in" ? "+" : "−"}{fmt(tx.amount)}
                      </div>
                      <div style={{ fontSize: 10, color: "#6B6355", marginTop: 2 }}>{tx.counterparty || tx.description || "—"}</div>
                    </div>
                    <div style={{ fontSize: 10, color: "#A89070" }}>{new Date(tx.date).toLocaleDateString("ru-RU")}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(10px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
