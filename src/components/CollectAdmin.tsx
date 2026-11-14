"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Download, FileArchive, FileSpreadsheet, FileText, Pause, Play, Printer, Trash2 } from "lucide-react";
import CopyButton from "@/components/CopyButton";
import { deleteCampaignAction, updateCampaignAction, voidSubmissionAction } from "@/modules/collect/actions";

export interface SubRow {
  id: number;
  receipt: string;
  name: string;
  mobile: string;
  verified: boolean;
  at: string;
  voided: boolean;
  summary: string;
}

export default function CollectAdmin({ campaign, url, qr, rows }: { campaign: { id: number; status: string; title: string; maxSubmissions: number | null; closesAt: string; successMessage: string; locked: boolean }; url: string; qr: string; rows: SubRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState("");
  const [max, setMax] = useState(campaign.maxSubmissions ? String(campaign.maxSubmissions) : "");
  const [closes, setCloses] = useState(campaign.closesAt);
  const [success, setSuccess] = useState(campaign.successMessage);
  const [title, setTitle] = useState(campaign.title);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, ok = "ذخیره شد") =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? ok : r.error || "انجام نشد");
      if (r.ok) router.refresh();
    });

  const setStatus = (status: string) => run(() => updateCampaignAction(campaign.id, { status }), "وضعیت تغییر کرد");

  return (
    <div className="space-y-5">
      <section className="card grid gap-5 md:grid-cols-[200px_1fr]">
        <div className="space-y-2 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} alt="QR فرم عمومی" width={200} height={200} className="mx-auto rounded-xl border border-ink/10 bg-white p-2" />
          <a href={`/admin/collect/${campaign.id}/poster`} target="_blank" rel="noopener" className="btn-secondary btn-sm w-full justify-center"><Printer size={14} />پوستر چاپی QR</a>
          <a href={`${url}/qr`} download className="btn-ghost btn-sm w-full justify-center"><Download size={14} />دانلود PNG</a>
        </div>
        <div className="space-y-4">
          <div>
            <p className="mb-1 text-xs font-black">لینک عمومی (هر کس باز کند، مستقیم فرم را می‌بیند)</p>
            <div className="flex items-center gap-2 rounded-xl bg-stone-50 p-2">
              <input readOnly dir="ltr" value={url} aria-label="لینک عمومی" onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 bg-transparent px-2 text-left text-sm" />
              <CopyButton text={url} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {campaign.status !== "open" && <button type="button" disabled={pending} onClick={() => setStatus("open")} className="btn-primary btn-sm btn-mint"><Play size={14} />باز کردن دریافت امضا</button>}
            {campaign.status === "open" && <button type="button" disabled={pending} onClick={() => setStatus("paused")} className="btn-secondary btn-sm"><Pause size={14} />توقف موقت</button>}
            {campaign.status !== "closed" && <button type="button" disabled={pending} onClick={() => confirm("دریافت امضا برای همیشه بسته شود؟") && setStatus("closed")} className="btn-secondary btn-sm"><Ban size={14} />بستن</button>}
          </div>
          <div className="flex flex-wrap gap-2">
            <a className="btn-secondary btn-sm" href={`/api/collect/${campaign.id}/export?f=csv`}><FileSpreadsheet size={14} />خروجی اکسل (CSV)</a>
            <a className="btn-secondary btn-sm" href={`/api/collect/${campaign.id}/export?f=zip`}><FileArchive size={14} />همه‌ی PDFها (ZIP)</a>
          </div>
        </div>
      </section>

      <details className="card">
        <summary className="cursor-pointer text-sm font-black">تنظیمات فرم</summary>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><label className="label" htmlFor="s-title">عنوان</label><input id="s-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div><label className="label" htmlFor="s-max">سقف تعداد امضا</label><input id="s-max" className="input" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ""))} placeholder="نامحدود" /></div>
          <div><label className="label" htmlFor="s-close">آخرین مهلت</label><input id="s-close" type="date" className="input" value={closes} onChange={(e) => setCloses(e.target.value)} /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="s-msg">پیام پس از امضا</label><input id="s-msg" className="input" value={success} onChange={(e) => setSuccess(e.target.value)} /></div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" disabled={pending} className="btn-primary btn-sm" onClick={() => run(() => updateCampaignAction(campaign.id, { title, maxSubmissions: max ? Number(max) : null, closesAtIso: closes ? new Date(`${closes}T23:59:59`).toISOString() : null, successMessage: success }))}>ذخیره</button>
          <button type="button" disabled={pending} className="btn-danger btn-sm" onClick={() => confirm("این فرم و همه‌ی امضاهای جمع‌شده برای همیشه حذف شود؟") && start(async () => { await deleteCampaignAction(campaign.id); router.push("/admin/collect"); })}><Trash2 size={14} />حذف فرم</button>
          {campaign.locked && <span className="text-[11px] text-ink/60">متن و فیلدها پس از اولین امضا قابل ویرایش نیستند (یکپارچگی اسناد).</span>}
        </div>
      </details>
      {msg && <p role="status" className="rounded-xl bg-stone-100 p-3 text-xs">{msg}</p>}

      <section className="card !p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-right text-xs">
            <thead className="bg-stone-50 text-ink/70"><tr><th className="p-3">نام</th><th className="p-3">موبایل</th><th className="p-3">اطلاعات</th><th className="p-3">زمان</th><th className="p-3">رسید</th><th className="p-3" /></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-ink/60">هنوز امضایی ثبت نشده است. لینک یا QR را پخش کنید.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id} className={`border-t border-ink/8 ${r.voided ? "opacity-50" : ""}`}>
                  <td className="p-3 font-bold">{r.name}{r.voided && <span className="mr-1 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] text-rose-600">باطل</span>}</td>
                  <td className="p-3" dir="ltr">{r.mobile}{r.verified && <span title="تأییدشده با پیامک" className="mr-1 text-emerald-600">✓</span>}</td>
                  <td className="max-w-[240px] truncate p-3 text-ink/70" title={r.summary}>{r.summary || "—"}</td>
                  <td className="p-3 text-ink/70">{r.at}</td>
                  <td className="p-3 font-mono" dir="ltr">{r.receipt}</td>
                  <td className="whitespace-nowrap p-3">
                    <a href={`/api/collect/submission/${r.id}/pdf`} className="btn-ghost btn-sm" title="PDF"><FileText size={14} /></a>
                    {!r.voided && <button type="button" className="btn-ghost btn-sm" title="ابطال" onClick={() => { const reason = prompt("دلیل ابطال این امضا؟"); if (reason !== null) run(() => voidSubmissionAction(r.id, reason), "امضا باطل شد"); }}><Ban size={14} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
