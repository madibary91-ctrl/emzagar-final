import { escapeHtml } from "@/lib/html";
import { logAudit } from "@/modules/audit/service";
import { sendMail } from "@/modules/mail";
import { sendSms } from "@/modules/sms";
import { sendOtpViaMessenger } from "@/modules/messengers/send";
import { getAllSettings } from "@/modules/settings/service";
import { createOtp, OTP_MAX_SENDS_PER_HOUR, OTP_RESEND_SECONDS, otpSendsInLastHour, secondsUntilResend } from "./otp";
import { devSecretsAllowed, type ActionResult } from "./types";

/**
 * ساخت و ارسال کد OTP امضا (مشترک بین مسیر «حساب کاربری» و «لینک بدون ثبت‌نام»).
 * اگر پنل پیامک واقعی در دسترس نبود (حالت آزمایشی) یا ارسال شکست خورد، کد به ایمیل هم می‌رسد.
 */
export async function deliverSigningOtp(p: {
  contractId: number;
  workspaceId: number;
  signer: { id: number };
  user: { id: number; mobile: string; email: string };
}): Promise<ActionResult> {
  const { contractId, signer, user } = p;
  if (!/^09\d{9}$/.test(user.mobile)) return { ok: false, error: "شماره موبایل معتبری برای این امضاکننده ثبت نشده است" };
  const wait = await secondsUntilResend(signer.id);
  if (wait > 0) return { ok: false, error: `برای ارسال مجدد ${wait} ثانیه صبر کنید`, seconds: wait };

  if ((await otpSendsInLastHour(signer.id)) >= OTP_MAX_SENDS_PER_HOUR) {
    await logAudit({ action: "otp.failed", contractId, userId: user.id, detail: "سقف ارسال کد در ساعت (محدودیت نرخ پایدار)" });
    return { ok: false, error: "درخواست‌های ارسال کد زیاد بود؛ حداکثر ۶ کد در ساعت. کمی بعد دوباره تلاش کنید" };
  }

  const code = await createOtp({ contractId, signerId: signer.id, userId: user.id });
  const cfg = await getAllSettings(p.workspaceId);
  // پیام‌رسان (فقط چت‌های با شماره‌ی گواهی‌شده): در حالت «prefer» پیامک (هزینه و اختلال) کنار گذاشته می‌شود
  const viaMsg = await sendOtpViaMessenger({ userId: user.id, workspaceId: p.workspaceId, contractId, code, siteName: cfg.site_name }).catch(() => ({ delivered: 0, skipSms: false }));
  const res: Awaited<ReturnType<typeof sendSms>> = viaMsg.skipSms ? { ok: true, testMode: false } : await sendSms({ to: user.mobile, token: code, text: `کد تایید امضای قرارداد در ${cfg.site_name}: ${code}` }, contractId);
  await logAudit({
    action: "otp.sent",
    contractId,
    userId: user.id,
    detail: `به شماره ${user.mobile.slice(0, 4)}***${user.mobile.slice(-2)}${viaMsg.delivered ? " (پیام‌رسان)" : ""}${res.ok ? "" : " (ناموفق: " + res.error + ")"}`,
  });
  let emailed = false;
  if ((res.testMode || !res.ok) && user.email && !user.email.endsWith(".invalid")) {
    const m = await sendMail({
      to: user.email,
      subject: `کد تایید امضا — ${cfg.site_name}`,
      html: `<div dir="rtl" style="font-family:Tahoma,sans-serif;line-height:2"><p>کد تایید امضای قرارداد در ${escapeHtml(cfg.site_name)}:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px" dir="ltr">${code}</p><p style="color:#666;font-size:12px">این کد ۵ دقیقه اعتبار دارد. اگر شما درخواست نداده‌اید این ایمیل را نادیده بگیرید.</p></div>`,
      contractId,
    });
    emailed = m.status === "sent";
  }
  if (!res.ok && !emailed) return { ok: false, error: "ارسال پیامک ناموفق بود: " + res.error };
  return { ok: true, emailed, seconds: OTP_RESEND_SECONDS, devCode: res.testMode && devSecretsAllowed() ? code : undefined };
}
