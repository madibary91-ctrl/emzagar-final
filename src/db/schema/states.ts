import { type AnyColumn, sql, type SQL } from "drizzle-orm";

/**
 * B-1 — «ماشین حالت» قرارداد، امضاکننده، الحاقیه و سفارش؛ تنها منبع حقیقتِ مقادیر مجاز `status`.
 * هم برای قیدهای CHECK دیتابیس (schema.ts ← ddl.ts) و هم برای کد برنامه استفاده می‌شود؛
 * پس هیچ مسیری (حتی SQL دستی، اسکریپت مهاجرت یا باگِ آینده) نمی‌تواند وضعیتِ بی‌معنا بنویسد.
 */
export const CONTRACT_STATUSES = ["draft", "sent", "signed", "rejected", "expired", "cancelled"] as const;
export const SIGNER_STATUSES = ["pending", "signed", "rejected"] as const;
export const AMENDMENT_STATUSES = ["sent", "signed", "rejected", "cancelled"] as const;
export const AMENDMENT_SIGNER_STATUSES = ["pending", "accepted", "rejected"] as const;
export const ORDER_STATUSES = ["awaiting_signature", "completed", "cancelled"] as const;
export const SIGNER_ROLES = ["signer", "witness"] as const;

export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/** `col IN ('a','b',…)` با لیترال‌های درون‌خطی (قید CHECK پارامتر ندارد) — مقادیر فقط از ثابت‌های بالا می‌آیند */
export function inList(col: AnyColumn, values: readonly string[]): SQL {
  return sql`${col} in (${sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", "))})`;
}
