"use client";

import { useActionState, useState } from "react";
import { CheckCircle2, Clock, Fingerprint, IdCard, LoaderCircle, RotateCcw, ShieldCheck, ShieldQuestion, XCircle } from "lucide-react";
import IdentityLevelPicker from "@/components/identity/IdentityLevelPicker";
import { resetIdentityAttemptsAction, reviewIdentityDocsAction, setIdentityRequirementAction, type IdentityActionState } from "@/modules/identity/actions";
import { MAX_SHAHKAR_ATTEMPTS, assuranceText, identityLevel, maskNc, toLatinDigits, type IdentityReq } from "@/modules/identity/rules";

export type IdentitySignerItem = {
  id: number;
  label: string;
  name: string;
  status: string; // pending | signed | rejected
  req: IdentityReq;
  assurance: string;
  met: boolean;
  shahkar: string;
  shahkarProvider: string;
  shahkarAt: string | null;
  attempts: number;
  expectedNc: string;
  nc: string;
  docStatus: string;
  docSubmittedAt: string | null;
  docRejectReason: string;
  hasDocs: boolean;
  sealHash: string;
};

const FA = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (n: number | string) => String(n).replace(/\d/g, (d) => FA[Number(d)]);
const initial: IdentityActionState = {};

function Msg({ s }: { s: IdentityActionState }) {
  if (s.error) return <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-700">{s.error}</p>;
  if (s.message) return <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-2.5 text-xs text-emerald-800">{s.message}</p>;
  return null;
}

function Chip({ ok, wait, bad, children }: { ok?: boolean; wait?: boolean; bad?: boolean; children: React.ReactNode }) {
  const cls = ok ? "bg-emerald-50 text-emerald-700 border-emerald-200" : bad ? "bg-rose-50 text-rose-700 border-rose-200" : wait ? "bg-amber-50 text-amber-800 border-amber-200" : "bg-stone-100 text-ink/70 border-stone-200";
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${cls}`}>{children}</span>;
}

function LevelForm({ contractId, signer, shahkarAvailable }: { contractId: number; signer: IdentitySignerItem; shahkarAvailable: boolean }) {
  const [state, action, pending] = useActionState(setIdentityRequirementAction, initial);
  const [req, setReq] = useState<IdentityReq>(signer.req);
  const [nc, setNc] = useState(signer.expectedNc);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="signerId" value={signer.id} />
      <IdentityLevelPicker name={`req`} value={req} onChange={setReq} expectedNc={nc} onExpectedChange={(v) => setNc(toLatinDigits(v).replace(/\D/g, "").slice(0, 10))} shahkarAvailable={shahkarAvailable} compact />
      <Msg s={state} />
      <button disabled={pending} className="btn-primary btn-mint btn-sm">{pending ? <LoaderCircle size={14} className="animate-spin" /> : <ShieldCheck size={14} />}ذخیره‌ی سطح امنیت</button>
    </form>
  );
}

function ReviewForm({ contractId, signerId }: { contractId: number; signerId: number }) {
  const [state, action, pending] = useActionState(reviewIdentityDocsAction, initial);
  const [reason, setReason] = useState("");
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="signerId" value={signerId} />
      <label htmlFor={`rr-${signerId}`} className="label">دلیل رد (فقط در صورت رد لازم است)</label>
      <input id={`rr-${signerId}`} name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="مثلاً: عکس کارت ملی ناخوانا است" className="input" />
      <Msg s={state} />
      <div className="flex flex-wrap gap-2">
        <button disabled={pending} name="decision" value="approve" className="btn-primary btn-mint btn-sm"><CheckCircle2 size={14} />تأیید مدارک</button>
        <button disabled={pending} name="decision" value="reject" className="btn-secondary btn-sm text-rose-700"><XCircle size={14} />رد مدارک</button>
      </div>
    </form>
  );
}

function ResetForm({ contractId, signerId }: { contractId: number; signerId: number }) {
  const [state, action, pending] = useActionState(resetIdentityAttemptsAction, initial);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="signerId" value={signerId} />
      <Msg s={state} />
      <button disabled={pending} className="btn-secondary btn-sm"><RotateCcw size={14} />بازنشانی تلاش‌ها</button>
    </form>
  );
}

/**
 * «امنیت هویت امضاکنندگان» در صفحه‌ی قرارداد (صادرکننده): تعیین سطح، دیدن وضعیت/شواهد، بررسی مدارک.
 * برای قراردادهای عادی فقط یک کارت جمع‌شده است تا صفحه شلوغ نشود.
 */
export default function IdentityAdminPanel({ contractId, items, canEdit, shahkarAvailable }: { contractId: number; items: IdentitySignerItem[]; canEdit: boolean; shahkarAvailable: boolean }) {
  const active = items.some((i) => i.req !== "none" || i.assurance !== "none");
  const pendingDocs = items.some((i) => i.docStatus === "pending" && i.status === "pending");
  return (
    <section id="identity" className="panel-solid p-5 sm:p-6">
      <details open={active || pendingDocs}>
        <summary className="flex cursor-pointer flex-wrap items-center gap-2">
          <span className="flex items-center gap-2 text-sm font-black"><ShieldCheck size={17} />امنیت هویت امضاکنندگان <span className="text-xs font-semibold text-ink/60">(اختیاری)</span></span>
          {pendingDocs && <Chip wait><Clock size={12} />مدارک منتظر بررسی شما</Chip>}
          {!active && <span className="text-xs text-ink/65">فعلاً «عادی»: لینک اختصاصی + کد پیامکی. برای معاملات حساس می‌توانید سطح را بالا ببرید.</span>}
        </summary>
        <ul className="mt-4 space-y-4">
          {items.map((s) => {
            const lvl = identityLevel(s.req);
            const open = s.status === "pending" && canEdit;
            const locked = s.attempts >= MAX_SHAHKAR_ATTEMPTS && s.shahkar !== "matched";
            return (
              <li key={s.id} className="rounded-2xl border border-ink/10 bg-stone-50/50 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-xs">{s.label} — {s.name}</b>
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${lvl.tone}`}>{lvl.title}</span>
                  {s.req !== "none" && (s.req === "shahkar" || s.req === "both") && (
                    s.shahkar === "matched" ? <Chip ok><Fingerprint size={12} />موبایل = کد ملی ✓{s.shahkarProvider === "sandbox" ? " (آزمایشی)" : ""}</Chip>
                    : s.shahkar === "mismatch" ? <Chip bad><XCircle size={12} />عدم تطابق موبایل و کد ملی</Chip>
                    : s.shahkar === "stale" ? <Chip wait><Clock size={12} />شماره تغییر کرد؛ تأیید مجدد لازم است</Chip>
                    : <Chip wait><Clock size={12} />استعلام انجام نشده</Chip>
                  )}
                  {(s.req === "document" || s.req === "both") && (
                    s.docStatus === "approved" ? <Chip ok><IdCard size={12} />مدارک تأییدشده</Chip>
                    : s.docStatus === "pending" ? <Chip wait><Clock size={12} />مدارک در انتظار بررسی</Chip>
                    : s.docStatus === "rejected" ? <Chip bad><XCircle size={12} />مدارک رد شد</Chip>
                    : <Chip wait><Clock size={12} />مدارک ارسال نشده</Chip>
                  )}
                  {s.status === "signed" && s.assurance !== "none" && <Chip ok><ShieldCheck size={12} />امضا با هویت تأییدشده ثبت شد</Chip>}
                  {s.status === "signed" && s.req !== "none" && s.assurance === "none" && <Chip><ShieldQuestion size={12} />پیش از الزام هویت امضا شده</Chip>}
                </div>

                {(s.expectedNc || s.nc) && (
                  <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-ink/80 sm:grid-cols-2">
                    {s.expectedNc && <div><dt className="inline text-ink/60">کد ملی اعلام‌شده‌ی شما: </dt><dd dir="ltr" className="inline font-mono">{faDigits(s.expectedNc)}</dd></div>}
                    {s.nc && <div><dt className="inline text-ink/60">کد ملی واردشده توسط امضاکننده: </dt><dd dir="ltr" className="inline font-mono">{faDigits(s.nc)}</dd>{s.expectedNc && s.nc !== s.expectedNc && <b className="mr-1 text-rose-700"> ≠ مغایر</b>}</div>}
                    {s.shahkarAt && <div><dt className="inline text-ink/60">زمان استعلام: </dt><dd className="inline">{new Date(s.shahkarAt).toLocaleString("fa-IR")}</dd></div>}
                    <div><dt className="inline text-ink/60">تلاش‌های استعلام: </dt><dd className="inline">{faDigits(s.attempts)} از {faDigits(MAX_SHAHKAR_ATTEMPTS)}</dd></div>
                  </dl>
                )}

                {s.assurance !== "none" && (
                  <p className="mt-2 break-all text-xs leading-6 text-emerald-800">
                    {assuranceText(s.assurance, { sandbox: s.shahkarProvider === "sandbox" })}
                    {s.sealHash && <> — مهر یکپارچگی: <span dir="ltr" className="font-mono">{s.sealHash.slice(0, 24)}…</span></>}
                  </p>
                )}

                {s.docStatus === "pending" && s.hasDocs && s.status === "pending" && canEdit && (
                  <div className="mt-4 space-y-3 rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
                    <p className="text-xs font-bold text-amber-900">مدارک را با دقت با کد ملی {s.nc ? <span dir="ltr" className="font-mono">{faDigits(s.nc)}</span> : ""} و مشخصات داخل قرارداد مقایسه کنید؛ سلفی باید همان فرد و همان کارت را نشان دهد.</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(["id", "selfie"] as const).map((k) => (
                        <figure key={k} className="overflow-hidden rounded-xl border border-ink/10 bg-white">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`/api/identity/file/${s.id}/${k}`} alt={k === "id" ? "عکس کارت ملی" : "سلفی با کارت ملی"} className="max-h-72 w-full object-contain" loading="lazy" />
                          <figcaption className="border-t border-ink/10 p-2 text-center text-[11px] text-ink/65">{k === "id" ? "کارت ملی" : "سلفی با کارت"}</figcaption>
                        </figure>
                      ))}
                    </div>
                    <ReviewForm contractId={contractId} signerId={s.id} />
                  </div>
                )}
                {s.docStatus === "rejected" && s.docRejectReason && <p className="mt-2 text-xs text-rose-700">دلیل رد: {s.docRejectReason}</p>}

                {locked && canEdit && s.status === "pending" && (
                  <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                    <p className="mb-2 font-bold">سقف تلاش استعلام پر شد ({maskNc(s.nc)}). اگر مطمئنید شماره‌ی موبایل یا کد ملی اشتباه ثبت شده بود، می‌توانید فرصت دوباره بدهید.</p>
                    <ResetForm contractId={contractId} signerId={s.id} />
                  </div>
                )}

                {open && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-bold text-ink/80 underline">{s.req === "none" ? "ارتقای امنیت هویت این امضاکننده" : "تغییر سطح امنیت"}</summary>
                    <div className="mt-3"><LevelForm contractId={contractId} signer={s} shahkarAvailable={shahkarAvailable} /></div>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
