import Link from "next/link";
import { MailCheck, ShieldAlert } from "lucide-react";
import AuthFrame from "@/components/AuthFrame";
import { confirmEmailLinkAction } from "@/modules/auth/actions";
import { peekVerifyToken } from "@/modules/auth/email-verify";

export const dynamic = "force-dynamic";
export const metadata = { title: "تأیید ایمیل", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

/** لینک ایمیل فقط این صفحه را باز می‌کند؛ تأیید نهایی با کلیک کاربر روی دکمه (POST) انجام می‌شود */
export default async function VerifyLinkPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ failed?: string }> }) {
  const { token } = await params;
  const { failed } = await searchParams;
  const info = failed ? null : await peekVerifyToken(token);
  if (!info) {
    return (
      <AuthFrame title="لینک نامعتبر است">
        <div className="text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose-50 text-rose-500"><ShieldAlert size={24} /></span>
          <p className="mt-4 text-xs leading-7 text-ink/75">این لینک نامعتبر است، قبلاً استفاده شده یا مهلت آن تمام شده. وارد شوید تا کد تازه برایتان ارسال شود.</p>
          <Link href="/login" className="btn-primary mt-6 inline-flex">رفتن به صفحه‌ی ورود</Link>
        </div>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="تأیید ایمیل" subtitle="برای تأیید مالکیت این ایمیل روی دکمه‌ی زیر بزنید.">
      <form action={confirmEmailLinkAction} className="space-y-5">
        <input type="hidden" name="token" value={token} />
        <p dir="ltr" className="flex items-center justify-center gap-2 rounded-2xl bg-stone-50 p-4 text-center text-sm font-bold"><MailCheck size={18} className="text-ink/72" />{info.email}</p>
        <button className="btn-primary w-full !min-h-[50px]">تأیید ایمیل</button>
      </form>
    </AuthFrame>
  );
}
