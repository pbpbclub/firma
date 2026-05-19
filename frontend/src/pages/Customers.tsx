import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Search, Link2 } from "lucide-react";
import { customersApi } from "../api";

function initials(name: string | undefined) {
  if (!name) return "—";
  const cleaned = name.trim().replace(/["«»„“]/g, "").replace(/^(ООО|ИП|ЗАО|ОАО|ПАО)\s+/i, "");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function fmtPhone(phone: string | undefined) {
  if (!phone) return "—";
  return phone;
}

function fmt(n: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) + " ₽";
}

export default function Customers() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [search, setSearch] = useState("");

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

  const cols = id ? "64px 2fr 110px 120px 120px 40px" : "60px 2.3fr 100px 120px 120px 40px";

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div style={{ flex: id ? "0 0 56%" : "1 1 0", display: "flex", flexDirection: "column", minWidth: 0, borderRight: id ? "1px solid #EDEBE6" : "none", transition: "flex 0.2s ease" }}>
        <div style={{ padding: "24px 28px 0" }}>
          <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.06em", marginBottom: 4 }}>
            {new Date().toLocaleDateString("ru-RU", { month: "short", year: "numeric" }).toUpperCase().replace(" ", "'")}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>
              Клиенты
            </div>
            <div style={{ position: "relative" }}>
              <Search size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#A89070" }} />
              <input
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
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: cols, padding: "10px 28px", borderBottom: "1px solid #F7F5F1" }}>
          {[
            "",
            "Контрагент",
            "ИНН",
            "Телефон",
            "Fin агент",
            "",
          ].map((h, i) => (
            <div key={i} style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em" }}>{h}</div>
          ))}
        </div>

        <div style={{ flex: 1, overflow: "auto" }}>
          {isLoading ? (
            <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 12 }}>Загружаем...</div>
          ) : customers.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "#A89070", fontSize: 12 }}>Клиентов не найдено</div>
          ) : (
            customers.map((customer: any) => {
              const isActive = id === customer.id;
              return (
                <div
                  key={customer.id}
                  onClick={() => navigate(isActive ? "/customers" : `/customers/${customer.id}`)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: cols,
                    padding: "12px 28px",
                    borderBottom: "1px solid #F7F5F1",
                    cursor: "pointer",
                    background: isActive ? "#FDF0EC" : "transparent",
                    alignItems: "center",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#FAF8F5"; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = isActive ? "#FDF0EC" : "transparent"; }}
                >
                  <div style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: "#F2EFE9",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#1A1A1A",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                  }}>
                    {initials(customer.name)}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "#1A1A1A", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {customer.name}
                  </div>
                  <div style={{ fontSize: 11, color: "#6B6355" }}>{customer.inn || "—"}</div>
                  <div style={{ fontSize: 11, color: "#6B6355" }}>{fmtPhone(customer.phone)}</div>
                  <div style={{ fontSize: 11, color: customer.finagent_ref ? "#1A1A1A" : "#C8C0B0" }}>
                    {customer.finagent_ref || "—"}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <Link2 size={14} style={{ color: "#C8C0B0" }} />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {id && customer && (
        <div style={{ flex: "0 0 44%", display: "flex", flexDirection: "column", animation: "slideIn 0.18s ease", minWidth: 0 }}>
          <div style={{ padding: "24px 24px 18px", borderBottom: "1px solid #EDEBE6", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 8 }}>Карточка клиента</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.02em", maxWidth: 320 }}>{customer.name}</div>
              {customer.full_name && (
                <div style={{ fontSize: 11, color: "#A89070", marginTop: 8 }}>{customer.full_name}</div>
              )}
            </div>
          </div>

          <div style={{ flex: 1, overflow: "auto", padding: "24px 24px 20px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, marginBottom: 22 }}>
              {[
                { label: "Заказов", value: detail?.orders?.length ?? 0 },
                { label: "Транзакций", value: summary?.count ?? 0 },
                { label: "Доход", value: summary ? fmt(summary.income) : "—" },
                { label: "Расход", value: summary ? fmt(summary.expense) : "—" },
              ].map((item) => (
                <div key={item.label} style={{ padding: "16px 18px", background: "#FAF8F4" }}>
                  <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>{item.label}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A" }}>{item.value}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gap: 12, marginBottom: 22 }}>
              {[ 
                { label: "ИНН", value: customer.inn || "—" },
                { label: "Телефон", value: customer.phone || "—" },
                { label: "Email", value: customer.email || "—" },
                { label: "Контакт", value: customer.contact || "—" },
              ].map((item) => (
                <div key={item.label} style={{ padding: "16px 18px", background: "#FAF8F4" }}>
                  <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>{item.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>{item.value}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 22 }}>
              {[
                { label: "Wiki", value: customer.wiki_ref, placeholder: "—" },
                { label: "Fin агент", value: customer.finagent_ref, placeholder: "—" },
              ].map((item) => (
                <div key={item.label} style={{ padding: "16px 18px", background: "#FAF8F4" }}>
                  <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.06em", marginBottom: 6 }}>{item.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: item.value ? "#1A1A1A" : "#C8C0B0" }}>
                    {item.value || item.placeholder}
                  </div>
                </div>
              ))}
            </div>

            {customer.notes && (
              <div style={{ padding: "16px 18px", background: "#FAF8F4", marginBottom: 22 }}>
                <div style={{ fontSize: 10, color: "#A89070", letterSpacing: "0.04em", marginBottom: 8 }}>Примечание</div>
                <div style={{ fontSize: 12, color: "#1A1A1A" }}>{customer.notes}</div>
              </div>
            )}

            {detail?.orders?.length > 0 && (
              <div style={{ marginBottom: 22 }}>
                <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em", marginBottom: 12 }}>Заказы клиента</div>
                <div style={{ display: "grid", gap: 12 }}>
                  {detail.orders.slice(0, 4).map((order: any) => (
                    <div key={order.id} style={{ padding: "14px 16px", background: "#FAF8F4" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>{order.title}</div>
                        <div style={{ fontSize: 11, color: "#A89070" }}>{order.status}</div>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#6B6355" }}>
                        <span>{fmt(order.price_plan)}</span>
                        <span>{order.debt > 0 ? fmt(order.debt) : "Оплачен"}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {detail?.transactions?.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: "#A89070", letterSpacing: "0.04em", marginBottom: 10 }}>Недавние транзакции</div>
                <div style={{ display: "grid", gap: 10 }}>
                  {detail.transactions.slice(0, 4).map((tx: any) => (
                    <div key={tx.id} style={{ padding: "12px 14px", background: "#FAF8F4" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#1A1A1A" }}>
                          {tx.direction === "in" ? "+" : "−"}{fmt(tx.amount)}
                        </div>
                        <div style={{ fontSize: 10, color: "#A89070" }}>{new Date(tx.date).toLocaleDateString("ru-RU")}</div>
                      </div>
                      <div style={{ fontSize: 11, color: "#6B6355" }}>{tx.counterparty || tx.description || "—"}</div>
                    </div>
                  ))}
                </div>
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
