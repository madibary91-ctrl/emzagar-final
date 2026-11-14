"use client";

import { useRef, useState } from "react";
import { BadgeCheck, ImagePlus, RotateCcw, Stamp, Trash2, Wand2 } from "lucide-react";
import { SignatureCapture } from "@/components/SignatureCapture";

/**
 * مرحله‌ی «مهر شرکتی» و «پاراف» در صفحه‌ی امضا.
 *  - مهر: آپلود عکس/اسکن (JPG/PNG/WebP) ← تبدیل خودکار به PNG شفاف (با حذف پس‌زمینه‌ی سفید) ← یا «ساخت مهر متنی» با نام شرکت
 *  - پاراف: ترسیم یک‌بار؛ روی «همه‌ی صفحات» سند درج می‌شود
 * مقدارها data URL از نوع PNG هستند؛ اعتبار نهایی را سرور می‌سنجد.
 */
export interface EvidenceValue {
  seal: string | null;
  initials: string | null;
}

export interface EvidenceNeeds {
  /** مهر الزامی است */
  sealRequired: boolean;
  /** امضاکننده‌ی حقوقی است (مهر اختیاری مجاز) */
  legal: boolean;
  initialsRequired: boolean;
  companyName?: string;
  companyNationalId?: string;
  /** آخرین مهر/پاراف همین کاربر (فقط در مسیر حساب کاربری) */
  savedSeal?: string | null;
  savedInitials?: string | null;
}

const MAX_B64 = 600_000;

function fitPng(canvas: HTMLCanvasElement): string {
  let c = canvas;
  let data = c.toDataURL("image/png");
  // کوچک‌کردن تدریجی تا زیر سقف حجم (سرور: ۷۰۰ کیلوبایت)
  while (data.length > MAX_B64 && c.width > 120) {
    const n = document.createElement("canvas");
    n.width = Math.round(c.width * 0.8);
    n.height = Math.round(c.height * 0.8);
    n.getContext("2d")?.drawImage(c, 0, 0, n.width, n.height);
    c = n;
    data = c.toDataURL("image/png");
  }
  return data;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

/** ساخت مهر متنی دایره‌ای (برای شرکت‌هایی که فایل مهر ندارند) */
function generateSeal(name: string, nationalId: string): string {
  const S = 480;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  const ink = "#1e3a8a";
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2 - 8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2 - 34, 0, Math.PI * 2);
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.direction = "rtl";
  ctx.font = "700 40px Vazirmatn, Tahoma, sans-serif";
  const lines = wrap(ctx, name, S - 150);
  const lh = 52;
  const top = S / 2 - ((lines.length - 1) * lh) / 2 - 18;
  lines.forEach((l, i) => ctx.fillText(l, S / 2, top + i * lh));
  ctx.font = "500 24px Vazirmatn, Tahoma, sans-serif";
  if (nationalId) ctx.fillText(`شناسه ملی: ${nationalId}`, S / 2, S / 2 + 70);
  ctx.font = "700 26px Vazirmatn, Tahoma, sans-serif";
  ctx.fillText("مهر شرکت", S / 2, S - 92);
  return fitPng(c);
}

export default function EvidenceStep({ needs, onChange }: { needs: EvidenceNeeds; onChange: (v: EvidenceValue) => void }) {
  const [seal, setSealState] = useState<string | null>(null);
  const [initials, setInitialsState] = useState<string | null>(null);
  const [removeBg, setRemoveBg] = useState(true);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const lastFile = useRef<File | null>(null);
  const value = useRef<EvidenceValue>({ seal: null, initials: null });

  const emit = (patch: Partial<EvidenceValue>) => {
    value.current = { ...value.current, ...patch };
    onChange(value.current);
  };
  const setSeal = (v: string | null) => {
    setSealState(v);
    emit({ seal: v });
  };

  const processFile = (file: File, bgOff: boolean) => {
    setErr("");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return setErr("فقط تصویر PNG، JPG یا WebP پذیرفته می‌شود.");
    if (file.size > 5 * 1024 * 1024) return setErr("حجم تصویر مهر باید کمتر از ۵ مگابایت باشد.");
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 520 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(40, Math.round(img.width * k));
      c.height = Math.max(40, Math.round(img.height * k));
      const ctx = c.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        return setErr("خواندن تصویر ناموفق بود.");
      }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      if (bgOff) {
        // پس‌زمینه‌ی سفید اسکن شفاف می‌شود تا مهر روی متن بنشیند، نه یک مستطیل سفید
        const d = ctx.getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < d.data.length; i += 4) {
          const m = Math.min(d.data[i], d.data[i + 1], d.data[i + 2]);
          if (m > 225) d.data[i + 3] = 0;
          else if (m > 180) d.data[i + 3] = Math.round(((225 - m) / 45) * d.data[i + 3]);
        }
        ctx.putImageData(d, 0, 0);
      }
      URL.revokeObjectURL(url);
      setSeal(fitPng(c));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setErr("خواندن تصویر ناموفق بود.");
    };
    img.src = url;
  };

  const showSeal = needs.sealRequired || needs.legal;

  return (
    <div className="space-y-4">
      {showSeal && (
        <section className="rounded-2xl border border-ink/10 bg-white p-5" aria-label="مهر شرکتی">
          <div className="mb-3 flex items-center gap-2 text-sm font-black">
            <Stamp size={18} className="text-blue-800" />
            مهر شرکتی{needs.companyName ? ` — ${needs.companyName}` : ""}
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${needs.sealRequired ? "bg-rose-50 text-rose-700" : "bg-stone-100 text-ink/70"}`}>{needs.sealRequired ? "الزامی" : "اختیاری"}</span>
          </div>
          <p className="mb-3 text-xs leading-7 text-ink/72">مهر رسمی شرکت را (عکس یا اسکن) بارگذاری کنید؛ کنار امضای شما روی سند و شناسنامه‌ی دیجیتال درج می‌شود و در اثر انگشت سند ثبت می‌گردد.</p>

          {seal ? (
            <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-stone-50 p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={seal} alt="پیش‌نمایش مهر شرکتی" className="h-24 w-24 rounded-xl border border-ink/10 bg-white object-contain p-1" />
              <div className="flex flex-1 flex-wrap gap-2">
                <button type="button" onClick={() => fileRef.current?.click()} className="btn-secondary btn-sm"><ImagePlus size={14} />تعویض تصویر</button>
                <button type="button" onClick={() => setSeal(null)} className="btn-secondary btn-sm text-rose-700"><Trash2 size={14} />حذف مهر</button>
                <span className="flex items-center gap-1 text-xs font-bold text-emerald-700"><BadgeCheck size={15} />آماده‌ی درج</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => fileRef.current?.click()} className="btn-secondary"><ImagePlus size={16} />بارگذاری عکس مهر</button>
              {needs.savedSeal && <button type="button" onClick={() => setSeal(needs.savedSeal!)} className="btn-secondary"><RotateCcw size={16} />استفاده از مهر قبلی</button>}
              {needs.companyName && <button type="button" onClick={() => setSeal(generateSeal(needs.companyName!, needs.companyNationalId || ""))} className="btn-secondary"><Wand2 size={16} />ساخت مهر متنی از نام شرکت</button>}
            </div>
          )}
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-ink/75">
            <input
              type="checkbox"
              checked={removeBg}
              onChange={(e) => {
                setRemoveBg(e.target.checked);
                if (lastFile.current) processFile(lastFile.current, e.target.checked);
              }}
              className="accent-[#102c31]"
            />
            حذف خودکار پس‌زمینه‌ی سفید تصویر
          </label>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) {
                lastFile.current = f;
                processFile(f, removeBg);
              }
            }}
          />
          {err && <p role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{err}</p>}
        </section>
      )}

      {needs.initialsRequired && (
        <section className="rounded-2xl border border-ink/10 bg-white p-5" aria-label="پاراف صفحات">
          <div className="mb-3 flex items-center gap-2 text-sm font-black">
            <BadgeCheck size={18} className="text-emerald-700" />
            پاراف صفحات
            <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-700">الزامی</span>
          </div>
          <p className="mb-3 text-xs leading-7 text-ink/72">پاراف (مخفف امضا) را یک‌بار بکشید؛ روی «تک‌تک صفحات» سند درج می‌شود تا هیچ صفحه‌ای قابل تعویض نباشد.</p>
          {needs.savedInitials && !initials && (
            <button type="button" onClick={() => { setInitialsState(needs.savedInitials!); emit({ initials: needs.savedInitials! }); }} className="btn-secondary mb-3"><RotateCcw size={16} />استفاده از پاراف قبلی</button>
          )}
          {initials && (
            <div className="mb-3 flex items-center gap-3 rounded-2xl bg-stone-50 p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={initials} alt="پاراف" className="h-14 w-28 rounded-lg border border-ink/10 bg-white object-contain" />
              <button type="button" onClick={() => { setInitialsState(null); emit({ initials: null }); }} className="btn-secondary btn-sm text-rose-700"><Trash2 size={14} />پاک‌کردن و ثبت مجدد</button>
            </div>
          )}
          {!initials && (
            <SignatureCapture
              onChange={(data) => {
                value.current = { ...value.current, initials: data };
                onChange(value.current);
              }}
            />
          )}
        </section>
      )}
    </div>
  );
}
