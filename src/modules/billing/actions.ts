"use server";

import { redirect } from "next/navigation";
import { requireTeam } from "@/modules/tenancy/context";
import { getOrigin } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/modules/audit/service";
import { payPlanWithWallet } from "@/modules/wallet/purchase";
import { startCheckout } from "./service";

export type CheckoutState = { error?: string };

/** شروع پرداخت: فقط مالک/مدیر؛ مبلغ از روی طرح در سرور محاسبه می‌شود (نه از ورودی کاربر) */
export async function checkoutAction(_prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  const team = await requireTeam("settings");
  if (!rateLimit(`checkout:${team.id}`, 10, 10 * 60_000).ok) return { error: "درخواست‌های پرداخت زیاد بود؛ چند دقیقه بعد تلاش کنید." };
  const plan = String(formData.get("plan") || "");
  const months = Number(formData.get("months"));
  // پرداخت از موجودی کیف پول (بدون درگاه)
  if (formData.get("method") === "wallet") {
    const r = await payPlanWithWallet({ workspaceId: team.workspaceId, userId: team.id, plan, months });
    if (!r.ok) return { error: r.error };
    redirect(`/admin/billing?pay=ok&msg=${encodeURIComponent(r.message)}`);
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
