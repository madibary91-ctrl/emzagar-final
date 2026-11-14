"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, PenLine, RotateCcw, Trash2, Upload } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
export type SignatureMethod = "draw" | "upload";

type Point = { x: number; y: number; time: number; pressure: number };
type Stroke = { color: string; width: number; points: Point[] };

export function SignatureCapture({ onChange }: { onChange: (data: string | null, method: SignatureMethod) => void }) {
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);
  const drawingRef = useRef(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [method, setMethod] = useState<SignatureMethod>("draw");
  const [color, setColor] = useState("#142f42");
  const [width, setWidth] = useState(3);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState("");

  /** اندازه‌ی منطقی (CSS px) و نسبت پیکسل بوم فعلی؛ تنها منبع حقیقت برای رسم و تبدیل مختصات */
  const sizeRef = useRef({ w: 0, h: 0, ratio: 1 });

  const paint = useCallback((items: Stroke[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h, ratio } = sizeRef.current;
    if (!w || !h) return; // بوم هنوز دیده/اندازه‌گیری نشده (مثلاً مخفی است)
    // تبدیل را در هر رسم صریحاً می‌گذاریم تا هیچ‌گاه به حالت قبلیِ بوم وابسته نباشد
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const stroke of items) {
      const points = stroke.points;
      if (!points.length) continue;
      ctx.strokeStyle = stroke.color;
      ctx.fillStyle = stroke.color;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (points.length === 1) {
        ctx.beginPath();
        ctx.arc(points[0].x * w, points[0].y * h, stroke.width / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      for (let i = 1; i < points.length; i++) {
        const previous = points[i - 1];
        const point = points[i];
        const distance = Math.hypot((point.x - previous.x) * w, (point.y - previous.y) * h);
        const elapsed = Math.max(1, point.time - previous.time);
        const speed = distance / elapsed;
        const pressure = point.pressure > 0 && point.pressure !== .5 ? .65 + point.pressure * .6 : 1;
        ctx.lineWidth = Math.max(.7, stroke.width * pressure * Math.min(1.18, Math.max(.55, 1.12 - speed * .12)));
        const x1 = previous.x * w, y1 = previous.y * h, x2 = point.x * w, y2 = point.y * h;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        if (i < points.length - 1) {
          const next = points[i + 1];
          ctx.quadraticCurveTo(x2, y2, (x2 + next.x * w) / 2, (y2 + next.y * h) / 2);
        } else ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }
  }, []);

  // هر بار که عنصر بوم ساخته می‌شود (اولین بار، یا بعد از برگشت از «آپلود امضا») باید بیت‌مپ آن هم‌اندازه‌ی
  // کادر نمایش شود؛ وگرنه بوم روی اندازه‌ی پیش‌فرض ۳۰۰×۱۵۰ می‌ماند و خطوط به گوشه‌ی پایین‌راست می‌روند.
  useEffect(() => {
    if (method !== "draw") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      // اندازه‌ی چیدمان (بدون اثر transform/انیمیشن والد)؛ در صورت نبودن، rect
      const rect = canvas.getBoundingClientRect();
      const w = canvas.clientWidth || rect.width;
      const h = canvas.clientHeight || rect.height;
      if (!w || !h) return;
      const ratio = Math.min(3, window.devicePixelRatio || 1);
      const bw = Math.round(w * ratio);
      const bh = Math.round(h * ratio);
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      sizeRef.current = { w, h, ratio: bw / w };
      paint(currentRef.current ? [...strokesRef.current, currentRef.current] : strokesRef.current);
    };
    resize();
    // برگشت از «آپلود»: ضربه‌های قبلی دوباره روی بوم‌ِ تازه رسم شده‌اند؛ مقدار امضا را هم به والد برگردان
    if (strokesRef.current.length && sizeRef.current.w) onChangeRef.current(canvas.toDataURL("image/png"), "draw");
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    // تغییر زوم/جابه‌جایی پنجره میان نمایشگرها، نسبت پیکسل را بدون تغییر اندازه عوض می‌کند
    let mq: MediaQueryList | null = null;
    const watchDpr = () => {
      mq?.removeEventListener("change", onDpr);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener("change", onDpr);
    };
    const onDpr = () => { resize(); watchDpr(); };
    watchDpr();
    return () => {
      observer.disconnect();
      mq?.removeEventListener("change", onDpr);
    };
  }, [paint, method]);

  function pointFrom(event: ReactPointerEvent<HTMLCanvasElement>): Point {
    // مختصات نسبی (۰..۱) نسبت به کادر واقعی نمایش بوم؛ مستقل از زوم، DPR و transform والد
    const rect = event.currentTarget.getBoundingClientRect();
    const x = rect.width ? (event.clientX - rect.left) / rect.width : 0;
    const y = rect.height ? (event.clientY - rect.top) / rect.height : 0;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), time: performance.now(), pressure: event.pressure };
  }

  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (method !== "draw") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    currentRef.current = { color, width, points: [pointFrom(event)] };
    paint([...strokesRef.current, currentRef.current]);
  }

  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || !currentRef.current) return;
    event.preventDefault();
    currentRef.current.points.push(pointFrom(event));
    paint([...strokesRef.current, currentRef.current]);
  }

  function pointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || !currentRef.current) return;
    const next = [...strokesRef.current, currentRef.current];
    strokesRef.current = next;
    setStrokes(next);
    currentRef.current = null;
    drawingRef.current = false;
    paint(next);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onChange(event.currentTarget.toDataURL("image/png"), "draw");
  }

  function updateStrokes(next: Stroke[]) {
    strokesRef.current = next;
    setStrokes(next);
    paint(next);
    onChange(next.length && canvasRef.current ? canvasRef.current.toDataURL("image/png") : null, "draw");
  }

  function switchMethod(next: SignatureMethod) {
    setMethod(next);
    setUploadError("");
    onChange(next === "upload" ? uploaded : strokesRef.current.length && canvasRef.current ? canvasRef.current.toDataURL("image/png") : null, next);
  }

  function upload(file?: File) {
    if (!file) return;
    setUploadError("");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return setUploadError("فقط تصویر PNG، JPG یا WebP پذیرفته می‌شود.");
    if (file.size > 3 * 1024 * 1024) return setUploadError("حجم تصویر باید کمتر از ۳ مگابایت باشد.");
    // بک‌اند فقط PNG می‌پذیرد: تصویر روی بوم سفید ترسیم و به PNG تبدیل می‌شود
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const W = 800, H = 300;
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const ctx = c.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(url); return setUploadError("خواندن تصویر ناموفق بود."); }
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
      const k = Math.min(W / img.width, H / img.height);
      const w = img.width * k, h = img.height * k;
      ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
      const data = c.toDataURL("image/png");
      URL.revokeObjectURL(url);
      setUploaded(data);
      onChange(data, "upload");
    };
    img.onerror = () => { URL.revokeObjectURL(url); setUploadError("خواندن تصویر ناموفق بود."); };
    img.src = url;
  }

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 rounded-2xl bg-stone-100 p-1.5">
        <button type="button" onClick={() => switchMethod("draw")} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl text-xs font-bold transition ${method === "draw" ? "bg-white text-ink shadow-sm" : "text-ink/72"}`}><PenLine size={16} />ترسیم امضا</button>
        <button type="button" onClick={() => switchMethod("upload")} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl text-xs font-bold transition ${method === "upload" ? "bg-white text-ink shadow-sm" : "text-ink/72"}`}><ImagePlus size={16} />آپلود امضا</button>
      </div>
      {method === "draw" ? (
        <>
          <div className="relative overflow-hidden rounded-2xl border border-dashed border-ink/20 bg-[#fafbf8]">
            <canvas ref={canvasRef} className="signature-canvas" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} aria-label="بوم ترسیم امضا؛ با ماوس یا انگشت امضا کنید" />
            {!strokes.length && <div className="pointer-events-none absolute inset-0 grid place-items-center text-center"><div><PenLine size={25} className="mx-auto text-ink/15" /><p className="mt-2 text-xs text-ink/72">امضای خود را اینجا ترسیم کنید</p></div></div>}
            <div className="pointer-events-none absolute bottom-8 left-10 right-10 border-b border-dashed border-ink/10" />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex gap-1.5" aria-label="رنگ قلم">{["#142f42", "#101010", "#244f9a"].map((item) => <button key={item} type="button" aria-label={`رنگ ${item}`} onClick={() => setColor(item)} className={`h-6 w-6 rounded-full border-2 transition ${color === item ? "scale-110 border-mint" : "border-white"}`} style={{ background: item, boxShadow: "0 0 0 1px rgba(16,44,49,.12)" }} />)}</div>
              <label className="flex items-center gap-2 text-xs text-ink/72">ضخامت<input aria-label="ضخامت قلم" type="range" min="1.5" max="6" step=".5" value={width} onChange={(e) => setWidth(Number(e.target.value))} className="w-20 accent-[#102c31]" /></label>
            </div>
            <div className="flex gap-1"><button type="button" className="btn-ghost !min-h-9 !px-3 !text-xs" disabled={!strokes.length} onClick={() => updateStrokes(strokes.slice(0, -1))}><RotateCcw size={14} />لغو ضربه</button><button type="button" className="btn-ghost !min-h-9 !px-3 !text-xs text-rose-600" disabled={!strokes.length} onClick={() => updateStrokes([])}><Trash2 size={14} />پاک‌سازی</button></div>
          </div>
        </>
      ) : (
        <div>
          <label className="flex min-h-[240px] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed border-ink/20 bg-[#fafbf8] p-6 text-center transition hover:border-emerald-500 hover:bg-emerald-50/30">
            {uploaded ? <img src={uploaded} alt="پیش‌نمایش امضای آپلودشده" className="max-h-44 max-w-full object-contain mix-blend-multiply" /> : <><span className="grid h-12 w-12 place-items-center rounded-2xl bg-white shadow-sm"><Upload size={21} /></span><b className="mt-4 text-xs">تصویر امضا را انتخاب کنید</b><span className="mt-2 text-xs text-ink/72">PNG، JPG یا WebP • حداکثر ۳ مگابایت</span></>}
            <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => upload(e.target.files?.[0])} />
          </label>
          {uploaded && <button type="button" className="btn-ghost mt-2 !min-h-9 !px-3 !text-xs text-rose-600" onClick={() => { setUploaded(null); onChange(null, "upload"); }}><Trash2 size={14} />حذف تصویر</button>}
        </div>
      )}
      {uploadError && <p className="mt-2 text-xs text-rose-600">{uploadError}</p>}
    </div>
  );
}
