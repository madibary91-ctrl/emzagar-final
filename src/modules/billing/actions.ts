"use server";

import { redirect } from "next/navigation";
import { requireTeam } from "@/modules/tenancy/context";
import { getOrigin } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/modules/audit/service";
import { payPlanWithWallet } from "@/modules/wallet/purchase";
import { flashQuery } from "@/lib/flash";
import { recheckPayment } from "@/modules/payments/service";
import { startCheckout } from "./service";

export type CheckoutState = { error?: string; /** کمبود موجودی کیف پول (تومان) برای پیشنهاد شارژ یک‌کلیکی */ shortfall?: number };

/** شروع پرداخت: فقط مالک/مدیر؛ مبلغ از روی طرح در سرور محاسبه می‌شود (نه از ورودی کاربر) */
export async function checkoutAction(_prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  const team = await requireTeam("settings");
  if (!rateLimit(`checkout:${team.id}`, 10, 10 * 60_000).ok) return { error: "درخواست‌های پرداخت زیاد بود؛ چند دقیقه بعد تلاش کنید." };
  const plan = String(formData.get("plan") || "");
  const months = Number(formData.get("months"));
  // پرداخت از موجودی کیف پول (بدون درگاه)
  if (formData.get("method") === "wallet") {
    const r = await payPlanWithWallet({ workspaceId: team.workspaceId, userId: team.id, plan, months });
    if (!r.ok) return { error: r.error, ...(r.shortfall ? { shortfall: r.shortfall } : {}) };
    redirect(`/admin/billing?${flashQuery("ok", r.message, r.paymentId)}`);
  }
  let url = "";
  try {
    url = await startCheckout({ workspaceId: team.workspaceId, userId: team.id, plan, months, origin: await getOrigin(), gateway: String(formData.get("gateway") || "") || undefined });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "خطا در اتصال به درگاه پرداخت" };
  }
  await logAudit({ action: "billing.checkout", workspaceId: team.workspaceId, userId: team.id, detail: `${plan} — ${months} ماه` });
  redirect(url);
}

/**
 * «بررسی وضعیت» پرداختِ معلق از تاریخچه: کاربری که پرداخت کرده ولی به سایت برنگشته (بستن تب، قطع اینترنت) بدون پشتیبانی هم می‌تواند
 * نتیجه را از درگاه بگیرد. فقط پرداخت‌های همین فضای کاری؛ نتیجه با پیام امضاشده به همان صفحه برمی‌گردد.
 */
export async function recheckPaymentAction(formData: FormData): Promise<void> {
  const team = await requireTeam("settings");
  const id = Number(formData.get("id"));
  const dest = formData.get("from") === "wallet" ? "/admin/wallet" : "/admin/billing";
  if (!rateLimit(`recheck:${team.id}`, 10, 5 * 60_000).ok) redirect(`${dest}?${flashQuery("error", "درخواست بررسی زیاد بود؛ چند دقیقه بعد دوباره تلاش کنید.")}`);
  if (!Number.isInteger(id) || id < 1) redirect(`${dest}?${flashQuery("error", "تراکنش یافت نشد")}`);
  let r: Awaited<ReturnType<typeof recheckPayment>>;
  try {
    r = await recheckPayment(team.workspaceId, id);
  } catch {
    r = { ok: false, message: "بررسی وضعیت الان ممکن نشد؛ چند دقیقه بعد دوباره تلاش کنید." };
  }
  await logAudit({ action: "billing.recheck", workspaceId: team.workspaceId, userId: team.id, detail: `پرداخت ${id} — ${r.ok ? "تایید" : "نامشخص"}` }).catch(() => undefined);
  redirect(`${r.kind === "topup" ? "/admin/wallet" : dest}?${flashQuery(r.ok ? "ok" : "error", r.message, id)}`);
}
