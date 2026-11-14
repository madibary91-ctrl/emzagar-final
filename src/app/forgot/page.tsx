import AuthFrame from "@/components/AuthFrame";
import { ForgotForm } from "@/components/AuthForms";

export const dynamic = "force-dynamic";

export default function ForgotPage() {
  return (
    <AuthFrame title="بازیابی رمز عبور" subtitle="ایمیل حساب خود را وارد کنید تا لینک تعیین رمز جدید برایتان ارسال شود.">
      <ForgotForm />
    </AuthFrame>
  );
}
