import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useIsMobile, M } from "../components/ui/responsive";
import { useNavigate, useParams } from "react-router-dom";
import { Loading } from "../components/ui/Loading";
import { EmptyState } from "../components/ui/EmptyState";
import { ColumnFilter } from "../components/TableFilters";
import { EditModal } from "../components/EditModal";
import { MagnifyingGlass, Plus, CaretRight, X } from "@phosphor-icons/react";
import { WIKI_CATEGORIES, findCategory, type WikiCategory } from "./wiki/registry";
import { initials, PAGE_SIZE, PAGE_SIZE_OPTIONS } from "./wiki/helpers";
import { T } from "../components/ui/type";

export default function Wiki() {
  const navigate = useNavigate();
  const params = useParams<{ category: string; id: string }>();
  const cat = findCategory(params.category);
  const id = params.id;

  return <WikiCategoryView key={cat.key} cat={cat} id={id} navigate={navigate} />;
}

function WikiCategoryView({ cat, id, navigate }: { cat: WikiCategory; id?: string; navigate: (p: string) => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [page, setPage] = useState(0);
  // Размер страницы запоминается между визитами (справочники маленькие, дефолт 100).
  const [pageSize, setPageSize] = useState<number>(() => {
    // Number(null) === 0, а 0 — это «Все»: без проверки на null дефолт был бы «Все».
    const raw = localStorage.getItem("wiki_page_size");
    const saved = raw === null ? NaN : Number(raw);
    return PAGE_SIZE_OPTIONS.includes(saved) ? saved : PAGE_SIZE;
  });
  const changePageSize = (n: number) => {
    setPageSize(n); setPage(0); localStorage.setItem("wiki_page_size", String(n));
  };
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);        // создание через EditModal (поля)
  const [creatingModal, setCreatingModal] = useState(false); // создание через свою модалку (бренды/юрлица)

  const rightOpen = !!id;   // панель у всех категорий
  // Телефон: список компактный (аватар + имя — готовый рецепт rightOpen), деталь — на весь экран.
  const isMobile = useIsMobile();

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["wiki", cat.key, cat.adapter.serverSearch ? search : ""],
    queryFn: () => cat.adapter.list(cat.adapter.serverSearch ? search : undefined),
  });

  const create = useMutation({
    mutationFn: (data: Record<string, any>) => cat.adapter.create(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["wiki", cat.key] }); setCreating(false); },
  });

  const all = rows as any[];

  // Клиентский поиск (когда serverSearch=false) + колоночные фильтры.
  const filtered = useMemo(() => {
    let out = all;
    if (!cat.adapter.serverSearch && search) {
      const q = search.toLowerCase();
      const fields = cat.searchFields ?? ["name"];
      out = out.filter((r) => fields.some((f) => String(r[f] ?? "").toLowerCase().includes(q)));
    }
    for (const [k, v] of Object.entries(filters)) {
      if (v) out = out.filter((r) => String(r[k] ?? "") === v);
    }
    return out;
  }, [all, search, filters, cat]);

  const totalCount = filtered.length;
  const size = pageSize || Math.max(totalCount, 1);   // 0 = «Все» — одним срезом
  const totalPages = Math.max(1, Math.ceil(totalCount / size));
  const pageItems = filtered.slice(page * size, (page + 1) * size);
  const selectedRow = id ? all.find((r) => r.id === id) : null;

  const hasFilters = Object.values(filters).some(Boolean) || !!search;
  const clearFilters = () => { setFilters({}); setSearch(""); setPage(0); };

  // grid: [аватар?] + колонки; при открытой панели — только аватар + имя.
  const avatarCol = cat.avatar ? "32px " : "";
  const cols = (rightOpen || isMobile)
    ? `${avatarCol}1fr`
    : avatarCol + cat.columns.map((c) => c.width).join(" ");

  function uniqueValues(key: string): string[] {
    return [...new Set(all.map((r) => r[key]).filter(Boolean))].sort() as string[];
  }

  function renderPageNums() {
    const pages: (number | "…")[] = [];
    if (totalPages <= 5) for (let i = 0; i < totalPages; i++) pages.push(i);
    else {
      pages.push(0);
      if (page > 2) pages.push("…");
      if (page > 1 && page < totalPages - 1) pages.push(page);
      if (page < totalPages - 2) pages.push("…");
      pages.push(totalPages - 1);
    }
    return [...new Set(pages)].map((p, i) =>
      p === "…" ? (
        <span key={`e${i}`} style={{ fontSize: 10, color: "#A89070", padding: "0 2px" }}>…</span>
      ) : (
        <button type="button" key={p} onClick={() => setPage(p as number)} style={{
          minWidth: 20, height: 20, background: "none", border: "none", cursor: "pointer",
          fontSize: 10, fontWeight: page === p ? 600 : 400,
          color: page === p ? "#1A1A1A" : "#A89070",
          borderBottom: page === p ? "2px solid #E8592A" : "2px solid transparent", padding: "0 2px",
        }}>{(p as number) + 1}</button>
      )
    );
  }

  const onRowClick = (row: any) => {
    navigate(id === row.id ? `/wiki/${cat.key}` : `/wiki/${cat.key}/${row.id}`);
  };

  const onAddClick = () => {
    if (cat.createModal) setCreatingModal(true);
    else setCreating(true);
  };

  const DetailComp = cat.Detail as any;
  const CreateModalComp = cat.createModal as any;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* Левая панель */}
      <div style={{
        flex: rightOpen && !isMobile ? "0 0 50%" : "1 1 0",
        display: rightOpen && isMobile ? "none" : "flex", flexDirection: "column", minWidth: 0,
        borderRight: rightOpen && !isMobile ? "1px solid #EDEBE6" : "none",
      }}>
        <div style={{ padding: isMobile ? "16px 16px 0" : "24px 28px 0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ fontSize: isMobile ? 22 : 26, fontWeight: 700, color: "#1A1A1A", letterSpacing: "-0.03em" }}>Вики</div>
            {searchOpen ? (
              <div style={{ position: "relative" }}>
                <MagnifyingGlass size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#A89070" }} />
                <input autoFocus
                  style={{ paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6, border: "1px solid #EDEBE6", background: "transparent", fontSize: 12, color: "#1A1A1A", outline: "none", width: 200 }}
                  placeholder="Поиск..." value={search}
                  onChange={e => { setSearch(e.target.value); setPage(0); }}
                  onKeyDown={e => { if (e.key === "Escape") { setSearchOpen(false); setSearch(""); setPage(0); } }} />
              </div>
            ) : (
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" onClick={() => setSearchOpen(true)} style={{ width: 28, height: 28, background: "#F2EFE9", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#6B6355" }}><MagnifyingGlass size={14} /></button>
                <button type="button" onClick={onAddClick} title={`Новый: ${cat.singular}`} style={{ width: 28, height: 28, background: "#E8592A", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}><Plus size={14} /></button>
              </div>
            )}
          </div>

          {/* Вкладки категорий */}
          <div style={{ display: "flex", gap: 18, borderBottom: "1px solid #EDEBE6", ...(isMobile ? M.tabStrip : null) }}>
            {WIKI_CATEGORIES.map((c) => {
              const active = c.key === cat.key;
              return (
                <button type="button" key={c.key} onClick={() => navigate(`/wiki/${c.key}`)}
                  style={{
                    background: "none", border: "none", cursor: "pointer", padding: "6px 0 10px",
                    fontSize: 12, fontWeight: active ? 600 : 400, fontFamily: "inherit",
                    color: active ? "#1A1A1A" : "#A89070",
                    borderBottom: active ? "2px solid #E8592A" : "2px solid transparent", marginBottom: -1,
                  }}>{c.label}</button>
              );
            })}
          </div>
        </div>

        <div style={{ padding: "10px 28px", borderBottom: "1px solid #F2EFE9", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: "#6B6355" }}>{totalCount} записей</span>
          <button type="button" onClick={hasFilters ? clearFilters : undefined} style={{ fontSize: 10, color: hasFilters ? "#E8592A" : "#C8C0B0", background: "none", border: "none", cursor: hasFilters ? "pointer" : "default", display: "flex", alignItems: "center", gap: 3, padding: 0 }}>
            <X size={10} /> Сбросить
          </button>
        </div>

        {/* Заголовки колонок */}
        {!rightOpen && !isMobile && (
          <div style={{ display: "grid", gridTemplateColumns: cols, gap: 12, padding: "8px 28px", borderBottom: "1px solid #F7F5F1", alignItems: "center" }}>
            {cat.avatar && <div />}
            {cat.columns.map((c) => (
              <div key={c.key} style={{ textAlign: c.align, minWidth: 0 }}>
                {c.filter ? (
                  <ColumnFilter label={c.label} options={uniqueValues(c.key)} value={filters[c.key] || ""} onChange={(v) => { setFilters(f => ({ ...f, [c.key]: v })); setPage(0); }} />
                ) : (
                  <span style={T.colLabel}>{c.label}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Строки */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {isLoading ? <Loading compact /> :
           pageItems.length === 0 ? <EmptyState compact title="Ничего не найдено" /> :
           pageItems.map((item: any) => {
            const active = id === item.id;
            return (
              <div key={item.id} onClick={() => onRowClick(item)}
                style={{
                  display: "grid", gridTemplateColumns: cols, gap: 12,
                  padding: "10px 28px", borderBottom: "1px solid #F7F5F1",
                  cursor: "pointer", alignItems: "center",
                  background: active ? "#E8592A" : "transparent", transition: "background 0.1s",
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = "#FAF8F5"; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>

                {cat.avatar && (
                  cat.avatar.kind === "colorDot" ? (
                    <span style={{ width: 12, height: 12, borderRadius: "50%", background: item.color || "#A89070", justifySelf: "center" }} />
                  ) : (
                    <div style={{
                      width: 26, height: 26, borderRadius: "50%",
                      background: active ? "rgba(255,255,255,0.25)" : (cat.avatar.debtTint && item.debt > 0 ? "#FFF0EC" : "#F2EFE9"),
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", flexShrink: 0,
                      color: active ? "#fff" : (cat.avatar.debtTint && item.debt > 0 ? "#8B3A3A" : "#1A1A1A"),
                    }}>{initials(item.name)}</div>
                  )
                )}

                {(rightOpen || isMobile) ? (
                  <div style={{ fontSize: 13, fontWeight: 500, color: active ? "#fff" : "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.name}
                  </div>
                ) : (
                  cat.columns.map((c) => (
                    <div key={c.key} style={{ textAlign: c.align, minWidth: 0, color: active ? "#fff" : undefined }}>
                      {c.render
                        ? c.render(item)
                        : <span style={{ fontSize: 13, fontWeight: 500, color: active ? "#fff" : "#1A1A1A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{item[c.key] ?? "—"}</span>}
                    </div>
                  ))
                )}
              </div>
            );
          })}

          {/* Доп. блок категории (напр. «только в вики» у подрядчиков) — под списком */}
          {!rightOpen && cat.footer && <cat.footer />}
        </div>

        {/* Пагинация */}
        <div style={{ padding: "8px 28px", borderTop: "1px solid #F7F5F1", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 14, alignItems: "center", fontSize: 10, color: "#A89070" }}>
            <span>{totalCount > 0 ? `${page * size + 1}–${Math.min((page + 1) * size, totalCount)} из ${totalCount}` : "0"}</span>
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ letterSpacing: "0.06em" }}>НА СТРАНИЦЕ</span>
              {PAGE_SIZE_OPTIONS.map(n => (
                <button type="button" key={n} onClick={() => changePageSize(n)}
                  style={{
                    background: "none", border: "none", cursor: "pointer", padding: "0 1px", fontSize: 10,
                    fontFamily: "inherit", fontWeight: pageSize === n ? 600 : 400,
                    color: pageSize === n ? "#1A1A1A" : "#A89070",
                    borderBottom: pageSize === n ? "2px solid #E8592A" : "2px solid transparent",
                  }}>
                  {n === 0 ? "Все" : n}
                </button>
              ))}
            </span>
          </div>
          {totalPages > 1 && (
            <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
              {renderPageNums()}
              <button type="button" onClick={() => setPage(p => Math.min(p + 1, totalPages - 1))} disabled={page >= totalPages - 1}
                style={{ background: "none", border: "none", cursor: page >= totalPages - 1 ? "default" : "pointer", color: page >= totalPages - 1 ? "#D0C8C0" : "#A89070", display: "flex", alignItems: "center", padding: "0 2px" }}>
                <CaretRight size={11} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Правая панель — у всех категорий (единая навигация) */}
      {rightOpen && DetailComp && (
        <div key={id} style={{ flex: isMobile ? "1 1 0" : "0 0 50%", display: "flex", flexDirection: "column", animation: "wikiFade 0.12s ease-out", minWidth: 0 }}>
          <DetailComp id={id} row={selectedRow} onClose={() => navigate(`/wiki/${cat.key}`)} onDeleted={() => navigate(`/wiki/${cat.key}`)} />
        </div>
      )}

      {/* Создание: форма по полям (клиенты/подрядчики/поставщики) */}
      {creating && cat.createFields && (
        <EditModal
          title={`Новый: ${cat.singular}`}
          fields={cat.createFields}
          initial={{}}
          isPending={create.isPending}
          onSave={(d) => create.mutate(d)}
          onClose={() => setCreating(false)}
        />
      )}

      {/* Создание: своя модалка (бренды/юрлица) */}
      {creatingModal && CreateModalComp && (
        <CreateModalComp row={{}} onClose={() => setCreatingModal(false)} />
      )}

      <style>{`@keyframes wikiFade { from { opacity: 0 } to { opacity: 1 } }`}</style>
    </div>
  );
}
