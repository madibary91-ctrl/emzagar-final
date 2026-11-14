"use client";

import { useActionState, useRef, useState } from "react";
import { Ban, CirclePlay, CirclePause, KeyRound, LoaderCircle, Package, PlusCircle, Trash2, Upload } from "lucide-react";
import CopyButton from "@/components/CopyButton";
import { issueLicenseAction, releaseActivationAction, setLicenseStatusAction, yankReleaseAction, type LicenseActionState } from "@/modules/license/actions";

export interface VendorLicense {
  id: number;
  key: string;
  customerName: string;
  customerEmail: string;
  plan: string;
  maxDomains: number;
  status: string;
  expiresAt: string | null;
  updatesUntil: string | null;
  lastCheckAt: string | null;
  activations: { id: number; domain: string; version: string; lastSeenAt: string }[];
}
export interface VendorRelease {
  id: number;
  version: string;
  channel: string;
  security: boolean;
  yanked: boolean;
  size: number;
  sha256: string;
  publishedAt: string;
  changelog: string;
}

const d = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("fa-IR") : "—");
const STATUS: Record<string, [string, string]> = { active: ["فعال", "bg-emerald-50 text-emerald-700"], suspended: ["معلق", "bg-amber-50 text-amber-700"], revoked: ["باطل", "bg-rose-50 text-rose-700"] };

/** پنل فروشنده: صدور کلید، مدیریت دامنه‌ها، انتشار نسخه */
export default function VendorPanel({ licenses, releases, publicKey }: { licenses: VendorLicense[]; releases: VendorRelease[]; publicKey: string }) {
  const [state, issue, issuing] = useActionState<LicenseActionState, FormData>(issueLicenseAction, {});
  const [up, setUp] = useState<{ busy: boolean; msg: string; error: boolean }>({ busy: false, msg: "", error: false });
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const file = fileRef.current?.files?.[0];
    if (!file) return setUp({ busy: false, msg: "فایل zip را انتخاب کنید", error: true });
    setUp({ busy: true, msg: "در حال بارگذاری…", error: false });
    const qs = new URLSearchParams({
      version: String(fd.get("version") || ""),
      channel: String(fd.get("channel") || "stable"),
      security: fd.get("security") ? "1" : "0",
      changelog: String(fd.get("changelog") || ""),
    });
    try {
      const res = await fetch(`/api/platform/releases?${qs}`, { method: "PUT", body: file, headers: { "Content-Type": "application/zip" } });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (j?.ok) {
        setUp({ busy: false, msg: "نسخه منتشر شد.", error: false });
        window.location.reload();
      } else setUp({ busy: false, msg: j?.error || "آپلود ناموفق بود", error: true });
    } catch {
      setUp({ busy: false, msg: "ارتباط با سرور قطع شد", error: true });
    }
  }

  return (
    <div className="space-y-5">
      <section className="card space-y-4" aria-labelledby="issue-title">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-ink text-mint"><KeyRound size={20} aria-hidden="true" /></span>
          <div>
            <h2 id="issue-title" className="font-bold">صدور لایسنس جدید</h2>
            <p className="mt-0.5 text-xs text-stone-600">کلید را فقط یک‌بار به خریدار تحویل دهید؛ فعال‌سازی روی دامنه‌ی او انجام می‌شود.</p>
          </div>
        </div>
        <form action={issue} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div><label className="label" htmlFor="v-name">نام خریدار</label><input id="v-name" name="customerName" required className="input" /></div>
          <div><label className="label" htmlFor="v-email">ایمیل</label><input id="v-email" name="customerEmail" type="email" dir="ltr" className="input" /></div>
          <div><label className="label" htmlFor="v-plan">طرح</label><select id="v-plan" name="plan" className="input"><option value="standard">استاندارد</option><option value="extended">گسترده</option><option value="enterprise">سازمانی</option></select></div>
          <div><label className="label" htmlFor="v-dom">حداکثر دامنه</label><input id="v-dom" name="maxDomains" type="number" min={1} defaultValue={1} className="input" /></div>
          <div><label className="label" htmlFor="v-exp">اعتبار لایسنس (روز؛ ۰ = نامحدود)</label><input id="v-exp" name="expiresInDays" type="number" min={0} defaultValue={0} className="input" /></div>
          <div><label className="label" htmlFor="v-upd">دسترسی به آپدیت (روز؛ ۰ = نامحدود)</label><input id="v-upd" name="updatesInDays" type="number" min={0} defaultValue={365} className="input" /></div>
          <div className="sm:col-span-2 lg:col-span-3"><label className="label" htmlFor="v-notes">یادداشت داخلی</label><input id="v-notes" name="notes" className="input" /></div>
          <div className="sm:col-span-2 lg:col-span-3">
            <button disabled={issuing} className="btn-primary" data-testid="vendor-issue">{issuing ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <PlusCircle size={15} aria-hidden="true" />}صدور لایسنس</button>
          </div>
        </form>
        {state.error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-xs text-rose-700">{state.error}</p>}
        {state.ok && (
          <div role="status" className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-800">
            {state.ok}
            <div className="mt-2 flex flex-wrap items-center gap-2"><code dir="ltr" className="rounded-lg bg-white px-3 py-1.5 font-mono text-sm font-bold" data-testid="issued-key">{state.key}</code><CopyButton text={state.key || ""} /></div>
          </div>
        )}
      </section>

      <section className="panel-solid overflow-x-auto">
        <h2 className="px-5 pt-5 font-bold">لایسنس‌های صادرشده</h2>
        <table className="w-full min-w-[760px]">
          <thead><tr><th className="th">کلید</th><th className="th">خریدار</th><th className="th">وضعیت</th><th className="th">دامنه‌ها</th><th className="th">انقضا / آپدیت تا</th><th className="th">عملیات</th></tr></thead>
          <tbody>
            {licenses.length === 0 && <tr><td colSpan={6} className="td text-center text-xs text-stone-600">هنوز لایسنسی صادر نشده است.</td></tr>}
            {licenses.map((l) => (
              <tr key={l.id} className="border-t border-ink/[.07] align-top">
                <td className="td font-mono text-xs" dir="ltr">{l.key}</td>
                <td className="td text-xs"><b>{l.customerName}</b><br /><span className="text-stone-600" dir="ltr">{l.customerEmail}</span></td>
                <td className="td"><span className={`badge ${STATUS[l.status]?.[1] ?? ""}`}>{STATUS[l.status]?.[0] ?? l.status}</span></td>
                <td className="td text-xs">
                  {l.activations.length}/{l.maxDomains}
                  <ul className="mt-1 space-y-1">
                    {l.activations.map((a) => (
                      <li key={a.id} className="flex items-center gap-1.5"><span dir="ltr" className="font-mono">{a.domain}</span><span className="text-stone-600" dir="ltr">v{a.version || "?"}</span>
                        <form action={releaseActivationAction}><input type="hidden" name="id" value={a.id} /><button aria-label={`آزادسازی ${a.domain}`} title="آزادسازی دامنه" className="grid h-6 w-6 place-items-center rounded-md text-rose-600 hover:bg-rose-50"><Trash2 size={12} aria-hidden="true" /></button></form>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="td text-xs">{l.expiresAt ? d(l.expiresAt) : "نامحدود"}<br /><span className="text-stone-600">{l.updatesUntil ? d(l.updatesUntil) : "نامحدود"}</span></td>
                <td className="td">
                  <form action={setLicenseStatusAction} className="flex gap-1">
                    <input type="hidden" name="id" value={l.id} />
                    {l.status !== "active" && <button name="status" value="active" title="فعال‌سازی" aria-label="فعال‌سازی" className="grid h-8 w-8 place-items-center rounded-lg border border-ink/10 hover:bg-emerald-50"><CirclePlay size={14} aria-hidden="true" /></button>}
                    {l.status === "active" && <button name="status" value="suspended" title="تعلیق" aria-label="تعلیق" className="grid h-8 w-8 place-items-center rounded-lg border border-ink/10 hover:bg-amber-50"><CirclePause size={14} aria-hidden="true" /></button>}
                    {l.status !== "revoked" && <button name="status" value="revoked" title="ابطال" aria-label="ابطال" className="grid h-8 w-8 place-items-center rounded-lg border border-ink/10 text-rose-600 hover:bg-rose-50"><Ban size={14} aria-hidden="true" /></button>}
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card space-y-4" aria-labelledby="rel-title">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-ink text-mint"><Package size={20} aria-hidden="true" /></span>
          <div>
            <h2 id="rel-title" className="font-bold">انتشار نسخه‌ی جدید</h2>
            <p className="mt-0.5 text-xs text-stone-600">خروجی <code dir="ltr">node scripts/build-release.mjs</code> را بارگذاری کنید؛ SHA-256 محاسبه و مانیفست با کلید خصوصی شما امضا می‌شود.</p>
          </div>
        </div>
        <form onSubmit={upload} className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="r-ver">نسخه</label><input id="r-ver" name="version" required dir="ltr" placeholder="2.1.0" className="input" /></div>
          <div><label className="label" htmlFor="r-ch">کانال</label><select id="r-ch" name="channel" className="input"><option value="stable">پایدار</option><option value="beta">آزمایشی (beta)</option></select></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="r-log">تغییرات نسخه</label><textarea id="r-log" name="changelog" rows={4} className="input" /></div>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-4">
            <input ref={fileRef} type="file" accept=".zip,application/zip" aria-label="فایل zip نسخه" className="text-xs" />
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="security" /> به‌روزرسانی امنیتی</label>
            <button disabled={up.busy} className="btn-primary">{up.busy ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <Upload size={15} aria-hidden="true" />}انتشار</button>
          </div>
        </form>
        {up.msg && <p role={up.error ? "alert" : "status"} className={`rounded-xl p-3 text-xs ${up.error ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-800"}`}>{up.msg}</p>}
        <ul className="divide-y divide-ink/[.07] text-xs">
          {releases.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span><b dir="ltr">{r.version}</b> · {r.channel === "beta" ? "beta" : "پایدار"}{r.security ? " · امنیتی" : ""} · {(r.size / 1048576).toLocaleString("fa-IR", { maximumFractionDigits: 1 })}MB · {d(r.publishedAt)}{r.yanked && <span className="badge mr-2 bg-rose-50 text-rose-700">پس‌گرفته‌شده</span>}</span>
              <form action={yankReleaseAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="yanked" value={r.yanked ? "0" : "1"} /><button className="btn-ghost !min-h-8 !text-xs">{r.yanked ? "بازگردانی" : "پس‌گرفتن"}</button></form>
            </li>
          ))}
        </ul>
      </section>

      <section className="card space-y-2">
        <h2 className="font-bold">کلید عمومی امضا</h2>
        <p className="text-xs text-stone-600">این مقدار را در بسته‌ی خریداران به‌صورت متغیر محیطی <code dir="ltr">LICENSE_PUBLIC_KEY</code> قرار دهید تا پاسخ‌های سرور شما راستی‌آزمایی شوند.</p>
        <pre dir="ltr" className="overflow-x-auto rounded-xl bg-stone-50 p-3 text-[11px]">{publicKey}</pre>
      </section>
    </div>
  );
}
