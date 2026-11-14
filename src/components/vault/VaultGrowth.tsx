"use client";

import { useActionState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, CircleDashed, Gift, LoaderCircle, Rocket, Send, Zap } from "lucide-react";
import { faNum } from "@/lib/jalali";
import { vaultUpgradeAction, type VaultFormState } from "@/modules/vault/actions";

export interface GrowthView {
  state: "can_upgrade" | "has_account" | "upgraded";
  senderName: string;
  rewardsOn: boolean;
  giftWallet: number;
  giftCredits: number;
  milestoneDays: number;
  signedCount: number;
}

const initial: VaultFormState = {};

/** کارت رشد: از «امضاکننده» تا «فرستنده» — هدیه‌ی دوطرفه، ساخت حساب ۳۰ ثانیه‌ای، یا ارسال سریع بدون ثبت‌نام */
export default function VaultGrowth({ offer, defaultName }: { offer: GrowthView; defaultName: string }) {
  const [state, action, pending] = useActionState(vaultUpgradeAction, initial);
  const gift = [offer.giftWallet > 0 ? `${faNum(offer.giftWallet)} تومان اعتبار` : "", offer.giftCredits > 0 ? `${faNum(offer.giftCredits)} قرارداد رایگان` : ""].filter(Boolean).join(" + ");

  if (offer.state !== "can_upgrade") {
    return (
      <section className="card !p-6">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-emerald-50 text-emerald-700"><Rocket size={20} /></span>
          <div className="flex-1">
            <h2 className="text-base font-black">{offer.state === "upgraded" ? "حساب فروشنده‌ی شما آماده است" : "شما در امضاگیر حساب دارید"}</h2>
            <p className="mt-1 text-xs leading-7 text-ink/75">برای ارسال قرارداد به مشتریان و همکاران خودتان وارد پنل شوید؛ یا بدون ورود، همین حالا یک سند را با «ارسال سریع» بفرستید.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/login" className="btn-primary btn-sm">ورود به پنل<ArrowLeft size={15} /></Link>
              <Link href="/quick" className="btn-secondary btn-sm"><Zap size={15} />ارسال سریع</Link>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const steps = [
    { done: true, text: `${offer.signedCount ? faNum(offer.signedCount) + " سند" : "اولین سند"} را امضا کردید` },
    { done: false, text: "حساب رایگان بسازید (۳۰ ثانیه؛ موبایلتان تأیید شده است)" },
    { done: false, text: gift ? `اولین قرارداد را بفرستید و ${gift} بگیرید` : "اولین قرارداد خودتان را برای مشتری بفرستید" },
  ];

  return (
    <section className="overflow-hidden rounded-3xl bg-ink text-white shadow-lg" aria-labelledby="vault-growth-title">
      <div className="grid gap-0 md:grid-cols-[1.1fr_1fr]">
        <div className="p-6 sm:p-7">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-mint/15 px-3 py-1 text-[11px] font-bold text-mint"><Gift size={13} />{offer.rewardsOn ? "هدیه‌ی دوطرفه" : "از امضاکننده تا فرستنده"}</span>
          <h2 id="vault-growth-title" className="mt-3 text-xl font-black leading-9">شما امضا کردید؛ حالا خودتان قرارداد بفرستید</h2>
          <p className="mt-2 text-sm leading-8 text-white/85">
            {offer.rewardsOn && offer.senderName
              ? `«${offer.senderName}» شما را به امضای دیجیتال آورد. اگر شما هم اولین قراردادتان را بفرستید، ${gift ? gift + " به شما" : "هدیه‌ی خوشامد"} و پاداش دعوت به «${offer.senderName}» می‌رسد.`
              : "همان سادگی امضا، برای مشتریان خودتان: قرارداد را آماده کنید، لینک امضا بفرستید و با گواهی رسمی PDF تحویل بگیرید."}
          </p>
          <ol className="mt-5 space-y-3">
            {steps.map((s, i) => (
              <li key={i} className="flex items-start gap-3 text-xs leading-6">
                <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${s.done ? "bg-mint text-ink" : "border border-white/30 text-white/70"}`}>{s.done ? <Check size={12} /> : <CircleDashed size={12} />}</span>
                <span className={s.done ? "text-white" : "text-white/80"}>{s.text}</span>
              </li>
            ))}
          </ol>
          {offer.milestoneDays > 0 && offer.rewardsOn && <p className="mt-4 text-[11px] leading-6 text-white/60">با هر ۳ دعوتِ موفق، {faNum(offer.milestoneDays)} روز اشتراک رایگان هم می‌گیرید.</p>}
          <Link href="/quick" className="mt-5 inline-flex items-center gap-2 text-xs font-bold text-mint underline-offset-4 hover:underline"><Send size={14} />ثبت‌نام نمی‌خواهم؛ فقط یک سند می‌فرستم (ارسال سریع)</Link>
        </div>

        <form action={action} className="space-y-3 bg-white p-6 text-ink sm:p-7">
          <h3 className="text-sm font-black">ساخت حساب رایگان</h3>
          <div>
            <label className="label" htmlFor="vg-name">نام شما</label>
            <input id="vg-name" name="name" defaultValue={defaultName} autoComplete="name" className="input w-full" />
          </div>
          <div>
            <label className="label" htmlFor="vg-biz">نام کسب‌وکار (اختیاری)</label>
            <input id="vg-biz" name="workspaceName" maxLength={60} className="input w-full" placeholder="مثلاً استودیو نیلو" />
          </div>
          <div>
            <label className="label" htmlFor="vg-email">ایمیل</label>
            <input id="vg-email" name="email" type="email" required dir="ltr" autoComplete="email" className="input w-full text-left" placeholder="you@example.com" />
          </div>
          <div>
            <label className="label" htmlFor="vg-pass">رمز عبور</label>
            <input id="vg-pass" name="password" type="password" required minLength={8} dir="ltr" autoComplete="new-password" className="input w-full text-left" />
          </div>
          {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{state.error}</p>}
          <button type="submit" disabled={pending} className="btn-primary btn-mint !min-h-[50px] w-full">
            {pending ? <LoaderCircle size={17} className="animate-spin" /> : <Rocket size={17} />}
            ساخت حساب و شروع ارسال قرارداد
          </button>
          <p className="text-[11px] leading-6 text-ink/60">تاریخچه‌ی امضاهای شما به همین حساب متصل می‌ماند. شماره‌ی موبایل شما پیش‌تر تأیید شده است.</p>
        </form>
      </div>
    </section>
  );
}
