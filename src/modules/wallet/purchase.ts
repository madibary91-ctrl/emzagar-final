import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { payments } from "@/db/schema";
import { logAudit } from "@/modules/audit/service";
import { activateSubscription } from "@/modules/billing/subscription";
import { quotePurchase } from "@/modules/billing/purchase";
import { issueInvoiceForPayment } from "@/modules/billing/invoices";
import { applyWalletOps, getWallet } from "./service";

/**
 * خرید/تمدید اشتراک از موجودی کیف پول (بدون درگاه).
 * ردیف پرداخت با درگاه «wallet» ثبت می‌شود تا در تاریخچه دیده شود؛ در درآمد پلتفرم دوباره حساب نمی‌شود
 * (پول هنگام شارژ کیف پول از درگاه، درآمد ثبت شده است).
 */
export async function payPlanWithWallet(p: { workspaceId: number; userId: number; plan: string; months: number }): Promise<{ ok: true; message: string; paymentId?: number } | { ok: false; error: string; shortfall?: number }> {
  const quote = await quotePurchase(p.workspaceId, p.plan, p.months);
  if (!quote.ok) return { ok: false, error: quote.error };
  const { plan, amount, proration } = quote;
  const [row] = await db
    .insert(payments)
    .values({ workspaceId: p.workspaceId, userId: p.userId, plan: plan.id, months: p.months, amount, gateway: "wallet", kind: "subscription", authority: `wallet-${crypto.randomBytes(12).toString("hex")}`, listPrice: proration.listPrice, creditToman: proration.discount + Math.floor((proration.bonusDays * proration.listPrice) / (p.months * 30)), bonusDays: proration.bonusDays })
    .returning({ id: payments.id });
  const debit = await applyWalletOps(p.workspaceId, [{ asset: "toman", delta: -amount, kind: "plan_purchase", ref: `plan:${row.id}`, description: `اشتراک ${plan.name} — ${p.months} ماه`, userId: p.userId }]);
  if (!debit.ok) {
    await db.delete(payments).where(eq(payments.id, row.id));
    if (debit.reason === "insufficient") {
      const { balance } = await getWallet(p.workspaceId).catch(() => ({ balance: 0 }));
      const shortfall = Math.max(0, amount - balance);
      return { ok: false, shortfall, error: `موجودی کیف پول کافی نیست؛ ${shortfall.toLocaleString("fa-IR")} تومان کم دارید. ابتدا کیف پول را شارژ کنید.` };
    }
    return { ok: false, error: "پرداخت انجام نشد؛ دوباره تلاش کنید." };
  }
  try {
    await activateSubscription(p.workspaceId, plan.id, p.months, { paymentId: row.id });
  } catch (e) {
    // فعال‌سازی شکست خورد: وجه به کیف پول برمی‌گردد
    await applyWalletOps(p.workspaceId, [{ asset: "toman", delta: amount, kind: "refund", ref: `plan:${row.id}:refund`, description: "بازگشت وجه (فعال‌سازی اشتراک انجام نشد)", userId: p.userId }]);
    await db.update(payments).set({ status: "failed", error: "activation_failed" }).where(eq(payments.id, row.id));
    throw e;
  }
  await db.update(payments).set({ status: "paid", paidAt: new Date(), refId: `W-${row.id}` }).where(eq(payments.id, row.id));
  // فاکتور رسمی (خرید از کیف پول هم خدمت است؛ شارژ کیف پول فاکتور ندارد). خطای صدور خرید را بی‌اثر نمی‌کند؛ زمان‌بند ترمیم می‌کند.
  await db.transaction((tx) => issueInvoiceForPayment(tx, row.id)).catch((e) => console.error("[invoice:issue:wallet]", e instanceof Error ? e.message : e));
  await logAudit({ action: "billing.paid", workspaceId: p.workspaceId, userId: p.userId, detail: `${plan.name} — ${p.months} ماه — از کیف پول` });
  return { ok: true, message: "اشتراک با موجودی کیف پول فعال شد", paymentId: row.id };
}
