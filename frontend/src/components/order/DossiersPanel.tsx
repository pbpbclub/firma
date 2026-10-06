/**
 * «Чертежи и ведомости» — комплекты конструктора по изделиям заказа (ТЗ YOS 06.10.2026).
 *
 * Комплект — изделие внутри заказа, версия — неизменяемый снимок (файлы + ведомость).
 * Последняя опубликованная версия текущая сама; кнопки здесь — только ручное
 * переопределение: закрепить другую, снять закрепление, отозвать ошибочную, отправить
 * фину на просчёт, перенести ведомость в каталог. Публикует только конструктор
 * через dossier.py — загрузки файлов из интерфейса нет намеренно (один вход).
 * Денег в комплекте нет: ведомость показывается без цен.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { CaretRight, PushPin, FileText, DownloadSimple, ArrowSquareOut } from "@phosphor-icons/react";
import { dossiersApi } from "../../api";
import { MONO } from "../ui/Num";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useIsMobile } from "../ui/responsive";

const BY: Record<string, string> = { blender: "конструктор", yos: "YOS", yura: "Юра", firma: "Фирма" };
const ROLE: Record<string, string> = { drawing: "чертёж", bom: "ведомость", model: "модель", render: "рендер", other: "прочее" };
const LINE_TYPE: Record<string, string> = { material: "материал", work: "работа", labor: "работа", service: "услуга", delivery: "доставка", other: "прочее" };

const lbl: React.CSSProperties = { fontSize: 10, color: "#A89070", letterSpacing: "0.06em" };
const chip: React.CSSProperties = { fontSize: 10, background: "#F2EFE9", color: "#6B6355", padding: "2px 6px", whiteSpace: "nowrap" };
const bodyPad: React.CSSProperties = { padding: "18px 24px" };
const smallBtn: React.CSSProperties = { fontSize: 10, padding: "3px 10px" };

// sqlite datetime('now') — UTC без «T»: Safari такую строку не разбирает
function dt(s?: string | null, withTime = false): string {
  if (!s) return "—";
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  if (isNaN(+d)) return s;
  const day = d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" });
  return withTime ? `${day} ${d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : day;
}

function fmtBytes(n?: number | null): string {
  if (!n) return "";
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / 1024 / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
}

const errText = (e: any, fallback: string) => {
  const d = e?.response?.data?.detail;
  return typeof d === "string" ? d : (d?.detail || fallback);
};

export function DossiersPanel({ orderId, summary }: { orderId: string; summary?: string | null }) {
  const { data } = useQuery({
    queryKey: ["order-dossiers", orderId],
    queryFn: () => dossiersApi.listForOrder(orderId),
  });
  const rows: any[] = Array.isArray(data) ? data : [];
  if (rows.length === 0) return null;   // комплектов нет — секция не нужна

  return (
    <div style={{ paddingTop: 18, marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <span style={lbl}>ЧЕРТЕЖИ И ВЕДОМОСТИ</span>
        {summary && <span style={{ fontSize: 11, color: "#6B6355", fontFamily: MONO }}>{summary}</span>}
      </div>
      {rows.map(d => <DossierCard key={d.dossier_id} brief={d} orderId={orderId} />)}
    </div>
  );
}

function DossierCard({ brief, orderId }: { brief: any; orderId: string }) {
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [history, setHistory] = useState(false);
  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: full } = useQuery({
    queryKey: ["dossier", brief.dossier_id, showWithdrawn],
    queryFn: () => dossiersApi.get(brief.dossier_id, showWithdrawn),
    // Переключатель «показать отозванные» меняет ключ: без прежних данных блок текущей
    // версии на миг размонтируется и схлопнет раскрытую ведомость
    placeholderData: keepPreviousData,
  });
  const versions: any[] = full?.versions ?? [];
  const current = versions.find(v => v.is_current);
  const others = versions.filter(v => !v.is_current);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["order-dossiers", orderId] });
    qc.invalidateQueries({ queryKey: ["dossier", brief.dossier_id] });
    qc.invalidateQueries({ queryKey: ["order-detail", orderId] });
    qc.invalidateQueries({ queryKey: ["order-timeline", orderId] });
  };
  const unpin = useMutation({
    mutationFn: () => dossiersApi.unpin(brief.dossier_id),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e: any) => setError(errText(e, "Не удалось снять закрепление")),
  });

  return (
    <div style={{ borderBottom: "1px solid #F2EFE9", padding: isMobile ? "12px 0" : "12px 10px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#1A1A1A" }}>{brief.title}</span>
        {brief.versions_total > 1 && (
          <span style={{ fontSize: 11, color: "#A89070" }}>версий: {brief.versions_total}
            {brief.withdrawn_total > 0 && `, отозвано ${brief.withdrawn_total}`}</span>
        )}
      </div>

      {!!brief.pinned && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 8,
          padding: "6px 10px", background: "#FAF8F5", borderLeft: "2px solid #E8592A", fontSize: 11, color: "#6B6355" }}>
          <PushPin size={12} style={{ color: "#E8592A" }} />
          <span style={{ flex: 1, minWidth: 180 }}>Текущая выбрана Юрой — новые версии уходят в историю</span>
          <Button size="sm" disabled={unpin.isPending} onClick={() => unpin.mutate()} style={smallBtn}>
            Снять закрепление
          </Button>
        </div>
      )}

      {current
        ? <VersionBlock v={current} dossier={brief} orderId={orderId} onChanged={refresh} onError={setError} isCurrent />
        : <div style={{ fontSize: 12, color: "#A89070", marginTop: 8 }}>Текущей версии нет — все отозваны</div>}

      {error && <div style={{ fontSize: 11, color: "#8B3A3A", marginTop: 8 }}>{error}</div>}

      {(brief.versions_total > 1 || brief.withdrawn_total > 0) && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span onClick={() => setHistory(h => !h)}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none", ...lbl }}>
              <CaretRight size={11} style={{ transform: history ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
              ИСТОРИЯ ВЕРСИЙ
            </span>
            {history && brief.withdrawn_total > 0 && (
              <label style={{ fontSize: 11, color: "#6B6355", display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                <input type="checkbox" checked={showWithdrawn} onChange={e => setShowWithdrawn(e.target.checked)} />
                показать отозванные ({brief.withdrawn_total})
              </label>
            )}
          </div>
          {history && (
            others.length === 0
              ? <div style={{ fontSize: 12, color: "#A89070", marginTop: 6 }}>Других версий нет</div>
              : others.map(v => <HistoryRow key={v.id} v={v} dossier={brief} orderId={orderId} onChanged={refresh} onError={setError} />)
          )}
        </div>
      )}
    </div>
  );
}

function VersionMeta({ v }: { v: any }) {
  return (
    <span style={{ fontSize: 12, color: "#6B6355", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
      <span style={{ color: "#1A1A1A", fontWeight: 600 }}>v{v.number}</span>
      {" · "}{dt(v.published_at, true)}{" · "}{BY[v.published_by] || v.published_by}
    </span>
  );
}

function CostingBadge({ v, orderId }: { v: any; orderId: string }) {
  const navigate = useNavigate();
  if (v.costing_status === "requested")
    return <span style={{ ...chip, color: "#E8592A" }}>на просчёте с {dt(v.costing_requested_at)}</span>;
  if (v.costing_status === "done")
    return (
      <span style={{ ...chip, color: "#4A7C59", cursor: v.estimate_set_id ? "pointer" : undefined }}
        onClick={() => v.estimate_set_id && navigate(`/orders/${orderId}/estimate?set=${v.estimate_set_id}`)}>
        посчитан{v.estimate_set_id ? " → смета" : ""}
      </span>
    );
  return null;
}

function HistoryRow({ v, dossier, orderId, onChanged, onError }: {
  v: any; dossier: any; orderId: string; onChanged: () => void; onError: (s: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const withdrawn = v.status === "withdrawn";
  return (
    <div style={{ marginTop: 6, paddingLeft: 17, opacity: withdrawn ? 0.6 : 1 }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flexWrap: "wrap", padding: "4px 0" }}>
        <CaretRight size={10} style={{ color: "#A89070", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} />
        <VersionMeta v={v} />
        {withdrawn && <span style={{ ...chip, color: "#8B3A3A" }}>отозвана {dt(v.withdrawn_at)}</span>}
        <CostingBadge v={v} orderId={orderId} />
        {v.note && <span style={{ fontSize: 11, color: "#6B6355", flexBasis: "100%", paddingLeft: 18 }}>{v.note}</span>}
        {withdrawn && v.withdrawn_note && (
          <span style={{ fontSize: 11, color: "#8B3A3A", flexBasis: "100%", paddingLeft: 18 }}>причина: {v.withdrawn_note}</span>
        )}
      </div>
      {open && <VersionBlock v={v} dossier={dossier} orderId={orderId} onChanged={onChanged} onError={onError} />}
    </div>
  );
}

function VersionBlock({ v, dossier, orderId, onChanged, onError, isCurrent }: {
  v: any; dossier: any; orderId: string; onChanged: () => void; onError: (s: string | null) => void; isCurrent?: boolean;
}) {
  const isMobile = useIsMobile();
  const [bomOpen, setBomOpen] = useState(false);
  const [modal, setModal] = useState<null | "withdraw" | "costing" | "catalog">(null);
  const [reason, setReason] = useState("");
  const [catalogRes, setCatalogRes] = useState<any>(null);
  const withdrawn = v.status === "withdrawn";
  const lockedByPin = !!dossier.pinned && isCurrent;

  const done = () => { onError(null); setModal(null); onChanged(); };
  const fail = (fallback: string) => (e: any) => { setModal(null); onError(errText(e, fallback)); };
  const pin = useMutation({
    mutationFn: () => dossiersApi.pin(dossier.dossier_id, v.id),
    onSuccess: done, onError: fail("Не удалось сделать текущей"),
  });
  const withdraw = useMutation({
    mutationFn: () => dossiersApi.withdraw(v.id, reason.trim()),
    onSuccess: () => { setReason(""); done(); }, onError: fail("Не удалось отозвать"),
  });
  const costing = useMutation({
    mutationFn: () => dossiersApi.requestCosting(v.id),
    onSuccess: done, onError: fail("Поручение фину не ушло"),
  });
  const toCatalog = useMutation({
    mutationFn: () => dossiersApi.toCatalog(v.id),
    onSuccess: (r: any) => { setCatalogRes(r); onError(null); onChanged(); },
    onError: fail("Не удалось перенести в каталог"),
  });

  const { data: full, isLoading: bomLoading } = useQuery({
    queryKey: ["dossier-version", v.id],
    queryFn: () => dossiersApi.version(v.id),
    enabled: bomOpen,
  });
  const lines: any[] = full?.bom_json?.lines ?? [];
  const files: any[] = v.files ?? [];
  const count = (x: any) => Array.isArray(x) ? x.length : (x ?? 0);

  return (
    <div style={{ marginTop: 8, paddingLeft: isCurrent ? 0 : 18 }}>
      {isCurrent && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <VersionMeta v={v} />
          <span style={{ ...chip, color: "#E8592A" }}>текущая</span>
          <CostingBadge v={v} orderId={orderId} />
        </div>
      )}
      {isCurrent && v.note && <div style={{ fontSize: 12, color: "#1A1A1A", marginTop: 4, lineHeight: 1.5 }}>{v.note}</div>}

      {/* Файлы версии: открыть — превью во вкладке, скачать — под исходным именем */}
      <div style={{ marginTop: 6 }}>
        {files.map(f => (
          <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 12, flexWrap: isMobile ? "wrap" : undefined }}>
            <span style={{ ...chip, minWidth: 58, textAlign: "center" }}>{ROLE[f.role] || f.role}</span>
            <FileText size={13} style={{ color: "#A89070", flexShrink: 0 }} />
            <a href={dossiersApi.fileUrl(f.id)} target="_blank" rel="noreferrer"
              style={{ color: "#1A1A1A", textDecoration: "none", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              onMouseEnter={e => (e.currentTarget.style.textDecoration = "underline")}
              onMouseLeave={e => (e.currentTarget.style.textDecoration = "none")}>
              {f.filename}
            </a>
            <span style={{ fontSize: 11, color: "#A89070", fontFamily: MONO, whiteSpace: "nowrap" }}>{fmtBytes(f.bytes)}</span>
            <a href={dossiersApi.fileUrl(f.id)} target="_blank" rel="noreferrer" title="Открыть"
              style={{ color: "#6B6355", display: "inline-flex" }}><ArrowSquareOut size={14} /></a>
            <a href={dossiersApi.fileUrl(f.id, true)} download={f.filename} title="Скачать"
              style={{ color: "#6B6355", display: "inline-flex" }}><DownloadSimple size={14} /></a>
          </div>
        ))}
      </div>

      {/* Кнопки версии */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        {v.has_bom && (
          <Button size="sm" onClick={() => setBomOpen(o => !o)} style={smallBtn}>
            {bomOpen ? "Скрыть ведомость" : "Ведомость"}
          </Button>
        )}
        {!isCurrent && !withdrawn && (
          <Button size="sm" disabled={pin.isPending} onClick={() => pin.mutate()} style={smallBtn}
            title="Закрепить: новые версии пойдут в историю, пока закрепление не снято">
            Сделать текущей
          </Button>
        )}
        {!withdrawn && (
          <Button size="sm" variant={v.costing_status === "none" ? "primary" : "ghost"} onClick={() => setModal("costing")} style={smallBtn}>
            {v.costing_status === "none" ? "На просчёт фину" : "Отправить фину снова"}
          </Button>
        )}
        {v.has_bom && !withdrawn && (
          <Button size="sm" onClick={() => setModal("catalog")} style={smallBtn}>В каталог</Button>
        )}
        {!withdrawn && (
          <Button size="sm" disabled={lockedByPin} onClick={() => setModal("withdraw")}
            title={lockedByPin ? "Сначала сними закрепление" : "Опубликована по ошибке — скрыть, указатель откатится"}
            style={{ ...smallBtn, color: "#8B3A3A" }}>
            Отозвать
          </Button>
        )}
      </div>

      {/* Ведомость: количества и виды работ, без цен — цены в сметах и каталоге */}
      {bomOpen && (
        <div style={{ marginTop: 8, overflowX: "auto" }}>
          {bomLoading ? <div style={{ fontSize: 12, color: "#A89070" }}>Загрузка…</div>
            : lines.length === 0 ? <div style={{ fontSize: 12, color: "#A89070" }}>Ведомость пустая</div>
            : (
              <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%", minWidth: isMobile ? 0 : 420 }}>
                <thead>
                  <tr style={{ textAlign: "left" }}>
                    {["ТИП", "НАЗВАНИЕ / КОД", "КОЛ-ВО", "ЕД."].map((h, i) => (
                      <th key={h} style={{ ...lbl, fontWeight: 400, padding: "4px 8px 4px 0", borderBottom: "1px solid #EDEBE6", textAlign: i === 2 ? "right" : "left" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((ln, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #F2EFE9" }}>
                      <td style={{ padding: "4px 8px 4px 0", color: "#6B6355", whiteSpace: "nowrap" }}>{LINE_TYPE[ln.type] || ln.type || "—"}</td>
                      <td style={{ padding: "4px 8px 4px 0", color: "#1A1A1A" }}>
                        {ln.title || ln.work_type || "—"}
                        {ln.material_code && <span style={{ fontFamily: MONO, fontSize: 10.5, color: "#A89070", marginLeft: 6 }}>{ln.material_code}</span>}
                      </td>
                      <td style={{ padding: "4px 8px 4px 0", textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                        {ln.qty != null ? Number(ln.qty).toLocaleString("ru-RU", { maximumFractionDigits: 3 }) : "—"}
                      </td>
                      <td style={{ padding: "4px 0", color: "#6B6355" }}>{ln.unit || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}

      {catalogRes && (
        <div style={{ fontSize: 11, color: "#4A7C59", marginTop: 8 }}>
          {catalogRes.created ? "Карточка каталога создана" : "Карточка каталога обновлена"}: «{catalogRes.title}» —
          строк {catalogRes.lines_total}, сопоставлено {count(catalogRes.matched)}
          {count(catalogRes.unmatched) > 0 && <span style={{ color: "#8B3A3A" }}>, без кода {count(catalogRes.unmatched)} — всплывут в cost-check</span>}
        </div>
      )}

      {modal === "withdraw" && (
        <Modal size="sm" eyebrow={`ОТОЗВАТЬ v${v.number}`} onClose={() => setModal(null)}
          onCancel={() => setModal(null)} onSave={() => withdraw.mutate()} saveLabel="Отозвать"
          saving={withdraw.isPending} canSave={reason.trim().length > 0}>
          <div style={bodyPad}>
          <div style={{ fontSize: 12, color: "#6B6355", lineHeight: 1.5, marginBottom: 10 }}>
            Версия не удаляется — скрывается из списков. {isCurrent && "Текущей станет предыдущая активная."}
          </div>
          <div style={{ ...lbl, marginBottom: 5 }}>ПРИЧИНА</div>
          <textarea autoFocus value={reason} onChange={e => setReason(e.target.value)} rows={3}
            placeholder="например: опубликована по ошибке, не тот файл"
            style={{ width: "100%", boxSizing: "border-box", border: "1px solid #EDEBE6", padding: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", borderRadius: 0 }} />
          </div>
        </Modal>
      )}
      {modal === "costing" && (
        <Modal size="sm" eyebrow="НА ПРОСЧЁТ ФИНУ" onClose={() => setModal(null)}
          onCancel={() => setModal(null)} onSave={() => costing.mutate()} saveLabel="Отправить"
          saving={costing.isPending}>
          <div style={{ ...bodyPad, fontSize: 13, color: "#1A1A1A", lineHeight: 1.5 }}>
            Фин получит поручение просчитать «{dossier.title}» v{v.number}: ведомость и чертежи он заберёт с сервера.
            {v.costing_status !== "none" && <div style={{ color: "#6B6355", marginTop: 6, fontSize: 12 }}>Эта версия уже отправлялась — поручение уйдёт повторно.</div>}
          </div>
        </Modal>
      )}
      {modal === "catalog" && (
        <Modal size="sm" eyebrow="В КАТАЛОГ" onClose={() => setModal(null)}
          onCancel={() => setModal(null)} onSave={() => { setModal(null); toCatalog.mutate(); }} saveLabel="Перенести"
          saving={toCatalog.isPending}>
          <div style={{ ...bodyPad, fontSize: 13, color: "#1A1A1A", lineHeight: 1.5 }}>
            Ведомость v{v.number} ляжет рецептурой в карточку каталога «{dossier.title}»
            {dossier.catalog_item_id ? " (привязанная карточка обновится)" : " (найдётся по названию или создастся)"}.
            Цены подтянутся из прайсов и ставок на сегодня.
          </div>
        </Modal>
      )}
    </div>
  );
}
