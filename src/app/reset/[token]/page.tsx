import Link from "next/link";
import AuthFrame from "@/components/AuthFrame";
import { ResetForm } from "@/components/AuthForms";
import { findResetToken } from "@/modules/auth/tokens";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const row = await findResetToken(token);
  if (!row) {
    return (
      <AuthFrame title="لینک نامعتبر است" subtitle="این لینک استفاده شده یا مهلت آن تمام شده است.">
        <Link href="/forgot" className="btn-primary w-full">درخواست لینک جدید</Link>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="تعیین رمز عبور" subtitle={`${row.name} عزیز، رمز جدید حساب ${row.email} را تعیین کنید.`}>
      <ResetForm token={token} />
    </AuthFrame>
  );
}
