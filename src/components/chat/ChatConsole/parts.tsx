"use client";
import { CONTEXT_LABELS, type StaffThread } from "@/modules/chat/meta";
import { CONTRACT_STATUS, SIGNER_STATUS } from "./helpers";
import { ExternalLink, FileText } from "lucide-react";
import Link from "next/link";
import { ago, faNum, hm } from "../ChatBits";

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-xs">
      <span className="shrink-0 text-ink/55">{k}</span>
      <span className="min-w-0 break-words text-left font-bold">{v}</span>
    </div>
  );
}
export function ContextCard({ ctx }: { ctx: NonNullable<StaffThread["context"]> }) {
  const c = ctx.contract;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-1 text-xs font-black text-ink/60">مشتری</h3>
        <div className="divide-y divide-ink/[0.06] rounded-2xl bg-stone-50 px-3">
          <Row k="نام" v={ctx.requester.name || "—"} />
          {ctx.requester.mobile && <Row k="موبایل" v={<span dir="ltr" className="font-mono">{ctx.requester.mobile}</span>} />}
          {ctx.requester.email && <Row k="ایمیل" v={<span dir="ltr">{ctx.requester.email}</span>} />}
          <Row k="نوع" v={ctx.requester.userId ? "کاربر ثبت‌نام‌شده" : "مهمان (بدون حساب)"} />
          {ctx.workspaceName && <Row k="فضای کاری" v={ctx.workspaceName} />}
          <Row k="گفتگوی قبلی" v={faNum(ctx.previousChats)} />
        </div>
      </div>
      <div>
        <h3 className="mb-1 text-xs font-black text-ink/60">نشست</h3>
        <div className="divide-y divide-ink/[0.06] rounded-2xl bg-stone-50 px-3">
          <Row k="منبع" v={CONTEXT_LABELS[ctx.contextKind]} />
          <Row k="دستگاه" v={ctx.device} />
          {ctx.pagePath && <Row k="صفحه" v={<span dir="ltr" className="font-mono text-[11px]">{ctx.pagePath}</span>} />}
          <Row k="شروع" v={`${hm(ctx.startedAt)} · ${ago(ctx.startedAt)}`} />
        </div>
      </div>
      {c ? (
        <div>
          <h3 className="mb-1 flex items-center gap-1.5 text-xs font-black text-ink/60"><FileText size={13} />قرارداد مرتبط</h3>
          <div className="rounded-2xl bg-stone-50 p-3">
            <p className="text-sm font-black leading-6">{c.title}</p>
            <p dir="ltr" className="mt-0.5 text-left font-mono text-[11px] text-ink/60">{c.number}</p>
            <div className="mt-2 divide-y divide-ink/[0.06]">
              <Row k="وضعیت" v={CONTRACT_STATUS[c.status] ?? c.status} />
              <Row k="صدور" v={new Date(c.issuedAt).toLocaleDateString("fa-IR")} />
              {c.expiresAt && <Row k="مهلت امضا" v={new Date(c.expiresAt).toLocaleDateString("fa-IR")} />}
              {c.pendingInstallments > 0 && <Row k="اقساط پرداخت‌نشده" v={faNum(c.pendingInstallments)} />}
            </div>
            <ul className="mt-2 space-y-1">
              {c.signers.map((s, i) => (
                <li key={i} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate font-bold">{s.label}: {s.name}</span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 font-black ${s.status === "signed" ? "bg-emerald-50 text-emerald-700" : s.status === "rejected" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-800"}`}>{SIGNER_STATUS[s.status] ?? s.status}</span>
                </li>
              ))}
            </ul>
            {c.href && <Link href={c.href} target="_blank" className="btn-secondary btn-sm mt-3 w-full justify-center"><ExternalLink size={13} />باز کردن قرارداد</Link>}
          </div>
        </div>
      ) : (
        <p className="rounded-2xl bg-stone-50 p-3 text-center text-[11px] leading-6 text-ink/55">این گفتگو به قرارداد خاصی وصل نیست.</p>
      )}
    </div>
  );
}
