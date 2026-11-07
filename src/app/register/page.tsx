import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Gift } from "lucide-react";
import AuthFrame from "@/components/AuthFrame";
import { RegisterForm } from "@/components/AuthForms";
import { getCurrentUser } from "@/modules/auth/session";
import { homeFor } from "@/modules/tenancy/context";
import { normalizeReferralCode } from "@/modules/referral/config";
import { getReferralConfig, resolveCode } from "@/modules/referral/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "ساخت فضای کاری", alternates: { canonical: "/register" } };

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ ref?: string }> }) {
  const user = await getCurrentUser();
  if (user) redirect(await homeFor(user.id));
  const sp = await searchParams;
  const jar = await cookies();
  const code = normalizeReferralCode(sp.ref || jar.get("amz_ref")?.value || "");
  // کد دعوت فقط وقتی نمایش داده می‌شود که واقعاً معتبر باشد (کد ساختگی نباید در فرم بماند)
  const [cfg, valid] = await Promise.all([getReferralConfig(), code ? resolveCode(code) : Promise.resolve(null)]);
  const ref = cfg.enabled && valid ? code : "";
  return (
    <AuthFrame title="فضای کاری خودتان را بسازید" subtitle="هر کسب‌وکار یک فضای کاری مستقل دارد: قراردادها، قالب‌ها، مشتریان، لاگ‌ها و تنظیمات شما با هیچ مشتری دیگری مخلوط نمی‌شود. بعداً می‌توانید اعضای تیم را دعوت کنید.">
      {ref && (
        <p role="status" className="mb-4 flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold leading-6 text-emerald-800">
          <Gift size={16} className="mt-1 shrink-0" />
          <span>با دعوت یکی از دوستانتان آمده‌اید.{cfg.referredWallet > 0 && <> پس از صدور اولین قرارداد، <b>{cfg.referredWallet.toLocaleString("fa-IR")} تومان</b> هدیه‌ی خوشامد به کیف پول شما اضافه می‌شود.</>}</span>
        </p>
      )}
      <RegisterForm defaultRef={ref} />
    </AuthFrame>
  );
}
