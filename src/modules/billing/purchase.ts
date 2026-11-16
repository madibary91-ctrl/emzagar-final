import { getPlanById } from "./catalog";
import { planOffersMonths, planPrice, type Plan } from "./plans";
import { getSubscription } from "./subscription";
import { computeProration, type Proration } from "./proration";

/**
 * `amount` = مبلغ نهایی قابل پرداخت (پس از کسر اعتبار Proration). `proration` جزئیات اعتبار روزهای باقی‌مانده‌ی طرح قبلی است
 * (بدون اشتراک فعالِ طرح دیگر: اعتباری نیست و amount همان قیمت طرح است).
 */
export type PurchaseQuote = { ok: true; plan: Plan; amount: number; proration: Proration } | { ok: false; error: string };

/**
 * تنها نقطه‌ی تصمیم «این فضای کاری می‌تواند این طرح را برای این مدت بخرد؟ و چند تومان؟»
 * (برای پرداخت از درگاه و از کیف پول). مبلغ همیشه سمت سرور از روی طرح دیتابیس محاسبه می‌شود.
 *
 * قابل خرید یعنی: طرح در کاتالوگ باشد، فعال (غیربایگانی) و غیرپایه باشد، قیمت مثبت داشته باشد،
 * مدت خواسته‌شده در مدت‌های همان طرح تعریف شده باشد، و یا عمومی باشد یا فضای کاری هم‌اکنون روی همین طرح خصوصی باشد (تمدید).
 */
export async function quotePurchase(workspaceId: number, planId: string, months: number): Promise<PurchaseQuote> {
  const plan = await getPlanById(planId);
  if (!plan || plan.isDefault || !plan.isActive || plan.priceToman <= 0) return { ok: false, error: "طرح نامعتبر است" };
  if (!plan.isPublic) {
    const cur = await getSubscription(workspaceId);
    if (cur.planId !== plan.id) return { ok: false, error: "طرح نامعتبر است" };
  }
  if (!Number.isInteger(months) || !planOffersMonths(plan, months)) return { ok: false, error: "مدت اشتراک نامعتبر است" };
  const listPrice = planPrice(plan, months);
  if (listPrice <= 0) return { ok: false, error: "طرح نامعتبر است" };
  const proration = await computeProration(workspaceId, plan, months);
  return { ok: true, plan, amount: proration.payable, proration };
}
