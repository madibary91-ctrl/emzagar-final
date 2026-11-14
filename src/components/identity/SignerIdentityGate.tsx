"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Clock, Fingerprint, IdCard, LoaderCircle, ShieldCheck, Upload, XCircle } from "lucide-react";
import { accountVerifyShahkarAction, guestVerifyShahkarAction } from "@/modules/identity/actions";
import { needsDocs, needsShahkar, toLatinDigits } from "@/modules/identity/rules";
import type { GateView } from "@/modules/identity/service";

const FA = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (n: number | string) => String(n).replace(/\d/g, (d) => FA[Number(d)]);
const MAX_BYTES = 5 * 1024 * 1024;

export type GateMode = { kind: "guest"; token: string } | { kind: "account"; contractId: number };

function Step({ n, done, title, icon: Icon, children }: { n: number; done: boolean; title: string; icon: typeof Fingerprint; children: React.ReactNode }) {
  return (
    <li className={`rounded-2xl border p-4 ${done ? "border-emerald-200 bg-emerald-50/60" : "border-ink/10 bg-white"}`}>
      <div className="flex items-center gap-3">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-black ${done ? "bg-emerald-600 text-white" : "bg-ink text-mint"}`}>{done ? "✓" : faDigits(n)}</span>
        <h3 className="flex items-center gap-1.5 text-sm font-black"><Icon size={15} />{title}</h3>
      </div>
      <div className="mt-3 text-xs leading-7 text-ink/80">{children}</div>
    </li>
  );
}

/**
 * مرحله‌ی «تأیید هویت» امضاکننده — فقط وقتی صادرکننده سطح امنیت را بالا برده باشد نمایش داده می‌شود.
 * امضا تا کامل‌شدن این مراحل در سمت سرور هم مسدود است (رابط فقط راهنماست، نه سد امنیتی).
 */
export default function SignerIdentityGate({ mode, view, signerName }: { mode: GateMode; view: GateView; signerName: string }) {
  const router = useRouter();
  const [nc, setNc] = useState("");
  const [docNc, setDocNc] = useState("");
  const [busy, setBusy] = useState<"shahkar" | "docs" | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [idFile, setIdFile] = useState<File | null>(null);
  const [selfie, setSelfie] = useState<File | null>(null);

  const shahkarNeeded = needsShahkar(view.req);
  const docsNeeded = needsDocs(view.req);
  const shahkarDone = view.shahkar === "matched";
  const locked = view.attemptsLeft <= 0 && !shahkarDone;

  // مدارک در انتظار بررسی: هر ۱۰ ثانیه وضعیت تازه می‌شود (وقتی تب باز است)
  useEffect(() => {
    if (view.docStatus !== "pending") return;
    const t = setInterval(() => document.visibilityState === "visible" && router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [view.docStatus, router]);

  const verify = async () => {
    setError("");
    setInfo("");
    const code = toLatinDigits(nc).replace(/\D/g, "");
    if (code.length !== 10) return setError("کد ملی ۱۰ رقمی را وارد کنید");
    setBusy("shahkar");
    const r = mode.kind === "guest" ? await guestVerifyShahkarAction(mode.token, code) : await accountVerifyShahkarAction(mode.contractId, code);
    setBusy(null);
    if (!r.ok) {
      setError(r.error || "تأیید انجام نشد");
      router.refresh();
      return;
    }
    setInfo(r.message || "تأیید شد");
    router.refresh();
  };

  const upload = async () => {
    setError("");
    setInfo("");
    const code = toLatinDigits(docNc).replace(/\D/g, "");
    if (!(shahkarNeeded && shahkarDone) && code.length !== 10) return setError("کد ملی ۱۰ رقمی را وارد کنید");
    if (!idFile || !selfie) return setError("هر دو عکس را انتخاب کنید");
    if (idFile.size > MAX_BYTES || selfie.size > MAX_BYTES) return setError("حجم هر عکس حداکثر ۵ مگابایت است");
    setBusy("docs");
    const fd = new FormData();
    if (mode.kind === "guest") fd.set("token", mode.token);
    else fd.set("contractId", String(mode.contractId));
    fd.set("nationalCode", code);
    fd.set("idCard", idFile);
    fd.set("selfie", selfie);
    try {
      const res = await fetch("/api/identity/docs", { method: "POST", body: fd });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      setBusy(null);
      if (!res.ok || !j.ok) return setError(j.error || "ارسال مدارک انجام نشد");
      setInfo("مدارک ارسال شد؛ پس از تأیید صادرکننده می‌توانید امضا کنید.");
      router.refresh();
    } catch {
      setBusy(null);
      setError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید");
    }
  };

  let n = 0;
  return (
    <section aria-labelledby="idgate-title" className="panel-solid space-y-4 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-ink text-mint"><ShieldCheck size={21} /></span>
        <div>
          <h2 id="idgate-title" className="text-base font-black">تأیید هویت پیش از امضا</h2>
          <p className="mt-1 text-xs leading-7 text-ink/75">{signerName} عزیز، صادرکننده‌ی این قرارداد برای حفاظت از هر دو طرف در برابر جعل هویت و انکار امضا، تأیید هویت را الزامی کرده است. فقط یک‌بار و چند دقیقه طول می‌کشد.</p>
        </div>
      </div>

      <ol className="space-y-3">
        {shahkarNeeded && (
          <Step n={++n} done={shahkarDone} title="تأیید مالکیت شماره‌ی موبایل" icon={Fingerprint}>
            {shahkarDone ? (
              <p className="font-bold text-emerald-800">شماره‌ی موبایل شما با کد ملی {view.ncMask ? <span dir="ltr" className="font-mono">{faDigits(view.ncMask)}</span> : "شما"} تأیید شد ✓</p>
            ) : !view.shahkarAvailable ? (
              <p className="text-amber-800">استعلام خودکار فعلاً در دسترس نیست. لطفاً کمی بعد برگردید یا به صادرکننده اطلاع دهید.</p>
            ) : locked ? (
              <p className="text-rose-700">تعداد تلاش‌های مجاز تمام شد. برای ادامه، از صادرکننده بخواهید دسترسی شما را بازنشانی کند.</p>
            ) : (
              <div className="space-y-3">
                <p>کد ملی خودتان را وارد کنید. بررسی می‌کنیم شماره‌ی موبایل شما واقعاً به نام همین کد ملی ثبت شده باشد (استعلام رسمی، فقط نتیجه‌ی «مطابق/نامطابق» ذخیره می‌شود).</p>
                <label htmlFor="idg-nc" className="label">کد ملی (۱۰ رقم)</label>
                <input id="idg-nc" value={faDigits(nc)} onChange={(e) => setNc(toLatinDigits(e.target.value).replace(/\D/g, "").slice(0, 10))} onKeyDown={(e) => e.key === "Enter" && verify()} inputMode="numeric" dir="ltr" autoComplete="off" placeholder="۰۰۰۰۰۰۰۰۰۰" className="input max-w-64" />
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={verify} disabled={busy !== null || nc.length !== 10} className="btn-primary btn-mint">
                    {busy === "shahkar" ? <LoaderCircle size={16} className="animate-spin" /> : <Fingerprint size={16} />}تأیید کد ملی
                  </button>
                  <span className="text-[11px] text-ink/60">{faDigits(view.attemptsLeft)} تلاش باقی است</span>
                </div>
              </div>
            )}
          </Step>
        )}

        {docsNeeded && (
          <Step n={++n} done={view.docStatus === "approved"} title="مدارک هویتی (کارت ملی + سلفی)" icon={IdCard}>
            {view.docStatus === "approved" ? (
              <p className="font-bold text-emerald-800">مدارک شما توسط صادرکننده تأیید شد ✓</p>
            ) : view.docStatus === "pending" ? (
              <p className="flex items-center gap-2 font-bold text-amber-800"><Clock size={15} />مدارک ارسال شد و منتظر تأیید صادرکننده است. این صفحه خودکار تازه می‌شود؛ می‌توانید بعداً با همین لینک برگردید.</p>
            ) : shahkarNeeded && !shahkarDone ? (
              <p className="text-ink/60">ابتدا مرحله‌ی بالا را کامل کنید.</p>
            ) : (
              <div className="space-y-3">
                {view.docStatus === "rejected" && (
                  <p role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-700"><XCircle size={15} className="mt-1 shrink-0" />مدارک قبلی رد شد{view.docRejectReason ? `: ${view.docRejectReason}` : "."} لطفاً دوباره بفرستید.</p>
                )}
                <p>دو عکس واضح و بدون بازتاب نور بفرستید. فقط صادرکننده‌ی قرارداد آن را می‌بیند و رمزنگاری‌شده نگهداری می‌شود.</p>
                {!(shahkarNeeded && shahkarDone) && (
                  <div>
                    <label htmlFor="idg-dnc" className="label">کد ملی (۱۰ رقم)</label>
                    <input id="idg-dnc" value={faDigits(docNc)} onChange={(e) => setDocNc(toLatinDigits(e.target.value).replace(/\D/g, "").slice(0, 10))} inputMode="numeric" dir="ltr" autoComplete="off" className="input max-w-64" />
                  </div>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block rounded-xl border border-dashed border-ink/20 bg-stone-50 p-3">
                    <span className="label">عکس روی کارت ملی</span>
                    <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setIdFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-xs" />
                  </label>
                  <label className="block rounded-xl border border-dashed border-ink/20 bg-stone-50 p-3">
                    <span className="label">سلفی با کارت ملی در دست</span>
                    <input type="file" accept="image/jpeg,image/png,image/webp" capture="user" onChange={(e) => setSelfie(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-xs" />
                  </label>
                </div>
                <button type="button" onClick={upload} disabled={busy !== null} className="btn-primary btn-mint">
                  {busy === "docs" ? <LoaderCircle size={16} className="animate-spin" /> : <Upload size={16} />}ارسال مدارک برای بررسی
                </button>
              </div>
            )}
          </Step>
        )}
      </ol>

      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs leading-6 text-rose-700">{error}</p>}
      {info && <p role="status" className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800"><CheckCircle2 size={15} />{info}</p>}
    </section>
  );
}
