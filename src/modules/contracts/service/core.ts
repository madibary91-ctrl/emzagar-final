import { type LegalInfo } from "@/modules/signing/stages";
import { contractSigners, contracts } from "@/db/schema";
import { fa, faNum } from "@/lib/jalali";
import { getAllSettings } from "@/modules/settings/service";

export type Contract = typeof contracts.$inferSelect;
export type Signer = typeof contractSigners.$inferSelect;
export const STATUS_LABELS: Record<string, string> = {
  draft: "پیش‌نویس",
  sent: "ارسال شده",
  signed: "امضا شده",
  rejected: "رد شده",
  expired: "منقضی شده",
  cancelled: "لغو شده",
};
export const ADMIN_STATUSES = ["draft", "sent", "signed", "rejected", "expired", "cancelled"];
/** مهلت امضا: مقدار صریح، یا پیش‌فرض تنظیمات؛ صفر یعنی بدون انقضا */
export async function resolveExpiry(days: number | null | undefined, workspaceId: number): Promise<Date | null> {
  let d = days;
  if (d === undefined || d === null || Number.isNaN(d)) {
    d = Number((await getAllSettings(workspaceId)).default_expiry_days) || 0;
  }
  if (d <= 0) return null;
  return new Date(Date.now() + Math.min(d, 3650) * 86400000);
}
/** مشخصات اختیاری هر طرف امضا در زمان صدور (همه پیش‌فرض‌های «عادی» دارند) */
export interface SignerSpec extends Partial<LegalInfo> {
  /** مرحله‌ی دلخواه (فقط در حالت مرحله‌ای) */
  stage?: number | null;
  sealRequired?: boolean;
  initialsRequired?: boolean;
}
/** برچسب‌ها: حداکثر ۸ مورد، هرکدام تا ۲۴ نویسه، بدون تکرار و بدون ویرگول داخلی */
export function normalizeTags(raw: string): string {
  const seen = new Set<string>();
  for (const part of String(raw || "").split(/[,،\n]/)) {
    const t = part.replace(/\s+/g, " ").trim().slice(0, 24);
    if (t) seen.add(t);
    if (seen.size >= 8) break;
  }
  return [...seen].join(",");
}
export function parseTags(raw: string | null | undefined): string[] {
  return (raw ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}
type Cfg = Awaited<ReturnType<typeof getAllSettings>>;
export function varsFor(customer: { name: string; email: string; mobile: string }, number: string, cfg: Cfg, extra?: { productName?: string; amount?: number }) {
  return {
    USER_NAME: customer.name,
    USER_EMAIL: customer.email,
    USER_MOBILE: customer.mobile,
    CONTRACT_NUMBER: number,
    DATE: fa(new Date()),
    SITE_NAME: cfg.site_name,
    PRODUCT_NAME: extra?.productName ?? "",
    AMOUNT: extra?.amount !== undefined ? faNum(extra.amount) : "",
  };
}
