import { CheckCircle2, ClipboardCheck, MessageCircleWarning, ShieldCheck, Trash2, UserCheck } from "lucide-react";
import { APPROVAL_LABELS, summarizeApprovals, type ApprovalRow } from "@/modules/contracts/approvals";
import { decideApprovalAction, removeApprovalAction, requestApprovalAction } from "@/modules/contracts/approvals-actions";
import { faTime } from "@/lib/jalali";

/**
 * تأیید داخلی پیش از انتشار (گردش کار تأیید): هر تأییدکننده نسخه‌ی فعلی متن را تأیید یا اصلاح می‌خواهد.
 * با هر تغییر متن، تأییدها بازنشانی می‌شوند و تا تأیید همه، انتشار ممکن نیست.
 */
export default function ApprovalPanel({
  contractId,
  returnTo,
  rows,
  candidates,
  meId,
  canWrite,
  isDraft,
  flash,
  error,
}: {
  contractId: number;
  returnTo: string;
  rows: ApprovalRow[];
  candidates: { id: number; name: string; role: string }[];
  meId: number;
  canWrite: boolean;
  isDraft: boolean;
  flash?: string;
  error?: string;
}) {
  const s = summarizeApprovals(rows);
  const mine = rows.find((r) => r.approverId === meId);
  const requestedIds = new Set(rows.map((r) => r.approverId));
  const free = candidates.filter((c) => !requestedIds.has(c.id));
  if (!isDraft && rows.length === 0) return null;
  // کاربری که تنها کار می‌کند: هیچ همکار دیگری برای تأیید وجود ندارد؛ این مرحله برایش فقط مانع است
  const solo = candidates.every((c) => c.id === meId) && rows.every((r) => r.approverId === meId);

  const flashText =
    flash?.startsWith("requested") ? "درخواست تأیید ارسال شد." : flash === "approved" ? "تأیید شما ثبت شد." : flash === "changes_requested" ? "درخواست اصلاح شما ثبت شد." : flash === "removed" ? "تأییدکننده حذف شد." : "";

  return (
    <section id="approvals" className="panel-solid scroll-mt-24 space-y-4 p-5 sm:p-6" aria-labelledby="approvals-title">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-mint"><ClipboardCheck size={18} /></span>
        <div className="min-w-0 flex-1">
          <h2 id="approvals-title" className="text-sm font-black">تأیید داخلی پیش از انتشار</h2>
          <p className="mt-0.5 text-xs text-ink/72">همکاران (مثلاً بخش حقوقی یا مالی) نسخه‌ی فعلی را بررسی می‌کنند. با هر تغییر در متن، تأییدها از نو لازم می‌شود.</p>
        </div>
        {s.total > 0 && (
          <span className={`badge border ${s.blocked ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
            {s.blocked ? <MessageCircleWarning size={12} /> : <ShieldCheck size={12} />}
            {s.approved.toLocaleString("fa-IR")} از {s.total.toLocaleString("fa-IR")} تأیید
          </span>
        )}
      </div>

      {flashText && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">{flashText}</p>}
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}

      {isDraft && solo && <p className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-xs leading-6 text-sky-800">شما تنها عضو تأییدکننده‌ی این فضای کاری هستید، پس تأیید داخلی لازم نیست؛ دکمه‌ی «انتشار نسخه نهایی» مستقیم منتشر می‌کند. هر وقت همکاری به تیم اضافه شد، می‌توانید از او تأیید بگیرید.</p>}
      {rows.length === 0 && !solo && <p className="rounded-2xl bg-stone-50 p-4 text-xs text-ink/72">هنوز تأییدکننده‌ای تعیین نشده است؛ انتشار بدون تأیید مجاز است.</p>}
      <ul className="grid gap-2 md:grid-cols-2">
        {rows.map((r) => (
          <li key={r.id} className="flex items-start gap-3 rounded-2xl border border-ink/10 bg-stone-50/60 p-3">
            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-white ${r.status === "approved" ? "bg-emerald-600" : r.status === "changes_requested" ? "bg-rose-500" : "bg-stone-400"}`}>
              {r.status === "approved" ? <CheckCircle2 size={17} /> : r.status === "changes_requested" ? <MessageCircleWarning size={17} /> : <UserCheck size={17} />}
            </span>
            <div className="min-w-0 flex-1 text-xs">
              <b className="block">{r.approverName}{r.approverId === meId ? " (شما)" : ""}</b>
              <span className="text-ink/72">{APPROVAL_LABELS[r.status] ?? r.status}{r.decidedAt ? ` • ${faTime(r.decidedAt)}` : ""}</span>
              {r.note && <p className="mt-1 whitespace-pre-wrap rounded-lg bg-white p-2 leading-6">{r.note}</p>}
            </div>
            {canWrite && isDraft && (
              <form action={removeApprovalAction}>
                <input type="hidden" name="id" value={contractId} />
                <input type="hidden" name="approverId" value={r.approverId} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <button className="grid h-8 w-8 place-items-center rounded-lg text-ink/60 hover:bg-rose-50 hover:text-rose-700" aria-label={`حذف ${r.approverName} از تأییدکنندگان`}><Trash2 size={14} /></button>
              </form>
            )}
          </li>
        ))}
      </ul>

      {isDraft && mine && (
        <form action={decideApprovalAction} className="space-y-3 rounded-2xl border border-dashed border-ink/20 p-4">
          <input type="hidden" name="id" value={contractId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <h3 className="text-xs font-black">تصمیم شما درباره‌ی نسخه‌ی فعلی</h3>
          <label className="sr-only" htmlFor="approval-note">توضیح</label>
          <textarea id="approval-note" name="note" rows={2} maxLength={500} className="input" placeholder="توضیح (برای درخواست اصلاح الزامی است)…" defaultValue={mine.note} />
          <div className="flex flex-wrap gap-2">
            <button name="decision" value="approved" className="btn-primary btn-mint"><CheckCircle2 size={15} />تأیید می‌کنم</button>
            <button name="decision" value="changes_requested" className="btn-secondary"><MessageCircleWarning size={15} />نیاز به اصلاح دارد</button>
          </div>
        </form>
      )}

      {isDraft && canWrite && !solo && free.length > 0 && (
        <form action={requestApprovalAction} className="space-y-3 border-t border-ink/10 pt-4">
          <input type="hidden" name="id" value={contractId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <h3 className="text-xs font-black">درخواست تأیید از همکاران</h3>
          <div className="flex flex-wrap gap-2">
            {free.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-full border border-ink/15 bg-white px-3 py-1.5 text-xs has-[:checked]:border-ink has-[:checked]:bg-ink has-[:checked]:text-white">
                <input type="checkbox" name="approver" value={c.id} className="h-3.5 w-3.5 accent-[var(--mint)]" />
                {c.name}{c.id === meId ? " (خودم)" : ""}
              </label>
            ))}
          </div>
          <button className="btn-secondary"><ClipboardCheck size={15} />ارسال درخواست تأیید</button>
        </form>
      )}
    </section>
  );
}
