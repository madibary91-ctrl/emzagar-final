"use client";

import { useActionState } from "react";
import { Loader2, Mail, MessageCircle, Send, Smartphone } from "lucide-react";
import CopyButton from "@/components/CopyButton";
import { inviteByEmailAction, type InviteState } from "@/modules/referral/actions";

/** لینک اختصاصی + اشتراک‌گذاری سریع + دعوت با ایمیل */
export default function ReferralShare({ link, code, text }: { link: string; code: string; text: string }) {
  const [s, action, pending] = useActionState<InviteState, FormData>(inviteByEmailAction, {});
  const enc = encodeURIComponent;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-ink/10 bg-stone-50 p-3">
        <code dir="ltr" className="min-w-0 flex-1 break-all text-sm font-bold" data-testid="referral-link">{link}</code>
        <CopyButton text={link} label="کپی لینک" />
        <CopyButton text={code} label="کپی کد" />
      </div>
      <div className="mb-5 flex flex-wrap gap-2">
        <a className="btn-secondary btn-sm" target="_blank" rel="noopener noreferrer" href={`https://wa.me/?text=${enc(`${text}\n${link}`)}`}><MessageCircle size={14} />واتساپ</a>
        <a className="btn-secondary btn-sm" target="_blank" rel="noopener noreferrer" href={`https://t.me/share/url?url=${enc(link)}&text=${enc(text)}`}><Send size={14} />تلگرام</a>
        <a className="btn-secondary btn-sm" href={`sms:?&body=${enc(`${text} ${link}`)}`}><Smartphone size={14} />پیامک</a>
      </div>
      <form action={action} className="space-y-2">
        <label className="label" htmlFor="ref-emails">دعوت با ایمیل (حداکثر ۵ ایمیل، با ویرگول یا خط جدید)</label>
        <textarea id="ref-emails" name="emails" rows={2} dir="ltr" className="input" placeholder="friend@example.com" />
        {s.error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">{s.error}</p>}
        {s.ok && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-xs font-semibold text-emerald-800">{s.message}</p>}
        <button disabled={pending} className="btn-primary btn-sm">{pending ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}ارسال دعوت‌نامه</button>
      </form>
    </div>
  );
}
