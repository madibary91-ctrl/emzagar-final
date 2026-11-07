"use client";

import { useActionState, useState, useTransition } from "react";
import { BadgeCheck, CircleAlert, CloudDownload, History, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, Undo2 } from "lucide-react";
import ConfirmButton from "@/components/ConfirmButton";
import {
  activateLicenseAction, checkUpdateAction, installUpdateAction, refreshLicenseAction, removeLicenseAction, rollbackUpdateAction, type LicenseActionState,
} from "@/modules/license/actions";

export interface LicenseView {
  state: string;
  stateLabel: string;
  licensed: boolean;
  keyMasked: string;
  plan: string;
  customer: string;
  domain: string;
  expiresAt: string | null;
  updatesUntil: string | null;
  usedDomains: number;
  maxDomains: number;
  checkedAt: string | null;
  stale: boolean;
  verified: boolean;
  lastError: string | null;
  serverUrl: string;
}
export interface UpdateView {
  current: string;
  checkedAt: string | null;
  available: boolean;
  latest: { version: string; changelog: string; publishedAt: string; size: number; security: boolean } | null;
  error: string | null;
  supported: boolean;
  unsupportedReason: string;
  rollback: string | null;
  history: { at: string; from: string; to: string; kind: "update" | "rollback" }[];
}

const dateFa = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("fa-IR") : "—");
const mb = (n: number) => `${(n / 1048576).toLocaleString("fa-IR", { maximumFractionDigits: 1 })} مگابایت`;

/** صفحه‌ی لایسنس و به‌روزرسانی خریدار */
export default function LicensePanel({ license, update }: { license: LicenseView; update: UpdateView }) {
  const [act, activate, activating] = useActionState<LicenseActionState, FormData>(activateLicenseAction, {});
  const [msg, setMsg] = useState<LicenseActionState>({});
  const [busy, startBusy] = useTransition();
  const [working, setWorking] = useState("");

  const run = (name: string, fn: () => Promise<LicenseActionState>) => {
    setWorking(name);
    setMsg({});
    startBusy(async () => {
      setMsg(await fn());
      setWorking("");
    });
  };

  const tone = license.licensed ? (license.stale ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-700") : license.state === "unlicensed" ? "bg-stone-100 text-stone-600" : "bg-rose-50 text-rose-700";
  const feedback = msg.ok || msg.error ? msg : act;

  return (
    <div className="space-y-5">
      <section className="card space-y-5" aria-labelledby="lic-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-ink text-mint"><KeyRound size={20} aria-hidden="true" /></span>
            <div>
              <h2 id="lic-title" className="font-bold">لایسنس محصول</h2>
              <p className="mt-0.5 text-xs text-stone-600">کلید لایسنس را از فروشنده دریافت کنید؛ سیستم شما برای تأیید آن به سرور فروشنده وصل می‌شود.</p>
            </div>
          </div>
          <span className={`badge ${tone}`} data-testid="license-state">{license.stateLabel}</span>
        </div>

        {license.state !== "unlicensed" && (
          <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["کلید", license.keyMasked || "—"],
              ["خریدار", license.customer || "—"],
              ["طرح", license.plan || "—"],
              ["دامنه", license.domain || "—"],
              ["دامنه‌های فعال", license.maxDomains ? `${license.usedDomains.toLocaleString("fa-IR")} از ${license.maxDomains.toLocaleString("fa-IR")}` : "—"],
              ["انقضای لایسنس", license.expiresAt ? dateFa(license.expiresAt) : "نامحدود"],
              ["به‌روزرسانی تا", license.updatesUntil ? dateFa(license.updatesUntil) : "نامحدود"],
              ["آخرین بررسی", dateFa(license.checkedAt)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-2xl border border-ink/10 bg-white p-3">
                <dt className="text-stone-600">{k}</dt>
                <dd className="mt-1 break-all font-bold" dir={k === "کلید" || k === "دامنه" ? "ltr" : undefined}>{v}</dd>
              </div>
            ))}
          </dl>
        )}

        {license.stale && <p className="flex items-center gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-800"><CircleAlert size={14} aria-hidden="true" />ارتباط با سرور لایسنس چند روز است برقرار نشده؛ سایت شما کار می‌کند و تا ۱۴ روز مهلت آفلاین دارید.</p>}
        {!license.verified && license.state !== "unlicensed" && <p className="rounded-xl bg-stone-50 p-3 text-xs text-stone-600">امضای دیجیتال پاسخ سرور بررسی نشد (کلید عمومی فروشنده روی این نصب تنظیم نشده است).</p>}
        {license.verified && <p className="flex items-center gap-2 text-xs text-emerald-700"><ShieldCheck size={14} aria-hidden="true" />پاسخ سرور لایسنس با امضای دیجیتال فروشنده تأیید شده است.</p>}

        <form action={activate} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <label htmlFor="license_key" className="label">{license.state === "unlicensed" ? "کلید لایسنس" : "جایگزینی کلید لایسنس"}</label>
            <input id="license_key" name="key" dir="ltr" autoComplete="off" spellCheck={false} placeholder="EMZ-XXXXX-XXXXX-XXXXX-XXXXX" className="input font-mono" />
          </div>
          <button disabled={activating} className="btn-primary" data-testid="license-activate">
            {activating ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <BadgeCheck size={15} aria-hidden="true" />}
            فعال‌سازی
          </button>
          {license.state !== "unlicensed" && (
            <>
              <button type="button" disabled={busy} onClick={() => run("refresh", refreshLicenseAction)} className="btn-secondary">
                {working === "refresh" ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
                بررسی مجدد
              </button>

            </>
          )}
        </form>
        {license.state !== "unlicensed" && (
          <form action={() => run("remove", removeLicenseAction)}>
            <ConfirmButton disabled={busy} title="حذف لایسنس" message="لایسنس از این نصب حذف و دامنه روی سرور فروشنده آزاد می‌شود. ادامه می‌دهید؟" confirmLabel="بله، حذف شود" className="btn-ghost !min-h-9 !text-xs !text-rose-700" data-testid="license-remove">
              حذف لایسنس از این نصب
            </ConfirmButton>
          </form>
        )}
        {(feedback.ok || feedback.error) && (
          <p role={feedback.error ? "alert" : "status"} className={`rounded-xl p-3 text-xs ${feedback.error ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-800"}`}>{feedback.error || feedback.ok}</p>
        )}
        <p className="text-[11px] text-stone-600" dir="ltr">server: {license.serverUrl}</p>
      </section>

      <section className="card space-y-4" aria-labelledby="upd-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-ink text-mint"><CloudDownload size={20} aria-hidden="true" /></span>
            <div>
              <h2 id="upd-title" className="font-bold">به‌روزرسانی سیستم</h2>
              <p className="mt-0.5 text-xs text-stone-600">نسخه‌ی فعلی: <b dir="ltr" data-testid="current-version">{update.current}</b>{update.checkedAt && <> · آخرین بررسی: {dateFa(update.checkedAt)}</>}</p>
            </div>
          </div>
          <span className={`badge ${update.available ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>{update.available ? "نسخه‌ی جدید موجود است" : "به‌روز"}</span>
        </div>

        {update.available && update.latest && (
          <div className="rounded-2xl border border-mint/50 bg-mint/10 p-4 text-sm">
            <p className="font-bold">نسخه‌ی <span dir="ltr">{update.latest.version}</span>{update.latest.security && <span className="badge mr-2 bg-rose-50 text-rose-700">به‌روزرسانی امنیتی</span>}</p>
            <p className="mt-1 text-xs text-stone-600">{dateFa(update.latest.publishedAt)} · {mb(update.latest.size)}</p>
            {update.latest.changelog && <pre className="mt-3 whitespace-pre-wrap font-[inherit] text-xs leading-7 text-ink/80">{update.latest.changelog}</pre>}
          </div>
        )}
        {!update.supported && <p className="rounded-xl bg-amber-50 p-3 text-xs leading-6 text-amber-800">{update.unsupportedReason}</p>}
        {update.error && <p className="rounded-xl bg-rose-50 p-3 text-xs text-rose-700">{update.error}</p>}

        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => run("check", checkUpdateAction)} className="btn-secondary" data-testid="update-check">
            {working === "check" ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
            بررسی نسخه‌ی جدید
          </button>
          {update.available && update.supported && (
            <form action={() => run("install", installUpdateAction)}>
              <ConfirmButton disabled={busy || !license.licensed} title="نصب به‌روزرسانی" message="پیش از نصب از دیتابیس پشتیبان گرفته می‌شود و برنامه پس از نصب چند ثانیه راه‌اندازی مجدد می‌شود. ادامه می‌دهید؟" confirmLabel="بله، به‌روزرسانی شود" className="btn-primary" data-testid="update-install">
                <CloudDownload size={15} aria-hidden="true" /> به‌روزرسانی با یک کلیک
              </ConfirmButton>
            </form>
          )}
          {update.rollback && update.supported && (
            <button type="button" disabled={busy} onClick={() => run("rollback", rollbackUpdateAction)} className="btn-secondary">
              <Undo2 size={15} aria-hidden="true" /> بازگشت به نسخه‌ی قبل ({update.rollback.split("-")[0]})
            </button>
          )}
        </div>
        {working === "install" && <p role="status" className="flex items-center gap-2 text-xs"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" />در حال دانلود و نصب… لطفاً صفحه را نبندید.</p>}

        {update.history.length > 0 && (
          <details className="rounded-2xl border border-ink/10 bg-white/60 p-4">
            <summary className="flex cursor-pointer items-center gap-2 text-xs font-bold"><History size={14} aria-hidden="true" />تاریخچه‌ی به‌روزرسانی‌ها</summary>
            <ul className="mt-3 space-y-1.5 text-xs">
              {update.history.map((h, i) => (
                <li key={i} className="flex justify-between gap-3"><span>{h.kind === "rollback" ? "بازگشت" : "به‌روزرسانی"}: <span dir="ltr">{h.from} → {h.to}</span></span><span className="text-stone-600">{dateFa(h.at)}</span></li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}
