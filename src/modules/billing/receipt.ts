import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { invoices, payments } from "@/db/schema";
import { getPlanById } from "./catalog";
import { paymentPhase, type PaymentPhaseInfo } from "./payment-status";

export type PaymentReceipt = {
  id: number;
  kind: "subscription" | "topup";
  title: string;
  months: number;
  amount: number;
  gateway: string;
  refId: string | null;
  createdAt: Date;
  paidAt: Date | null;
  phase: PaymentPhaseInfo;
  invoice: { id: number; number: string } | null;
};

/**
 * رسید یک پرداخت اشتراک/شارژ همان فضای کاری (برای صفحه‌ی نتیجه‌ی پرداخت).
 * همه‌چیز از دیتابیس خوانده می‌شود، نه از آدرس؛ پرداخت فضای کاری دیگر یا پرداخت قرارداد همیشه `null` است.
 */
export async function paymentReceipt(workspaceId: number, paymentId: number): Promise<PaymentReceipt | null> {
  if (!Number.isInteger(paymentId) || paymentId < 1) return null;
  const [p] = await db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.workspaceId, workspaceId)));
  if (!p || p.kind === "contract") return null;
  const kind = p.kind === "topup" ? "topup" : "subscription";
  const plan = kind === "subscription" ? await getPlanById(p.plan).catch(() => null) : null;
  const [inv] = kind === "subscription" ? await db.select({ id: invoices.id, number: invoices.number }).from(invoices).where(and(eq(invoices.paymentId, p.id), eq(invoices.kind, "invoice"))) : [];
  return {
    id: p.id,
    kind,
    title: kind === "topup" ? "شارژ کیف پول" : `اشتراک «${plan?.name ?? p.plan}»`,
    months: p.months,
    amount: p.amount,
    gateway: p.gateway,
    refId: p.refId,
    createdAt: p.createdAt,
    paidAt: p.paidAt,
    phase: paymentPhase(p),
    invoice: inv ?? null,
  };
}

/** شارژهای کیف پول که هنوز تکمیل نشده‌اند (در انتظار/در حال بررسی/ناتمام) — تا کاربری که پرداخت کرده ولی برنگشته آن را ببیند و بررسی کند */
export async function recentOpenTopups(workspaceId: number, days = 7) {
  const { desc, gte, ne } = await import("drizzle-orm");
  const rows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.workspaceId, workspaceId), eq(payments.kind, "topup"), ne(payments.status, "paid"), gte(payments.createdAt, new Date(Date.now() - days * 86_400_000))))
    .orderBy(desc(payments.createdAt))
    .limit(5);
  return rows.map((p) => ({ id: p.id, amount: p.amount, gateway: p.gateway, createdAt: p.createdAt, phase: paymentPhase(p) }));
}
