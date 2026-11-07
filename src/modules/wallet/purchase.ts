import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { payments } from "@/db/schema";
import { logAudit } from "@/modules/audit/service";
import { activateSubscription } from "@/modules/billing/subscription";
import { MONTH_DISCOUNT, PLANS, isPlanId, priceFor } from "@/modules/billing/plans";
import { applyWalletOps } from "./service";

/**
 * خرید/تمدید اشتراک از موجودی کیف پول (بدون درگاه).
 * ردیف پرداخت با درگاه «wallet» ثبت می‌شود تا در تاریخچه دیده شود؛ در درآمد پلتفرم دوباره حساب نمی‌شود
 * (پول هنگام شارژ کیف پول از درگاه، درآمد ثبت شده است).
 */
export async function payPlanWithWallet(p: { workspaceId: number; userId: number; plan: string; months: number }): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  if (!isPlanId(p.plan) || p.plan === "free") return { ok: false, error: "طرح نامعتبر است" };
  if (!(p.months in MONTH_DISCOUNT)) return { ok: false, error: "مدت اشتراک نامعتبر است" };
  const amount = priceFor(p.plan, p.months);
  const [row] = await db
    .insert(payments)
    .values({ workspaceId: p.workspaceId, userId: p.userId, plan: p.plan, months: p.months, amount, gateway: "wallet", kind: "subscription", authority: `wallet-${crypto.randomBytes(12).toString("hex")}` })
    .returning({ id: payments.id });
  const debit = await applyWalletOps(p.workspaceId, [{ asset: "toman", delta: -amount, kind: "plan_purchase", ref: `plan:${row.id}`, description: `اشتراک ${PLANS[p.plan].name} — ${p.months} ماه`, userId: p.userId }]);
  if (!debit.ok) {
    await db.delete(payments).where(eq(payments.id, row.id));
    return { ok: false, error: debit.reason === "insufficient" ? "موجودی کیف پول کافی نیست؛ ابتدا کیف پول را شارژ کنید." : "پرداخت انجام نشد؛ دوباره تلاش کنید." };
  }
  try {
    await activateSubscription(p.workspaceId, p.plan, p.months, { paymentId: row.id });
  } catch (e) {
    // فعال‌سازی شکست خورد: وجه به کیف پول برمی‌گردد
    await applyWalletOps(p.workspaceId, [{ asset: "toman", delta: amount, kind: "refund", ref: `plan:${row.id}:refund`, description: "بازگشت وجه (فعال‌سازی اشتراک انجام نشد)", userId: p.userId }]);
    await db.update(payments).set({ status: "failed", error: "activation_failed" }).where(eq(payments.id, row.id));
    throw e;
  }
  await db.update(payments).set({ status: "paid", paidAt: new Date(), refId: `W-${row.id}` }).where(eq(payments.id, row.id));
  await logAudit({ action: "billing.paid", workspaceId: p.workspaceId, userId: p.userId, detail: `${PLANS[p.plan].name} — ${p.months} ماه — از کیف پول` });
  return { ok: true, message: "اشتراک با موجودی کیف پول فعال شد" };
}
