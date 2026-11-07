import { Download, LockKeyhole, MonitorSmartphone, ShieldCheck, ShieldOff, Trash2, UserRound } from "lucide-react";
import QRCode from "qrcode";
import Shell from "@/components/Shell";
import CopyButton from "@/components/CopyButton";
import { PasswordForm, ProfileForm, TotpConfirmForm, TotpManage } from "@/components/AccountForms";
import { describeUserAgent, getCurrentSessionId, listSessions, requireUser } from "@/modules/auth/session";
import { DeleteAccountForm } from "@/components/AccountPrivacy";
import { revokeOtherSessionsAction, revokeSessionAction } from "@/modules/account/actions";
import { totpStatus } from "@/modules/auth/twofactor";
import { startTotpSetupAction } from "@/modules/account/actions";
import { totpUri } from "@/lib/totp";
import { fa, faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";

function Section({ icon, title, hint, children }: { icon: React.ReactNode; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="panel-solid p-5 sm:p-6">
      <div className="mb-5 flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-mint">{icon}</span>
        <div>
          <h2 className="text-sm font-black">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-ink/72">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export default async function AccountPage() {
  const user = await requireUser();
  const status = await totpStatus(user.id);
  const currentSid = await getCurrentSessionId();
  const sessions = await listSessions(user.id, currentSid);

  // QR سمت سرور ساخته می‌شود؛ راز فقط در حالت «در حال راه‌اندازی» به صفحه می‌رسد
  let qrSvg = "";
  let secretGroups = "";
  if (status.state === "pending") {
    const uri = totpUri(status.secret, user.email, "Emzagar");
    qrSvg = await QRCode.toString(uri, { type: "svg", margin: 1, width: 176, errorCorrectionLevel: "M" });
    secretGroups = status.secret.replace(/(.{4})/g, "$1 ").trim();
  }

  return (
    <Shell user={user}>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><UserRound size={22} />حساب من</h1>
      <p className="mb-5 text-xs text-ink/72">مشخصات، رمز عبور و امنیت ورود شما</p>

      <div className="max-w-4xl space-y-5">
        <Section icon={<UserRound size={18} />} title="مشخصات" hint="شماره‌ی موبایل مبنای دریافت کد تأیید پیامکی هنگام امضاست">
          <ProfileForm name={user.name} email={user.email} mobile={user.mobile} />
        </Section>

        <Section icon={<LockKeyhole size={18} />} title="رمز عبور">
          <PasswordForm />
        </Section>

        <Section icon={status.state === "on" ? <ShieldCheck size={18} /> : <ShieldOff size={18} />} title="ورود دومرحله‌ای (TOTP)" hint="علاوه بر رمز، هنگام ورود کد ۶ رقمی اپ احراز هویت (Google Authenticator، Authy و …) خواسته می‌شود">
          {status.state === "off" && (
            <div className="space-y-4">
              <p className="text-xs leading-7 text-ink/75">با فعال‌سازی، حتی اگر رمز شما لو برود، بدون گوشی شما کسی نمی‌تواند وارد حساب و قراردادهای شما شود.</p>
              <form action={startTotpSetupAction}>
                <button className="btn-primary"><ShieldCheck size={16} />شروع فعال‌سازی</button>
              </form>
            </div>
          )}

          {status.state === "pending" && (
            <div className="space-y-5">
              <ol className="list-decimal space-y-1 pr-5 text-xs leading-7 text-ink/75">
                <li>یک اپ احراز هویت روی گوشی نصب کنید.</li>
                <li>QR زیر را اسکن کنید (یا کلید را دستی وارد کنید).</li>
                <li>کد ۶ رقمی نمایش‌داده‌شده را در پایین وارد کنید.</li>
              </ol>
              <div className="flex flex-wrap items-center gap-6">
                {/* eslint-disable-next-line react/no-danger */}
                <div className="rounded-2xl border border-ink/10 bg-white p-3" dangerouslySetInnerHTML={{ __html: qrSvg }} aria-label="QR فعال‌سازی" />
                <div className="min-w-0 space-y-2">
                  <span className="text-xs text-ink/72">کلید دستی:</span>
                  <code dir="ltr" className="block break-all rounded-xl bg-stone-50 px-3 py-2 font-mono text-sm tracking-wider">{secretGroups}</code>
                  <CopyButton text={status.secret} label="کپی کلید" />
                </div>
              </div>
              <TotpConfirmForm />
              <form action={startTotpSetupAction}>
                <button className="text-xs font-semibold text-ink/75 underline hover:text-ink">ساخت QR جدید</button>
              </form>
            </div>
          )}

          {status.state === "on" && (
            <div className="space-y-5">
              <p className="flex flex-wrap items-center gap-2 text-xs text-ink/75">
                <span className="badge border border-emerald-200 bg-emerald-50 text-emerald-700"><ShieldCheck size={13} />فعال</span>
                از {fa(status.enabledAt)} • {status.recoveryLeft.toLocaleString("fa-IR")} کد بازیابی باقی‌مانده
              </p>
              {status.recoveryLeft <= 2 && <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">کدهای بازیابی رو به اتمام است؛ کدهای جدید بسازید.</p>}
              <TotpManage />
            </div>
          )}
        </Section>

        <div id="sessions" className="scroll-mt-24">
          <Section icon={<MonitorSmartphone size={18} />} title="نشست‌ها و دستگاه‌ها" hint="دستگاه‌هایی که الان با حساب شما وارد شده‌اند؛ هر کدام را می‌توانید فوراً ببندید">
            <ul className="space-y-2">
              {sessions.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-ink/10 bg-stone-50/60 p-3">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-white text-ink/70"><MonitorSmartphone size={16} /></span>
                  <div className="min-w-0 flex-1">
                    <b className="block text-xs">{describeUserAgent(x.userAgent)}{x.current && <span className="mr-2 badge border border-emerald-200 bg-emerald-50 text-emerald-700">این دستگاه</span>}</b>
                    <span className="block text-[11px] text-ink/72">IP: <span dir="ltr" className="font-mono">{x.ip || "—"}</span> • آخرین فعالیت: {faTime(x.lastSeenAt)} • ورود: {faTime(x.createdAt)}</span>
                  </div>
                  {!x.current && (
                    <form action={revokeSessionAction}>
                      <input type="hidden" name="sid" value={x.id} />
                      <button className="btn-secondary btn-sm">بستن نشست</button>
                    </form>
                  )}
                </li>
              ))}
              {sessions.length === 0 && <li className="rounded-2xl bg-stone-50 p-4 text-xs text-ink/72">نشست ثبت‌شده‌ای نیست (ورود قدیمی). با یک‌بار خروج و ورود دوباره، دستگاه‌ها اینجا نمایش داده می‌شوند.</li>}
            </ul>
            {sessions.filter((x) => !x.current).length > 0 && (
              <form action={revokeOtherSessionsAction} className="mt-4">
                <button className="btn-danger btn-sm">خروج از همه‌ی دستگاه‌های دیگر</button>
              </form>
            )}
          </Section>
        </div>

        <Section icon={<Download size={18} />} title="داده‌های من" hint="خروجی کامل اطلاعات شخصی شما در قالب JSON (مشخصات، قراردادها، فیلدهای پرشده، لاگ فعالیت، نشست‌ها و …)">
          <p className="mb-4 text-xs leading-7 text-ink/75">رمز عبور، کلید ورود دومرحله‌ای و توکن‌های امنیتی عمداً در خروجی نیست. تعداد دانلود محدود است.</p>
          <a href="/api/account/export" className="btn-secondary"><Download size={16} />دانلود همه‌ی داده‌های من</a>
        </Section>

        <section className="panel-solid border-rose-200 p-5 sm:p-6">
          <div className="mb-5 flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-rose-600 text-white"><Trash2 size={18} /></span>
            <div>
              <h2 className="text-sm font-black text-rose-700">حذف حساب کاربری</h2>
              <p className="mt-0.5 text-xs text-ink/72">این کار برگشت‌ناپذیر است</p>
            </div>
          </div>
          <ul className="mb-5 list-disc space-y-1 pr-5 text-xs leading-7 text-ink/75">
            <li>مشخصات، شماره‌ی موبایل، نشست‌ها، ورود دومرحله‌ای، عضویت‌ها و اعلان‌های شما پاک می‌شود.</li>
            <li>قراردادهای در جریان‌ای که شما طرف آن‌هایید لغو می‌شوند.</li>
            <li>قراردادهای امضاشده برای حفظ اعتبار حقوقی طرف مقابل، با هویت ناشناس («کاربر حذف‌شده») نگهداری می‌شوند.</li>
            <li>اگر مالک فضای کاری با اعضای دیگر هستید، ابتدا باید مالکیت را منتقل کنید.</li>
          </ul>
          <DeleteAccountForm />
        </section>
      </div>
    </Shell>
  );
}
