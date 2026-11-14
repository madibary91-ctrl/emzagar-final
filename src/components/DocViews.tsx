"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { Check, Trash2, Wand2 } from "lucide-react";
import { FIELD_KINDS, KIND_LABEL, SIGNER_COLORS, type FieldKind, type PageMeta, type Placement } from "@/modules/docs/placement";

/* ═════════════ نمایش صفحه‌های PDF با pdf.js (بارگذاری از /pdfjs؛ بدون باندل‌شدن در برنامه) ═════════════ */

type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPage> };
type PdfPage = { getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> } };
type PdfLib = { GlobalWorkerOptions: { workerSrc: string }; getDocument: (o: { data: Uint8Array }) => { promise: Promise<PdfDoc>; destroy?: () => void } };

let libPromise: Promise<PdfLib> | null = null;
function loadPdfjs(): Promise<PdfLib> {
  if (!libPromise) {
    const url = "/pdfjs/pdf.min.mjs";
    libPromise = import(/* webpackIgnore: true */ url).then((m: PdfLib) => {
      m.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
      return m;
    });
    libPromise.catch(() => (libPromise = null));
  }
  return libPromise;
}

export function PdfPages({ url, pages, overlay, maxWidth = 860 }: { url: string; pages: PageMeta[]; overlay?: (pageIndex: number) => ReactNode; maxWidth?: number }) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let dead = false;
    setError("");
    (async () => {
      try {
        const [lib, res] = await Promise.all([loadPdfjs(), fetch(url, { credentials: "same-origin" })]);
        if (!res.ok) throw new Error(String(res.status));
        const data = new Uint8Array(await res.arrayBuffer());
        const d = await lib.getDocument({ data }).promise;
        if (!dead) setDoc(d);
      } catch {
        if (!dead) setError("نمایش فایل ممکن نشد. صفحه را دوباره باز کنید یا فایل دیگری بارگذاری کنید.");
      }
    })();
    return () => {
      dead = true;
    };
  }, [url]);

  return (
    <div className="space-y-4" dir="ltr">
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-center text-xs text-rose-700" dir="rtl">{error}</p>}
      {pages.map((p, i) => (
        <PageCanvas key={i} doc={doc} index={i} meta={p} maxWidth={maxWidth}>
          {overlay?.(i)}
        </PageCanvas>
      ))}
    </div>
  );
}

function PageCanvas({ doc, index, meta, maxWidth, children }: { doc: PdfDoc | null; index: number; meta: PageMeta; maxWidth: number; children?: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setVisible(true), { rootMargin: "700px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!doc || !visible || done) return;
    let dead = false;
    (async () => {
      const page = await doc.getPage(index + 1);
      const el = canvas.current;
      const w = wrap.current;
      if (!el || !w || dead) return;
      const base = page.getViewport({ scale: 1 });
      const target = Math.min(1800, Math.max(600, w.clientWidth * Math.min(2, window.devicePixelRatio || 1)));
      const vp = page.getViewport({ scale: target / base.width });
      el.width = Math.floor(vp.width);
      el.height = Math.floor(vp.height);
      const ctx = el.getContext("2d");
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      if (!dead) setDone(true);
    })().catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [doc, visible, done, index]);

  return (
    <div
      ref={wrap}
      data-page={index}
      className="relative mx-auto w-full select-none overflow-hidden rounded-lg bg-white shadow-md ring-1 ring-black/10"
      style={{ aspectRatio: `${meta.w} / ${meta.h}`, maxWidth, containerType: "inline-size" }}
    >
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
      {!done && <div className="absolute inset-0 grid place-items-center text-xs text-ink/50" dir="rtl">در حال بارگذاری صفحه {index + 1}…</div>}
      <span className="absolute left-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] text-white">{index + 1}</span>
      {children}
    </div>
  );
}

/* ═════════════ ویرایشگر جانمایی (کشیدن، تغییر اندازه، حذف) ═════════════ */

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

export interface PlacerSigner {
  pos: number;
  label: string;
}

export function DocPlacer({ url, pages, signers, value, onChange, kinds }: { url: string; pages: PageMeta[]; signers: PlacerSigner[]; value: Placement[]; onChange: (v: Placement[]) => void; kinds?: FieldKind[] }) {
  const [tool, setTool] = useState<FieldKind | null>("signature");
  const [signer, setSigner] = useState(signers[0]?.pos ?? 1);
  const [sel, setSel] = useState<number | null>(null);
  const drag = useRef<{ i: number; mode: "move" | "resize"; sx: number; sy: number; o: Placement; rect: DOMRect } | null>(null);
  const colorOf = (pos: number) => SIGNER_COLORS[(pos - 1) % SIGNER_COLORS.length];
  const allowed = FIELD_KINDS.filter((k) => !kinds || kinds.includes(k.id));

  const update = useCallback((i: number, patch: Partial<Placement>) => onChange(value.map((p, k) => (k === i ? { ...p, ...patch } : p))), [value, onChange]);

  const addAt = (page: number, e: RPointerEvent<HTMLDivElement>) => {
    if (!tool) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const def = FIELD_KINDS.find((k) => k.id === tool)!;
    const m = pages[page];
    const w = def.w / m.w;
    const h = def.h / m.h;
    const x = clamp((e.clientX - rect.left) / rect.width - w / 2, 0, 1 - w);
    const y = clamp((e.clientY - rect.top) / rect.height - h / 2, 0, 1 - h);
    onChange([...value, { signerPosition: signer, kind: tool, label: tool === "text" ? "" : "", page: page + 1, x, y, w, h, required: true }]);
    setSel(value.length);
    if (tool !== "signature") setTool(null);
  };

  const autoPlace = () => {
    const last = pages.length - 1;
    const m = pages[last];
    const next = value.filter((p) => !(p.kind === "signature" && p.page === last + 1));
    const sw = FIELD_KINDS[0].w / m.w;
    const sh = FIELD_KINDS[0].h / m.h;
    const n = signers.length;
    signers.forEach((s, idx) => {
      const x = clamp(0.06 + (idx * (1 - 0.12)) / n, 0, 1 - sw);
      next.push({ signerPosition: s.pos, kind: "signature", label: "", page: last + 1, x, y: clamp(0.86, 0, 1 - sh), w: sw, h: sh, required: true });
    });
    onChange(next);
    setSel(null);
  };

  const down = (e: RPointerEvent<HTMLElement>, i: number, mode: "move" | "resize") => {
    e.stopPropagation();
    const pageEl = (e.currentTarget as HTMLElement).closest("[data-page]") as HTMLElement | null;
    if (!pageEl) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { i, mode, sx: e.clientX, sy: e.clientY, o: value[i], rect: pageEl.getBoundingClientRect() };
    setSel(i);
  };
  const move = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / d.rect.width;
    const dy = (e.clientY - d.sy) / d.rect.height;
    if (d.mode === "move") update(d.i, { x: clamp(d.o.x + dx, 0, 1 - d.o.w), y: clamp(d.o.y + dy, 0, 1 - d.o.h) });
    else update(d.i, { w: clamp(d.o.w + dx, 0.02, 1 - d.o.x), h: clamp(d.o.h + dy, 0.012, 1 - d.o.y) });
  };
  const up = () => {
    drag.current = null;
  };

  const selected = sel !== null ? value[sel] : null;
  const counts = signers.map((s) => ({ ...s, n: value.filter((p) => p.signerPosition === s.pos && p.kind === "signature").length }));

  return (
    <div className="space-y-3">
      <div className="panel-solid sticky top-2 z-20 space-y-3 p-3 sm:p-4" dir="rtl">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-ink/70">فیلد برای:</span>
          {signers.map((s) => (
            <button key={s.pos} type="button" onClick={() => setSigner(s.pos)} className={`rounded-full border px-3 py-1 text-xs font-bold transition ${signer === s.pos ? "text-white" : "bg-white"}`} style={{ borderColor: colorOf(s.pos), background: signer === s.pos ? colorOf(s.pos) : undefined, color: signer === s.pos ? "#fff" : colorOf(s.pos) }}>
              {s.label}
            </button>
          ))}
          <button type="button" onClick={autoPlace} className="btn-secondary btn-sm mr-auto"><Wand2 size={14} />جای امضا را خودکار بگذار</button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-ink/70">سپس روی صفحه کلیک کنید:</span>
          {allowed.map((k) => (
            <button key={k.id} type="button" title={k.hint} onClick={() => setTool(tool === k.id ? null : k.id)} className={`rounded-xl border px-3 py-1.5 text-xs font-bold transition ${tool === k.id ? "border-ink bg-ink text-white" : "border-ink/15 bg-white hover:border-ink/40"}`}>
              {k.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 text-[11px] text-ink/70">
          {counts.map((c) => (
            <span key={c.pos} className={`rounded-full px-2 py-0.5 ${c.n ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{c.label}: {c.n ? `${c.n} جای امضا` : "هنوز جای امضا ندارد"}</span>
          ))}
        </div>
        {selected && sel !== null && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-stone-50 p-2.5 text-xs">
            <b>{KIND_LABEL[selected.kind]}</b>
            {(selected.kind === "text" || selected.kind === "checkbox") && (
              <input value={selected.label} onChange={(e) => update(sel, { label: e.target.value.slice(0, 60) })} placeholder={selected.kind === "text" ? "عنوان فیلد (مثلاً کد ملی)" : "متن تیک (مثلاً قوانین را می‌پذیرم)"} className="input !min-h-[34px] !py-1 text-xs sm:w-64" />
            )}
            {selected.kind !== "signature" && (
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={selected.required} onChange={(e) => update(sel, { required: e.target.checked })} />اجباری</label>
            )}
            <select value={selected.signerPosition} onChange={(e) => update(sel, { signerPosition: Number(e.target.value) })} className="input !min-h-[34px] !w-auto !py-1 text-xs">
              {signers.map((s) => <option key={s.pos} value={s.pos}>{s.label}</option>)}
            </select>
            <button type="button" onClick={() => { onChange(value.filter((_, k) => k !== sel)); setSel(null); }} className="btn-danger btn-sm mr-auto"><Trash2 size={14} />حذف</button>
          </div>
        )}
      </div>

      <PdfPages
        url={url}
        pages={pages}
        overlay={(pi) => (
          <div className={`absolute inset-0 ${tool ? "cursor-crosshair" : ""}`} onPointerDown={(e) => { if (e.target === e.currentTarget) { if (tool) addAt(pi, e); else setSel(null); } }}>
            {value.map((p, i) =>
              p.page !== pi + 1 ? null : (
                <div
                  key={i}
                  onPointerDown={(e) => down(e, i, "move")}
                  onPointerMove={move}
                  onPointerUp={up}
                  className={`absolute flex cursor-move touch-none items-center justify-center overflow-hidden rounded border-2 text-center leading-none ${sel === i ? "shadow-lg ring-2 ring-white" : ""}`}
                  style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%`, borderColor: colorOf(p.signerPosition), background: `${colorOf(p.signerPosition)}22`, color: colorOf(p.signerPosition), fontSize: "clamp(8px, 2.2cqw, 13px)" }}
                  dir="rtl"
                >
                  <span className="pointer-events-none px-1 font-bold">{KIND_LABEL[p.kind]}{p.label ? `: ${p.label}` : ""}</span>
                  <span
                    onPointerDown={(e) => down(e, i, "resize")}
                    onPointerMove={move}
                    onPointerUp={up}
                    className="absolute bottom-0 right-0 h-3.5 w-3.5 cursor-nwse-resize touch-none rounded-tl bg-current opacity-70"
                  />
                </div>
              ),
            )}
          </div>
        )}
      />
    </div>
  );
}

/* ═════════════ نمایش برای امضاکننده: فیلدها روی خود صفحه پر می‌شوند ═════════════ */

export interface FillField {
  key: string;
  kind: FieldKind;
  label: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
  mine: boolean;
  signerLabel: string;
  /** پیش‌نمایش تصویر امضای نفر قبلی (در صورت وجود) */
  signed?: boolean;
}

export function DocFill({ url, pages, fields, values, onChange, signature, signerName }: { url: string; pages: PageMeta[]; fields: FillField[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void; signature: string | null; signerName: string }) {
  const set = (k: string, v: string) => onChange({ ...values, [k]: v });
  return (
    <PdfPages
      url={url}
      pages={pages}
      overlay={(pi) => (
        <div className="absolute inset-0" dir="rtl">
          {fields.filter((f) => f.page === pi + 1).map((f) => {
            const box = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
            const fs = `${((f.h * pages[pi].h) / pages[pi].w) * 52}cqw`;
            if (!f.mine) {
              return (
                <div key={f.key} className="absolute grid place-items-center rounded border border-dashed border-ink/30 bg-ink/5 text-center text-ink/50" style={{ ...box, fontSize: "clamp(7px,1.8cqw,11px)" }}>
                  {f.kind === "signature" ? `امضای ${f.signerLabel}` : f.label || f.signerLabel}
                </div>
              );
            }
            if (f.kind === "signature") {
              return (
                <div key={f.key} className={`absolute grid place-items-center rounded border-2 ${signature ? "border-emerald-500/60 bg-emerald-50/30" : "animate-pulse border-dashed border-amber-500 bg-amber-100/60"}`} style={box}>
                  {signature ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={signature} alt="امضای شما" className="max-h-full max-w-full object-contain" /> : <span className="text-center font-bold text-amber-700" style={{ fontSize: "clamp(8px,2cqw,12px)" }}>اینجا امضا می‌شود ↓</span>}
                </div>
              );
            }
            if (f.kind === "name" || f.kind === "date") {
              return (
                <div key={f.key} className="absolute grid place-items-center overflow-hidden rounded border border-emerald-500/40 bg-emerald-50/50 px-1 text-emerald-800" style={{ ...box, fontSize: fs }}>
                  {f.kind === "name" ? signerName : "تاریخ امروز (خودکار)"}
                </div>
              );
            }
            if (f.kind === "checkbox") {
              const on = values[f.key] === "1";
              return (
                <button key={f.key} type="button" onClick={() => set(f.key, on ? "" : "1")} title={f.label} aria-label={f.label || "تیک تأیید"} aria-pressed={on} className={`absolute grid place-items-center rounded border-2 ${on ? "border-emerald-600 bg-emerald-100 text-emerald-700" : "border-amber-500 bg-amber-50 text-transparent"}`} style={box}>
                  <Check style={{ width: "80%", height: "80%" }} />
                </button>
              );
            }
            return (
              <input key={f.key} value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value.slice(0, 200))} placeholder={f.label || "متن"} aria-label={f.label || "متن"} className="absolute rounded border-2 border-amber-500 bg-amber-50/80 px-1 text-ink outline-none placeholder:text-ink/40 focus:border-emerald-600 focus:bg-white" style={{ ...box, fontSize: fs }} />
            );
          })}
        </div>
      )}
    />
  );
}
