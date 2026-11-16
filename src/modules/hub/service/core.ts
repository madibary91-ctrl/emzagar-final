import { asc, eq } from "drizzle-orm";
import { contractSigners } from "@/db/schema";
import { db } from "@/db";
import { getOrCreateSigningLink, signingUrl } from "@/modules/signing/links";

/**
 * «مرکز فرماندهی کسب‌وکار» (Business Hub)
 * ─────────────────────────────────────────
 * سمت ابر برای افزونه‌ی وردپرس:
 *  • pulse    — نبض لحظه‌ای کسب‌وکار (شاخص‌ها، صف اقدام، روند، ارزش‌آفرینی، عمق یکپارچگی)
 *  • access   — «آیا این مشتری قرارداد امضاشده دارد؟» (دروازه‌ی محتوا/محصول/نقش در وردپرس)
 *  • customer — کارت ۳۶۰ درجه‌ی مشتری (قراردادها + سفارش‌ها) برای پروفایل کاربر و صفحه‌ی سفارش
 *  • trust    — پروفایل اعتماد عمومی کسب‌وکار (نشان اعتماد روی سایت مشتری)
 *  • depth    — امتیاز «عمق یکپارچگی» و گام‌های بعدی پیشنهادی
 */

export const DAY = 86400000;
export const MANUAL_HOURS_PER_CONTRACT = 0.75; // برآورد کار دستی حذف‌شده برای هر قرارداد (چاپ، پیگیری، بایگانی، تطبیق)

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export const normEmail = (v: unknown) => String(v ?? "").trim().toLowerCase().slice(0, 254);
export const isEmail = (v: string) => EMAIL.test(v);
export const num = (v: unknown, max = 1_000_000) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
};
export const bool = (v: unknown) => v === true || v === 1 || v === "1" || v === "yes";
/* ───────────── نبض کسب‌وکار ───────────── */

export type AttentionKind = "stale" | "expiring" | "renewal" | "rejected";
export function trustCode(slug: string) {
  return slug;
}
/* ───────────── دروازه‌ی دسترسی ───────────── */

export async function firstSignUrl(contractId: number, workspaceId: number): Promise<string | null> {
  const [first] = await db.select({ id: contractSigners.id }).from(contractSigners).where(eq(contractSigners.contractId, contractId)).orderBy(asc(contractSigners.position)).limit(1);
  const sl = first ? await getOrCreateSigningLink(first.id) : null;
  return sl ? await signingUrl(sl.token, workspaceId) : null;
}
