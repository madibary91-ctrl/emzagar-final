"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Ban, Check, Copy, LoaderCircle, MessageCircle, Send, Smartphone } from "lucide-react";
import { quickCancelAction, quickRemindAction } from "@/modules/quick/actions";

export default function QuickManage({ token, recipientUrl, recipientName, title, qr, canAct, senderUrl, complete }: { token: string; recipientUrl: string | null; recipientName: string; title: string; qr: string | null; canAct: boolean; senderUrl: string | null; complete: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"remind" | "cancel" | null>(null);
  const [copied, setCopied] = useState(false);
  const text = `سلام ${recipientName}، سند «${title}» برای امضای شما آماده است. با این لینک (و کد پیامکی) امضا کنید:`;

  const copy = async () => {
    if (!recipientUrl) return;
    try {
      await navigator.clipboard.writeText(recipientUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("کپی انجام نشد؛ لینک را دستی انتخاب کنید");
    }
  };
  const remind = async () => {
    setBusy("remind");
    setErr("");
    const r = await quickRemindAction(token);
    setBusy(null);
    r.ok ? setMsg("یادآوری برای طرف مقابل ارسال شد") : setErr(r.error || "ارسال نشد");
  };
  const cancel = async () => {
    if (!confirm("این سند لغو شود؟ لینک امضای طرف مقابل از کار می‌افتد.")) return;
    setBusy("cancel");
    const r = await quickCancelAction(token);
    setBusy(null);
    if (!r.ok) return setErr(r.error || "لغو نشد");
    router.refresh();
  };

  return (
    <div className="space-y-4">
      {recipientUrl && canAct && (
        <section className="card space-y-4">
          <h2 className="text-sm font-black">لینک امضای {recipientName}</h2>
          <p className="text-xs leading-6 text-ink/70">برای او پیامک شد (اگر پنل پیامک فعال باشد). هر راهی که راحت‌تر است هم می‌توانید لینک را بفرستید:</p>
          <div className="flex items-center gap-2 rounded-xl bg-stone-50 p-2">
            <input readOnly value={recipientUrl} dir="ltr" aria-label="لینک امضا" onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 bg-transparent px-2 text-left text-xs" />
            <button type="button" onClick={copy} className="btn-secondary btn-sm">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "کپی شد" : "کپی"}</button>
          </div>
          <div className="flex flex-wrap gap-2">
            <a className="btn-secondary btn-sm" target="_blank" rel="noopener noreferrer" href={`https://wa.me/?text=${encodeURIComponent(`${text}\n${recipientUrl}`)}`}><MessageCircle size={14} />واتس‌اپ</a>
            <a className="btn-secondary btn-sm" target="_blank" rel="noopener noreferrer" href={`https://t.me/share/url?url=${encodeURIComponent(recipientUrl)}&text=${encodeURIComponent(text)}`}><Send size={14} />تلگرام</a>
            <a className="btn-secondary btn-sm" href={`sms:?&body=${encodeURIComponent(`${text}\n${recipientUrl}`)}`}><Smartphone size={14} />پیامک</a>
          </div>
          {qr && (
            <div className="flex items-center gap-4 rounded-2xl bg-stone-50 p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt="QR لینک امضا" width={112} height={112} className="rounded-lg bg-white p-1" />
              <p className="text-xs leading-6 text-ink/70">اگر روبه‌روی هم هستید، QR را با دوربین گوشی او اسکن کنید تا همان‌جا امضا کند.</p>
            </div>
          )}
        </section>
      )}
      {(msg || err) && <p role={err ? "alert" : "status"} className={`rounded-xl border p-3 text-xs ${err ? "border-rose-200 bg-rose-50 text-rose-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>{err || msg}</p>}
      <div className="flex flex-wrap gap-3">
        {canAct && recipientUrl && (
          <button type="button" onClick={remind} disabled={busy !== null} className="btn-secondary">{busy === "remind" ? <LoaderCircle size={16} className="animate-spin" /> : <Bell size={16} />}یادآوری به طرف مقابل</button>
        )}
        {canAct && (
          <button type="button" onClick={cancel} disabled={busy !== null} className="btn-danger">{busy === "cancel" ? <LoaderCircle size={16} className="animate-spin" /> : <Ban size={16} />}لغو سند</button>
        )}
        {complete && senderUrl && <a href={senderUrl} className="btn-primary btn-mint">دریافت نسخه‌ی نهایی (PDF)</a>}
      </div>
    </div>
  );
}
