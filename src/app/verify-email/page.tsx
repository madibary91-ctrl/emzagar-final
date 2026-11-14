import { redirect } from "next/navigation";
import AuthFrame from "@/components/AuthFrame";
import VerifyEmailForm from "@/components/VerifyEmailForm";
import { getCurrentUser, readPendingVerify } from "@/modules/auth/session";
import { showDevSecrets } from "@/modules/auth/email-verify";
import { homeFor } from "@/modules/tenancy/context";

export const dynamic = "force-dynamic";
export const metadata = { title: "تأیید ایمیل", robots: { index: false, follow: false } };

function maskEmail(email: string): string {
  const [local, domain = ""] = email.split("@");
  return `${local.slice(0, 2)}${"*".repeat(Math.max(1, Math.min(6, local.length - 2)))}@${domain}`;
}

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ dev?: string; err?: string }> }) {
  const current = await getCurrentUser();
  if (current) redirect(await homeFor(current.id));
  const pending = await readPendingVerify();
  if (!pending) redirect("/login");
  if (pending.emailVerifiedAt) redirect("/login?verified=1");
  const { dev, err } = await searchParams;
  return (
    <AuthFrame title="ایمیل خود را تأیید کنید" subtitle="برای جلوگیری از ثبت‌نام با ایمیل جعلی یا ایمیل دیگران، مالکیت ایمیل شما باید تأیید شود.">
      <VerifyEmailForm maskedEmail={maskEmail(pending.email)} devCode={showDevSecrets() && dev && /^\d{6}$/.test(dev) ? dev : undefined} initialError={err === "1"} />
    </AuthFrame>
  );
}
