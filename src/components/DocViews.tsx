"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { Check, ChevronDown, RotateCcw, Trash2, Wand2, ZoomIn, ZoomOut } from "lucide-react";
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

const PDF_ERRORS = {
  offline: "اینترنت شما قطع است و فایل سند بارگذاری نشد. به‌محض وصل‌شدن اینترنت، خودکار دوباره تلاش می‌شود؛ اطلاعاتی که وارد کرده‌اید حفظ شده است.",
  timeout: "بارگذاری سند بیش از حد طول کشید (اینترنت کند است). «تلاش دوباره» را بزنید؛ اطلاعاتی که وارد کرده‌اید حفظ می‌شود.",
  load: "نمایش فایل ممکن نشد. اتصال اینترنت را بررسی کنید و «تلاش دوباره» را بزنید؛ اطلاعاتی که وارد کرده‌اید حفظ می‌شود.",
} as const;
type PdfErrorKind = keyof typeof PDF_ERRORS;

/** U-11: سقف انتظار واکشی PDF؛ پیش‌تر روی اینترنت قطع/نیمه‌قطع «در حال بارگذاری…» تا ابد می‌ماند */
export const PDF_FETCH_TIMEOUT_MS = 45_000;
/** U-15: گام‌های بزرگ‌نمایی (علاوه بر pinch-zoom مرورگر که حالا هم آزاد است) */
export const PDF_ZOOM_STEPS = [1, 1.5, 2, 3] as const;
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const faPct = (z: number) => `${String(Math.round(z * 100)).replace(/\d/g, (d) => FA_DIGITS[Number(d)])}٪`;

export function PdfPages({ url, pages, overlay, maxWidth = 860, zoomable = true }: { url: string; pages: PageMeta[]; overlay?: (pageIndex: number) => ReactNode; maxWidth?: number; zoomable?: boolean }) {
  // F-13: «تلاش دوباره» فقط خود سند را از نو می‌خواند؛ state والد (فیلدهای جانمایی‌شده/مقادیر واردشده) دست‌نخورده می‌ماند
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState<number>(1);
  // نتیجه با «کلید درخواست» برچسب می‌خورد؛ پس وضعیت بارگذاری/خطا بدون setState همگام در effect از روی کلید مشتق می‌شود
  const [result, setResult] = useState<{ key: string; doc: PdfDoc | null; error: PdfErrorKind | null }>({ key: "", doc: null, error: null });
  const key = `${url}#${attempt}`;
  const cur = result.key === key ? result : null;
  const doc = cur?.doc ?? null;
  const error = cur?.error ?? null;

  useEffect(() => {
    let dead = false;
    let timedOut = false;
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, PDF_FETCH_TIMEOUT_MS);
    (async () => {
      try {
        const [lib, res] = await Promise.all([loadPdfjs(), fetch(url, { credentials: "same-origin", cache: attempt > 0 ? "reload" : "default", signal: ac.signal })]);
        if (!res.ok) throw new Error(String(res.status));
        const data = new Uint8Array(await res.arrayBuffer());
        const d = await lib.getDocument({ data }).promise;
        if (!dead) setResult({ key, doc: d, error: null });
      } catch {
        if (!dead) setResult({ key, doc: null, error: timedOut ? "timeout" : typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "load" });
      } finally {
        window.clearTimeout(timer);
      }
    })();
    return () => {
      dead = true;
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [url, attempt, key]);

  // U-08: با برگشت اینترنت، سند خودکار دوباره خوانده می‌شود (بدون نیاز به لمس دکمه)
  useEffect(() => {
    if (!error) return;
    const retry = () => setAttempt((n) => n + 1);
    window.addEventListener("online", retry, { once: true });
    return () => window.removeEventListener("online", retry);
  }, [error]);

  const zi = PDF_ZOOM_STEPS.indexOf(zoom as (typeof PDF_ZOOM_STEPS)[number]);
  const stepZoom = (d: number) => setZoom(PDF_ZOOM_STEPS[Math.min(PDF_ZOOM_STEPS.length - 1, Math.max(0, (zi < 0 ? 0 : zi) + d))]);

  return (
    <div className="space-y-4" dir="ltr">
      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-center text-xs text-rose-700" dir="rtl">
          <span>{PDF_ERRORS[error]}</span>
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="btn-secondary btn-sm"><RotateCcw size={14} />تلاش دوباره</button>
        </div>
      )}
      {zoomable && doc && (
        <div className="sticky top-2 z-20 flex justify-center" dir="rtl">
          <div role="group" aria-label="بزرگ‌نمایی سند" className="flex items-center gap-1 rounded-full border border-ink/10 bg-white/95 p-1 shadow-md backdrop-blur">
            <button type="button" onClick={() => stepZoom(-1)} disabled={zoom <= PDF_ZOOM_STEPS[0]} aria-label="کوچک‌نمایی" className="grid h-9 w-9 place-items-center rounded-full hover:bg-ink/5 disabled:opacity-35"><ZoomOut size={17} /></button>
            <button type="button" onClick={() => setZoom(1)} aria-label="اندازه‌ی متناسب با صفحه" className="min-w-14 px-1 text-center text-xs font-bold tabular-nums">{faPct(zoom)}</button>
            <button type="button" onClick={() => stepZoom(1)} disabled={zoom >= PDF_ZOOM_STEPS[PDF_ZOOM_STEPS.length - 1]} aria-label="بزرگ‌نمایی" className="grid h-9 w-9 place-items-center rounded-full hover:bg-ink/5 disabled:opacity-35"><ZoomIn size={17} /></button>
          </div>
        </div>
      )}
      <div className={zoom > 1 ? "overflow-x-auto overscroll-x-contain rounded-lg pb-2" : ""} style={zoom > 1 ? { touchAction: "pan-x pan-y pinch-zoom" } : undefined}>
        <div className="space-y-4" style={{ width: `${zoom * 100}%` }}>
          {pages.map((p, i) => (
            <PageCanvas key={`${i}-${zoom}`} doc={doc} index={i} meta={p} maxWidth={maxWidth * zoom} zoom={zoom}>
              {overlay?.(i)}
            </PageCanvas>
          ))}
        </div>
      </div>
    </div>
  );
}

function PageCanvas({ doc, index, meta, maxWidth, zoom, children }: { doc: PdfDoc | null; index: number; meta: PageMeta; maxWidth: number; zoom: number; children?: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [done, setDone] = useState(false);
  const [tries, setTries] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setVisible(true), { rootMargin: "700px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!doc || !visible || done || failed) return;
    let dead = false;
    (async () => {
      const page = await doc.getPage(index + 1);
      const el = canvas.current;
      const w = wrap.current;
      if (!el || !w || dead) return;
      const base = page.getViewport({ scale: 1 });
      const target = Math.min(1800 * Math.min(zoom, 2), Math.max(600, w.clientWidth * Math.min(2, window.devicePixelRatio || 1)));
      const vp = page.getViewport({ scale: target / base.width });
      el.width = Math.floor(vp.width);
      el.height = Math.floor(vp.height);
      const ctx = el.getContext("2d");
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      if (!dead) setDone(true);
    })().catch(() => {
      if (!dead) setFailed(true);
    });
    return () => {
      dead = true;
    };
  }, [doc, visible, done, failed, index, tries, zoom]);

  return (
    <div
      ref={wrap}
      data-page={index}
      className="relative mx-auto w-full select-none overflow-hidden rounded-lg bg-white shadow-md ring-1 ring-black/10"
      style={{ aspectRatio: `${meta.w} / ${meta.h}`, maxWidth, containerType: "inline-size" }}
    >
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
      {!done && !failed && <div className="absolute inset-0 grid place-items-center text-xs text-ink/50" dir="rtl">در حال بارگذاری صفحه {index + 1}…</div>}
      {failed && (
        <div className="absolute inset-0 grid place-items-center bg-white/90 p-3 text-center text-xs text-rose-700" dir="rtl">
          <div>
            <p>نمایش صفحه {index + 1} ممکن نشد.</p>
            <button type="button" className="btn-secondary btn-sm mt-2" onClick={() => { setFailed(false); setTries((n) => n + 1); }}><RotateCcw size={14} />تلاش دوباره</button>
          </div>
        </div>
      )}
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
  // F-15: حین کشیدن/تغییر اندازه فقط استایل همان یک جعبه مستقیم (با rAF) به‌روز می‌شود و state والد فقط «یک بار» هنگام رها کردن
  // ثبت می‌شود؛ پیش‌تر هر pointermove کل آرایه‌ی جانمایی را از نو می‌ساخت و همه‌ی صفحه‌ها/جعبه‌ها را دوباره رندر می‌کرد.
  const drag = useRef<{ i: number; mode: "move" | "resize"; sx: number; sy: number; o: Placement; rect: DOMRect; box: HTMLElement; patch: Partial<Placement> | null; raf: number } | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
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
    const target = e.currentTarget as HTMLElement;
    const box = target.closest("[data-box]") as HTMLElement | null;
    const pageEl = target.closest("[data-page]") as HTMLElement | null;
    if (!pageEl || !box) return;
    target.setPointerCapture(e.pointerId);
    drag.current = { i, mode, sx: e.clientX, sy: e.clientY, o: value[i], rect: pageEl.getBoundingClientRect(), box, patch: null, raf: 0 };
    setSel(i);
  };
  const paintDrag = () => {
    const d = drag.current;
    if (!d) return;
    d.raf = 0;
    const p = { ...d.o, ...d.patch };
    d.box.style.left = `${p.x * 100}%`;
    d.box.style.top = `${p.y * 100}%`;
    d.box.style.width = `${p.w * 100}%`;
    d.box.style.height = `${p.h * 100}%`;
  };
  const move = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    const dx = (e.clientX - d.sx) / d.rect.width;
    const dy = (e.clientY - d.sy) / d.rect.height;
    d.patch = d.mode === "move"
      ? { x: clamp(d.o.x + dx, 0, 1 - d.o.w), y: clamp(d.o.y + dy, 0, 1 - d.o.h) }
      : { w: clamp(d.o.w + dx, 0.02, 1 - d.o.x), h: clamp(d.o.h + dy, 0.012, 1 - d.o.y) };
    if (!d.raf) d.raf = requestAnimationFrame(paintDrag);
  };
  const up = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    if (d.raf) cancelAnimationFrame(d.raf);
    drag.current = null;
    if (d.patch) update(d.i, d.patch); // تنها نقطه‌ی ثبت در state والد
  };

  const selected = sel !== null ? value[sel] : null;
  const counts = signers.map((s) => ({ ...s, n: value.filter((p) => p.signerPosition === s.pos && p.kind === "signature").length }));

  return (
    <div className="space-y-3">
      {/* F-12: در موبایل نوار ابزار «یک‌خطی و کشویی» است (ردیف‌ها افقی اسکرول می‌شوند، شمارنده‌ها پشت دکمه‌ی جمع‌شونده)،
          و ویرایشگر فیلد انتخاب‌شده به‌صورت نوار پایینی شناور می‌آید؛ پس سند همیشه بیشترِ صفحه را دارد. */}
      <div className="panel-solid sticky top-2 z-20 space-y-2 p-2.5 sm:space-y-3 sm:p-4" dir="rtl">
        <div className="no-scrollbar -mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-0.5 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
          <span className="shrink-0 text-xs font-bold text-ink/70">فیلد برای:</span>
          {signers.map((s) => (
            <button key={s.pos} type="button" onClick={() => setSigner(s.pos)} className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-bold transition sm:py-1 ${signer === s.pos ? "text-white" : "bg-white"}`} style={{ borderColor: colorOf(s.pos), background: signer === s.pos ? colorOf(s.pos) : undefined, color: signer === s.pos ? "#fff" : colorOf(s.pos) }}>
              {s.label}
            </button>
          ))}
          <button type="button" onClick={autoPlace} className="btn-secondary btn-sm shrink-0 whitespace-nowrap sm:mr-auto"><Wand2 size={14} />جای امضا را خودکار بگذار</button>
        </div>
        <div className="no-scrollbar -mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-0.5 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
          <span className="shrink-0 text-xs font-bold text-ink/70">سپس روی صفحه کلیک کنید:</span>
          {allowed.map((k) => (
            <button key={k.id} type="button" title={k.hint} aria-pressed={tool === k.id} onClick={() => setTool(tool === k.id ? null : k.id)} className={`shrink-0 whitespace-nowrap rounded-xl border px-3 py-1.5 text-xs font-bold transition ${tool === k.id ? "border-ink bg-ink text-white" : "border-ink/15 bg-white hover:border-ink/40"}`}>
              {k.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setToolsOpen((o) => !o)} aria-expanded={toolsOpen} aria-controls="placer-counts" className="flex w-full items-center justify-between gap-2 rounded-lg bg-stone-50 px-3 py-1.5 text-[11px] font-bold text-ink/75 sm:hidden">
          <span>{counts.filter((c) => c.n).length.toLocaleString("fa-IR")} از {counts.length.toLocaleString("fa-IR")} امضاکننده جای امضا دارند</span>
          <ChevronDown size={14} className={`transition ${toolsOpen ? "rotate-180" : ""}`} />
        </button>
        <div id="placer-counts" className={`${toolsOpen ? "flex" : "hidden"} flex-wrap gap-2 text-[11px] text-ink/70 sm:flex`}>
          {counts.map((c) => (
            <span key={c.pos} className={`rounded-full px-2 py-0.5 ${c.n ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{c.label}: {c.n ? `${c.n} جای امضا` : "هنوز جای امضا ندارد"}</span>
          ))}
        </div>
        {selected && sel !== null && (
          <div className="fixed inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-30 flex flex-wrap items-center gap-2 rounded-2xl border border-ink/10 bg-white p-3 text-xs shadow-2xl sm:static sm:gap-3 sm:rounded-xl sm:border-0 sm:bg-stone-50 sm:p-2.5 sm:shadow-none" role="group" aria-label="ویرایش فیلد انتخاب‌شده">
            <b>{KIND_LABEL[selected.kind]}</b>
            {(selected.kind === "text" || selected.kind === "checkbox") && (
              <input value={selected.label} onChange={(e) => update(sel, { label: e.target.value.slice(0, 60) })} placeholder={selected.kind === "text" ? "عنوان فیلد (مثلاً کد ملی)" : "متن تیک (مثلاً قوانین را می‌پذیرم)"} className="input !min-h-[34px] !py-1 text-xs max-sm:w-full sm:w-64" />
            )}
            {selected.kind !== "signature" && (
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={selected.required} onChange={(e) => update(sel, { required: e.target.checked })} />اجباری</label>
            )}
            <select aria-label="امضاکننده‌ی این فیلد" value={selected.signerPosition} onChange={(e) => update(sel, { signerPosition: Number(e.target.value) })} className="input !min-h-[34px] !w-auto !py-1 text-xs">
              {signers.map((s) => <option key={s.pos} value={s.pos}>{s.label}</option>)}
            </select>
            <button type="button" onClick={() => setSel(null)} className="btn-secondary btn-sm mr-auto sm:hidden">بستن</button>
            <button type="button" onClick={() => { onChange(value.filter((_, k) => k !== sel)); setSel(null); }} className="btn-danger btn-sm sm:mr-auto"><Trash2 size={14} />حذف</button>
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
                  data-box
                  onPointerDown={(e) => down(e, i, "move")}
                  onPointerMove={move}
                  onPointerUp={up}
                  onPointerCancel={up}
                  className={`absolute flex cursor-move touch-none items-center justify-center overflow-hidden rounded border-2 text-center leading-none ${sel === i ? "shadow-lg ring-2 ring-white" : ""}`}
                  style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%`, borderColor: colorOf(p.signerPosition), background: `${colorOf(p.signerPosition)}22`, color: colorOf(p.signerPosition), fontSize: "clamp(8px, 2.2cqw, 13px)" }}
                  dir="rtl"
                >
                  <span className="pointer-events-none px-1 font-bold">{KIND_LABEL[p.kind]}{p.label ? `: ${p.label}` : ""}</span>
                  <span
                    onPointerDown={(e) => down(e, i, "resize")}
                    onPointerMove={move}
                    onPointerUp={up}
                    onPointerCancel={up}
                    className="absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize touch-none rounded-tl bg-current opacity-70 sm:h-3.5 sm:w-3.5"
                  />
                </div>
              ),
            )}
          </div>
        )}
      />
      {selected && <div className="h-28 sm:hidden" aria-hidden="true" />}
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
