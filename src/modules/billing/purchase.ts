import { getPlanById } from "./catalog";
import { planOffersMonths, planPrice, type Plan } from "./plans";
import { getSubscription } from "./subscription";

export type PurchaseQuote = { ok: true; plan: Plan; amount: number } | { ok: false; error: string };

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
  const amount = planPrice(plan, months);
  if (amount <= 0) return { ok: false, error: "طرح نامعتبر است" };
  return { ok: true, plan, amount };
}
