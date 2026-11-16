import { and, eq, gte, inArray, isNull, like, or } from "drizzle-orm";
import { payments } from "@/db/schema";
import { db } from "@/db";
import { GATEWAY_SESSION_MS, VERIFY_PENDING, VERIFY_RETRY_HORIZON_MS } from "@/modules/payments/types";
import { CONTRACT_PLAN_PREFIX } from "./fulfill";

/**
 * MX-02 — پرداخت‌های «در جریان» که هنوز ممکن است به یک قسط اعمال شوند.
 *
 * یک پرداخت قسط تا وقتی «اعمال‌شده» نیست، به شناسه‌ی همان ردیف قسط وابسته است (`payments.plan = contract:<installmentId>`).
 * جایگزینی برنامه‌ی پرداخت ردیف‌های قسط را حذف و با شناسه‌ی جدید می‌سازد؛ پس باید تا وقتی هر پرداختی «شاید هنوز برسد» مسدود بماند:
 *  - `gateway`  : در انتظار بازگشت از صفحه‌ی درگاه (تا ۲ ساعت از ساخت؛ سقف نشست درگاه‌ها).
 *  - `verifying`: کاربر بازگشته و درگاه گفته «پرداخت شد/نامعلوم» ولی تایید با درگاه تکمیل نشده (verify_pending؛ پولِ احتمالاً کسرشده).
 *                 تا افق تلاش مجدد زمان‌بند (۴۸ ساعت) مسدود می‌ماند، نه ۳۰ دقیقه — عدد قبلی کوتاه‌تر از افق تلاش مجدد بود
 *                 و پرداختی که بعداً تایید می‌شد به قسطِ حذف‌شده می‌رسید (پول گرفته‌شده و بدون قسط).
 *  - `unapplied`: paid ولی اثرش اعمال نشده (fulfilled_at خالی؛ باقیمانده‌ی نسخه‌های قدیمی) تا ترمیم‌گر اعمالش کند.
 */
export type InflightPayment = { id: number; reason: "gateway" | "verifying" | "unapplied" };

export async function inflightInstallmentPayments(workspaceId: number, installmentIds: number[]): Promise<InflightPayment[]> {
  if (installmentIds.length === 0) return [];
  const now = Date.now();
  const rows = await db
    .select({ id: payments.id, status: payments.status, error: payments.error })
    .from(payments)
    .where(
      and(
        eq(payments.workspaceId, workspaceId),
        inArray(payments.plan, installmentIds.map((i) => `${CONTRACT_PLAN_PREFIX}${i}`)),
        or(
          and(eq(payments.status, "pending"), gte(payments.createdAt, new Date(now - GATEWAY_SESSION_MS))),
          and(eq(payments.status, "pending"), like(payments.error, `${VERIFY_PENDING}%`), gte(payments.createdAt, new Date(now - VERIFY_RETRY_HORIZON_MS))),
          and(eq(payments.status, "paid"), isNull(payments.fulfilledAt)),
        ),
      ),
    );
  return rows.map((r) => ({ id: r.id, reason: r.status === "paid" ? "unapplied" : r.error?.startsWith(VERIFY_PENDING) ? "verifying" : "gateway" }));
}
