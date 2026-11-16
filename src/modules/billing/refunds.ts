import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { payments, refunds, subscriptions } from "@/db/schema";
import { logAudit } from "@/modules/audit/service";
import { notifyTeam } from "@/modules/inbox/service";
import { creditToman } from "@/modules/wallet/service";
import { getPlanById } from "./catalog";
import { issueCreditNote } from "./invoices";
import { DAY_MS, effectiveDailyRate } from "./proration";

export type RefundMethod = "wallet" | "manual";
export type RefundInput = { paymentId: number; /** خالی = تمام مبلغ باقی‌مانده */ amount?: number; reason: string; method: RefundMethod; revokeSubscription: boolean; actorId: number };
export type RefundResult = { ok: true; refundId: number; amount: number; creditNote: string; revoked: boolean } | { ok: false; error: string };

/**
 * بازپرداخت پرداخت اشتراک (فقط مدیر کل؛ فراخواننده باید مجوز را بسنجد).
 *
 * اتمی و ایدمپوتنت‌ساز: ردیف پرداخت FOR UPDATE قفل می‌شود و `refunded_amount` در همان تراکنشی که کیف پول شارژ و اعلامیه‌ی بستانکاری صادر می‌شود
 * افزایش می‌یابد؛ دو بازپرداخت هم‌زمان هرگز از مبلغ پرداخت بیشتر نمی‌شوند و کرش وسط کار = برگشت کامل.
 *  - wallet: بازگشت آنی به کیف پول فضای کاری (دفتر کل با ref یکتای refund:<id>).
 *  - manual: بازگشت بانکی خارج از سامانه؛ فقط ثبت می‌شود (پرداخت‌های آزمایشی فقط همین روش را می‌پذیرند تا پول جعلی به کیف پول واقعی وارد نشود).
 */
export async function refundPayment(input: RefundInput): Promise<RefundResult> {
  const reason = input.reason.trim().slice(0, 200);
  if (!reason) return { ok: false, error: "دلیل بازپرداخت را بنویسید" };
  let outcome: { refundId: number; amount: number; creditNote: string; revoked: boolean; workspaceId: number; planId: string; userId: number };
  try {
    outcome = await db.transaction(async (tx) => {
      const [pay] = await tx.select().from(payments).where(eq(payments.id, input.paymentId)).for("update");
      if (!pay) throw new RefundError("پرداخت یافت نشد");
      if (pay.status !== "paid" || pay.kind !== "subscription" || !pay.fulfilledAt) throw new RefundError("فقط پرداخت موفق اشتراک قابل بازپرداخت است");
      const refundable = pay.amount - pay.refundedAmount;
      if (refundable <= 0) throw new RefundError("این پرداخت پیش‌تر به‌طور کامل بازپرداخت شده است");
      const amount = input.amount === undefined || Number.isNaN(input.amount) ? refundable : Math.round(input.amount);
      if (!Number.isInteger(amount) || amount < 1) throw new RefundError("مبلغ بازپرداخت نامعتبر است");
      if (amount > refundable) throw new RefundError(`حداکثر مبلغ قابل بازپرداخت ${refundable.toLocaleString("fa-IR")} تومان است`);
      // پرداخت از کیف پول: وجه اصلاً از درگاه نیامده؛ بازگشت فقط به کیف پول معنا دارد
      const method: RefundMethod = pay.gateway === "wallet" ? "wallet" : input.method;
      const isTest = pay.test || pay.gateway === "sandbox";
      if (method === "wallet" && isTest && pay.gateway !== "wallet") throw new RefundError("پرداخت آزمایشی را فقط می‌توان «دستی» ثبت کرد (واریز به کیف پول واقعی ممنوع است)");

      const [ref] = await tx.insert(refunds).values({ paymentId: pay.id, workspaceId: pay.workspaceId, amount, method, reason, actorId: input.actorId }).returning({ id: refunds.id });
      const note = await issueCreditNote(tx, { paymentId: pay.id, amount, reason, refundedTotal: pay.refundedAmount + amount, paymentAmount: pay.amount });
      await tx.update(payments).set({ refundedAmount: pay.refundedAmount + amount }).where(eq(payments.id, pay.id));
      if (method === "wallet") {
        const r = await creditToman(pay.workspaceId, amount, { kind: "refund", ref: `refund:${ref.id}`, description: `بازپرداخت اشتراک — ${reason}`, userId: input.actorId, exec: tx });
        if (!r.ok) throw new Error(`wallet_refund_failed:${r.reason}`);
      }
      let revoked = false;
      if (input.revokeSubscription) {
        // فقط اگر اشتراک فعلی همان طرح پرداخت‌شده است (اشتراک خرید دیگر را لغو نمی‌کنیم)
        const gone = await tx.delete(subscriptions).where(and(eq(subscriptions.workspaceId, pay.workspaceId), eq(subscriptions.plan, pay.plan))).returning({ w: subscriptions.workspaceId });
        revoked = gone.length > 0;
      }
      await tx.update(refunds).set({ creditNoteId: note.id, revoked }).where(eq(refunds.id, ref.id));
      return { refundId: ref.id, amount, creditNote: note.number, revoked, workspaceId: pay.workspaceId, planId: pay.plan, userId: pay.userId };
    });
  } catch (e) {
    if (e instanceof RefundError) return { ok: false, error: e.message };
    console.error("[refund]", e);
    return { ok: false, error: "بازپرداخت انجام نشد؛ دوباره تلاش کنید" };
  }
  const planName = (await getPlanById(outcome.planId).catch(() => null))?.name ?? outcome.planId;
  await logAudit({ action: "billing.refund", workspaceId: outcome.workspaceId, userId: input.actorId, detail: `${outcome.amount.toLocaleString("fa-IR")} تومان — ${planName} — ${input.method === "wallet" ? "کیف پول" : "دستی"} — ${reason}` }).catch(() => undefined);
  await notifyTeam(
    outcome.workspaceId,
    { kind: "info", title: "بازپرداخت اشتراک ثبت شد", body: `${outcome.amount.toLocaleString("fa-IR")} تومان از اشتراک «${planName}» بازپرداخت شد${outcome.revoked ? " و اشتراک پایان یافت" : ""}. اعلامیه‌ی بستانکاری ${outcome.creditNote} در بخش فاکتورها موجود است.`, href: "/admin/billing/invoices" },
    [outcome.userId],
    ["owner", "admin"],
  ).catch(() => 0);
  return { ok: true, refundId: outcome.refundId, amount: outcome.amount, creditNote: outcome.creditNote, revoked: outcome.revoked };
}

class RefundError extends Error {}

/**
 * مبلغ پیشنهادی بازپرداخت «به نسبت روزهای باقی‌مانده»: ارزش روزانه‌ی دوره × روزهای مانده، حداکثر تا سقف باقی‌مانده‌ی پرداخت.
 * برای پرداختی که دوره‌اش تمام شده یا طرح فعلی چیز دیگری است، صفر.
 */
export async function suggestedRefund(paymentId: number): Promise<{ amount: number; remainingDays: number }> {
  const [pay] = await db.select().from(payments).where(eq(payments.id, paymentId));
  if (!pay || pay.status !== "paid") return { amount: 0, remainingDays: 0 };
  const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.workspaceId, pay.workspaceId), eq(subscriptions.plan, pay.plan)));
  if (!sub?.currentPeriodEnd || sub.currentPeriodEnd <= new Date()) return { amount: 0, remainingDays: 0 };
  const rate = await effectiveDailyRate(sub);
  const remainingDays = (sub.currentPeriodEnd.getTime() - Date.now()) / DAY_MS;
  return { amount: Math.max(0, Math.min(pay.amount - pay.refundedAmount, Math.floor(remainingDays * rate))), remainingDays: Math.round(remainingDays * 10) / 10 };
}

export async function listRefunds(limit = 30) {
  return db.select().from(refunds).orderBy(desc(refunds.createdAt)).limit(limit);
}
