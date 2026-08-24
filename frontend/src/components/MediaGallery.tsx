import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Star, Trash, UploadSimple, X } from "@phosphor-icons/react";
import { mediaApi, MEDIA_KINDS, mediaKindLabel, type MediaFile } from "../api";

/** Медиатека изделия: карточка каталога — базовые картинки, позиция сметы — переопределение.
 *
 *  Роли (studio/photo/viz/render наружу, draft/ref внутрь) задаёт спека 07.08.2026;
 *  главный в роли один — он и уходит в КП/спецификацию. Наполняют и агенты (блендер,
 *  вендор) через то же API, поэтому здесь только показ и ручные правки Юры. */
export function MediaGallery({
  catalogItemId,
  estimateItemId,
  readOnly = false,
  compact = false,
}: {
  catalogItemId?: string | null;
  estimateItemId?: string | null;
  readOnly?: boolean;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const params = catalogItemId ? { catalog_item_id: catalogItemId } : { estimate_item_id: estimateItemId! };
  const key = ["media", catalogItemId || estimateItemId];

  const { data: files = [], isLoading } = useQuery<MediaFile[]>({
    queryKey: key,
    queryFn: () => mediaApi.list(params),
    enabled: !!(catalogItemId || estimateItemId),
  });

  const [kind, setKind] = useState("photo");
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MediaFile | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const upload = async (list: FileList | File[]) => {
    const picked = Array.from(list).filter(f => f.type.startsWith("image/"));
    if (!picked.length) return;
    setBusy(true); setError(null);
    try {
      for (const f of picked) {
        await mediaApi.upload({ file: f, kind, ...params, source: "yura", title: null });
      }
      refresh();
    } catch (e: any) {
      setError(e?.response?.data?.detail || "не загрузилось");
    } finally { setBusy(false); }
  };

  const patch = async (id: string, data: Record<string, any>) => {
    setBusy(true); setError(null);
    try { await mediaApi.patch(id, data); refresh(); }
    catch (e: any) { setError(e?.response?.data?.detail || "не сохранилось"); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try { await mediaApi.remove(id); refresh(); }
    finally { setBusy(false); }
  };

  const label: React.CSSProperties = { fontSize: 10, color: "#A89070", letterSpacing: "0.06em" };
  const tile = compact ? 76 : 96;

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={label}>МЕДИАТЕКА{files.length > 0 && <span style={{ color: "#C8C0B0" }}> · {files.length}</span>}</div>
        {!readOnly && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ ...label, color: "#C8C0B0" }}>ЗАГРУЖАТЬ КАК</span>
            <select value={kind} onChange={e => setKind(e.target.value)}
              style={{ border: "1px solid #EDEBE6", background: "transparent", fontSize: 11, color: "#1A1A1A", padding: "3px 6px", outline: "none" }}>
              {MEDIA_KINDS.map(k => <option key={k} value={k}>{mediaKindLabel(k)}</option>)}
            </select>
          </div>
        )}
      </div>

      {isLoading ? (
        <div style={{ ...label, marginTop: 10 }}>загрузка…</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {files.map(f => (
            <div key={f.id} style={{ width: tile, position: "relative" }}>
              <div
                onClick={() => setPreview(f)}
                title={f.title || mediaKindLabel(f.kind)}
                style={{
                  width: tile, height: tile, border: `1px solid ${f.is_primary ? "#E8592A" : "#EDEBE6"}`,
                  background: `#FAF8F5 url("${mediaApi.thumbUrl(f.id)}") center/cover no-repeat`,
                  cursor: "pointer",
                }}
              />
              <div style={{ position: "absolute", top: 0, left: 0, background: "rgba(26,26,26,0.72)", color: "#fff", fontSize: 9, letterSpacing: "0.04em", padding: "2px 5px" }}>
                {mediaKindLabel(f.kind).toUpperCase()}
              </div>
              {!readOnly && (
                <div style={{ position: "absolute", top: 0, right: 0, display: "flex" }}>
                  <button type="button"
                    title={f.is_primary ? "Главный в роли" : "Сделать главным"}
                    disabled={busy || !!f.is_primary}
                    onClick={() => patch(f.id, { is_primary: true })}
                    style={{ border: "none", background: "rgba(26,26,26,0.72)", color: f.is_primary ? "#E8592A" : "#fff", cursor: f.is_primary ? "default" : "pointer", padding: "2px 4px", lineHeight: 0 }}>
                    <Star size={11} weight={f.is_primary ? "fill" : "regular"} />
                  </button>
                  <button type="button"
                    title="Удалить файл"
                    disabled={busy}
                    onClick={() => remove(f.id)}
                    style={{ border: "none", background: "rgba(26,26,26,0.72)", color: "#fff", cursor: "pointer", padding: "2px 4px", lineHeight: 0 }}>
                    <Trash size={11} />
                  </button>
                </div>
              )}
              {!readOnly && (
                <select value={f.kind} disabled={busy} onChange={e => patch(f.id, { kind: e.target.value })}
                  style={{ width: tile, marginTop: 3, border: "1px solid #EDEBE6", background: "transparent", fontSize: 10, color: "#6B6355", padding: "2px 3px", outline: "none" }}>
                  {MEDIA_KINDS.map(k => <option key={k} value={k}>{mediaKindLabel(k)}</option>)}
                </select>
              )}
            </div>
          ))}

          {!readOnly && (
            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files); }}
              style={{
                width: tile, height: tile, border: `1px dashed ${dragOver ? "#E8592A" : "#EDEBE6"}`,
                background: dragOver ? "#FFF8F5" : "transparent", cursor: "pointer",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                gap: 4, color: dragOver ? "#E8592A" : "#A89070", textAlign: "center",
              }}
            >
              <UploadSimple size={16} />
              <span style={{ fontSize: 9, lineHeight: 1.3, whiteSpace: "pre-line" }}>{busy ? "…" : "перетащи\nили выбери"}</span>
              <input ref={inputRef} type="file" accept="image/*" multiple hidden
                onChange={e => { if (e.target.files) upload(e.target.files); e.target.value = ""; }} />
            </div>
          )}
        </div>
      )}

      {files.length === 0 && readOnly && <div style={{ ...label, marginTop: 8, color: "#C8C0B0" }}>картинок нет</div>}
      {error && <div style={{ marginTop: 8, fontSize: 11, color: "#8B3A3A" }}>{error}</div>}

      {preview && (
        <div onClick={() => setPreview(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(26,26,26,0.82)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
          <button type="button" onClick={() => setPreview(null)}
            style={{ position: "absolute", top: 20, right: 24, border: "none", background: "transparent", color: "#fff", cursor: "pointer" }}>
            <X size={20} />
          </button>
          <div onClick={e => e.stopPropagation()} style={{ maxWidth: "100%", maxHeight: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
            <img src={mediaApi.fileUrl(preview.id)} alt={preview.title || preview.kind}
              style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain", background: "#fff" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#E8E4DA", fontSize: 11 }}>
              <span style={{ letterSpacing: "0.06em" }}>{mediaKindLabel(preview.kind).toUpperCase()}</span>
              {preview.is_primary ? <span style={{ color: "#E8592A" }}>главный</span> : null}
              {preview.ral && <span>RAL {preview.ral}</span>}
              {preview.width ? <span>{preview.width}×{preview.height}</span> : null}
              {preview.source && <span style={{ color: "#A89070" }}>{preview.source}</span>}
              {!readOnly && (
                <input
                  defaultValue={preview.title || ""} placeholder="подпись"
                  onBlur={e => { if (e.target.value !== (preview.title || "")) patch(preview.id, { title: e.target.value }); }}
                  style={{ border: "1px solid #6B6355", background: "transparent", color: "#fff", fontSize: 11, padding: "3px 6px", outline: "none", marginLeft: "auto" }} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
