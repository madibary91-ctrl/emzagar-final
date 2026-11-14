"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Check, Copy, KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";
import { generateRecoveryKeyAction, type RecoveryKeyResult } from "@/modules/backup/actions";

type Props = {
  configured: boolean;
  fingerprint: string;
  fromEnv: boolean;
  insideDataVolume: boolean;
  mirrorCount: number;
  warnings: string[];
  mirrorErrors: string[];
};

/** CR-04: وضعیت حفاظت بک‌آپ + ساخت «کلید بازیابی» (کلید خصوصی فقط یک بار نمایش داده می‌شود) */
export default function RecoveryKeyCard({ configured, fingerprint, fromEnv, insideDataVolume, mirrorCount, warnings, mirrorErrors }: Props) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<RecoveryKeyResult | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const generate = () => {
    if (configured && !window.confirm("کلید بازیابی جدید ساخته می‌شود. بک‌آپ‌های قبلی همچنان فقط با کلید قبلی باز می‌شوند. ادامه می‌دهید؟")) return;
    start(async () => {
      setSaved(false);
      setResult(await generateRecoveryKeyAction());
    });
  };

  return (
    <div className="space-y-3 rounded-2xl border border-ink/10 bg-stone-50 p-4 text-xs leading-7">
      <h3 className="flex items-center gap-2 text-sm font-bold">
        {configured ? <ShieldCheck size={16} className="text-emerald-700" /> : <ShieldAlert size={16} className="text-rose-600" />}
        حفاظت کامل بک‌آپ (KYC + کلید امنیتی)
      </h3>
      <ul className="space-y-1.5 text-stone-700">
        <li>
          {configured ? "✅" : "❌"} کلید بازیابی: {configured ? <>فعال — اثر انگشت <b dir="ltr" className="font-mono">{fingerprint}</b></> : <b className="text-rose-700">تنظیم نشده؛ SESSION_SECRET در بک‌آپ نیست و مدارک KYC پس از فاجعه قابل خواندن نخواهند بود.</b>}
        </li>
        <li>
          {insideDataVolume ? "⚠️" : "✅"} محل نسخه‌ها: {insideDataVolume ? <b className="text-amber-700">روی همان volume داده‌ی اصلی؛ با از دست رفتن آن، بک‌آپ‌ها هم می‌روند. BACKUP_DIR را روی دیسک/volume دیگر بگذارید یا BACKUP_MIRROR_DIRS را تنظیم کنید.</b> : "خارج از volume داده‌ی اصلی یا با آینه‌ی بیرونی"}
          {mirrorCount > 0 && <> — {mirrorCount.toLocaleString("fa-IR")} مقصد آینه</>}
        </li>
      </ul>
      {warnings.includes("mirror-failed") && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-rose-700">کپی در مقصد آینه ناموفق بود: {mirrorErrors.join(" ؛ ") || "نامشخص"}</p>}
      {warnings.includes("secret-not-sealed") && <p role="alert" data-persist="true" className="rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-amber-800">آخرین بک‌آپ بدون کلید امنیتی گرفته شد؛ کلید بازیابی بسازید.</p>}

      {!fromEnv && (
        <button type="button" onClick={generate} disabled={pending} className={configured ? "btn-secondary btn-sm" : "btn-primary btn-sm"}>
          <KeyRound size={14} />{pending ? "در حال ساخت…" : configured ? "ساخت کلید بازیابی جدید" : "ساخت کلید بازیابی و بک‌آپ کامل"}
        </button>
      )}

      {result && !result.ok && <p role="alert" className="text-rose-700">{result.error}</p>}
      {result?.ok && (
        <div role="alert" data-persist="true" className="space-y-2 rounded-xl border-2 border-amber-400 bg-amber-50 p-3 text-amber-900">
          <p className="flex items-center gap-2 font-bold"><AlertTriangle size={16} />این کلید فقط همین یک بار نمایش داده می‌شود</p>
          <p>آن را در مدیر رمز یا جای امن آفلاین نگه دارید (نه روی همین سرور). بدون آن، بازیابی کامل پس از از دست رفتن سرور ممکن نیست؛ و هر کس آن را داشته باشد می‌تواند رازهای بک‌آپ‌ها را باز کند.</p>
          <div className="flex items-center gap-2">
            <code dir="ltr" className="block flex-1 select-all break-all rounded-lg bg-white p-2 font-mono text-[11px]">{result.privateKey}</code>
            <button type="button" className="btn-secondary btn-sm" onClick={() => { void navigator.clipboard?.writeText(result.privateKey); setCopied(true); }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
          </div>
          <p>اثر انگشت: <b dir="ltr" className="font-mono">{result.fingerprint}</b> · {result.backupOk ? "بک‌آپ کامل جدید با رازِ مهر‌شده ساخته شد." : "ساخت بک‌آپ فوری ناموفق بود؛ دوباره «بک‌آپ فوری» بزنید."}</p>
          <label className="flex items-center gap-2 font-bold"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />کلید را در جای امن ذخیره کردم</label>
          {saved && <button type="button" className="btn-primary btn-sm" onClick={() => setResult(null)}>بستن و پاک کردن از صفحه</button>}
        </div>
      )}
    </div>
  );
}
