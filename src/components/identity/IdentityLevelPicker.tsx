"use client";

import { Fingerprint, IdCard, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { IDENTITY_LEVELS, type IdentityReq, needsShahkar } from "@/modules/identity/rules";

const ICONS: Record<IdentityReq, typeof ShieldCheck> = { none: Zap, shahkar: Fingerprint, document: IdCard, both: ShieldCheck };

/**
 * انتخاب «سطح امنیت هویت» امضاکننده — اختیاری؛ پیش‌فرض «عادی» (سریع) است.
 * کنترل‌شده: والد مقدار و تغییر را نگه می‌دارد. فیلدهای فرم: `${name}` (سطح) و `expectedNc` (کد ملی مورد انتظار).
 */
export default function IdentityLevelPicker({
  name = "identityReq",
  value,
  onChange,
  expectedNc,
  onExpectedChange,
  shahkarAvailable,
  allowExpected = true,
  suggestion,
  compact,
}: {
  name?: string;
  value: IdentityReq;
  onChange: (v: IdentityReq) => void;
  expectedNc: string;
  onExpectedChange: (v: string) => void;
  shahkarAvailable: boolean;
  allowExpected?: boolean;
  suggestion?: { req: IdentityReq; reasons: string[] } | null;
  compact?: boolean;
}) {
  const showSuggest = !!suggestion && suggestion.req !== value && !(needsShahkar(suggestion.req) && !shahkarAvailable);
  return (
    <div className="space-y-3">
      {showSuggest && suggestion && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-900">
          <span className="flex items-start gap-2"><Sparkles size={15} className="mt-1 shrink-0" /><span><b>پیشنهاد هوشمند:</b> {suggestion.reasons.join(" • ")}. برای جلوگیری از انکار امضا، تأیید هویت امضاکننده را فعال کنید.</span></span>
          <button type="button" onClick={() => onChange(suggestion.req)} className="btn btn-secondary btn-sm">فعال‌سازی «{IDENTITY_LEVELS.find((l) => l.req === suggestion.req)?.title}»</button>
        </div>
      )}
      <div role="radiogroup" aria-label="سطح امنیت هویت امضاکننده" className={compact ? "grid gap-2 sm:grid-cols-2" : "grid gap-2"}>
        {IDENTITY_LEVELS.map((l) => {
          const Icon = ICONS[l.req];
          const disabled = needsShahkar(l.req) && !shahkarAvailable;
          const active = value === l.req;
          return (
            <label key={l.req} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${active ? "border-mint bg-mint/10 ring-2 ring-mint/20" : "border-ink/10 bg-white hover:bg-stone-50"} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}>
              <input type="radio" name={name} value={l.req} checked={active} disabled={disabled} onChange={() => onChange(l.req)} className="mt-1 accent-[#102c31]" />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-black"><Icon size={15} />{l.title}{l.req === "none" && <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold text-ink/70">پیش‌فرض</span>}</span>
                <span className="mt-0.5 block text-xs leading-6 text-ink/72">{l.blurb}</span>
                {disabled && <span className="mt-0.5 block text-[11px] font-bold text-amber-700">استعلام شاهکار روی این سامانه فعال نیست (مدیر پلتفرم باید سرویس را تنظیم کند)</span>}
              </span>
            </label>
          );
        })}
      </div>
      {value !== "none" && allowExpected && (
        <div className="rounded-xl bg-stone-50 p-3">
          <label htmlFor={`${name}-nc`} className="label">کد ملی امضاکننده (توصیه می‌شود)</label>
          <input id={`${name}-nc`} name="expectedNc" value={expectedNc} onChange={(e) => onExpectedChange(e.target.value)} inputMode="numeric" dir="ltr" maxLength={10} placeholder="۱۰ رقم، مطابق مشخصات داخل قرارداد" autoComplete="off" className="input" />
          <p className="mt-1 text-xs leading-6 text-ink/72">اگر وارد کنید، امضاکننده باید دقیقاً همین کد ملی را بزند؛ وگرنه هر کسی می‌تواند کد ملی خودش را وارد کند. کد ملی رمزنگاری ذخیره می‌شود.</p>
        </div>
      )}
      {value === "none" && <input type="hidden" name="expectedNc" value="" />}
    </div>
  );
}
