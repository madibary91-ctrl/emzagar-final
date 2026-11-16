import { and, eq } from "drizzle-orm";
import { db, inTransaction } from "@/db";
import { contracts, orders } from "@/db/schema";

/**
 * هسته‌ی «ماشین حالت» قرارداد (GLM A-1/A-2/A-3).
 *
 * قاعده‌ی طلایی: هر انتقال وضعیت (امضای نهایی، لغو، رد، انقضا، انتشار، تمدید) «داخل یک تراکنش» و
 * «پس از قفل‌کردن ردیف قرارداد» انجام می‌شود و وضعیت «زیر همان قفل» دوباره سنجیده می‌شود.
 * دلیل: در READ COMMITTED، سنجش وضعیت پیش از تراکنش (یا از شیء قدیمیِ بارگذاری‌شده) کهنه است؛
 * مثلاً امضای آخرین نفر پس از لغوِ هم‌زمان، قراردادِ لغوشده را «امضاشده» می‌کرد.
 * همه‌ی مسیرها از یک نوع قفل (`FOR NO KEY UPDATE`) استفاده می‌کنند تا یکدیگر را سریال کنند،
 * بی‌آنکه درج‌های وابسته (کلید خارجی: لاگ، لینک، امضا) را مسدود کنند.
 */
export type ContractRow = typeof contracts.$inferSelect;

/** ردیف قرارداد را (باید داخل withTransaction) قفل می‌کند و «تازه‌ترین» حالت را برمی‌گرداند؛ نبود = null */
export async function lockContract(contractId: number, workspaceId?: number): Promise<ContractRow | null> {
  if (!inTransaction()) throw new Error("lockContract فقط داخل withTransaction مجاز است");
  const [c] = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.id, contractId), workspaceId === undefined ? undefined : eq(contracts.workspaceId, workspaceId)))
    .for("no key update");
  return c ?? null;
}

/**
 * سفارش داخلی مرتبط با قراردادی که «ناموفق» بسته شد (لغو/رد) دیگر «منتظر امضا» نیست (B-9، سمت خودِ سامانه).
 * (سفارش ووکامرس را افزونه‌ی وردپرس با رویداد contract.cancelled/rejected و سیاست `wc_on_reject` به‌روز می‌کند؛ نگاه کنید به docs/GLM-AUDIT8-LIFECYCLE-FA.md)
 * فقط از «منتظر امضا» به «لغوشده» می‌رود؛ سفارش تکمیل‌شده هرگز برنمی‌گردد.
 */
export async function closeLinkedOrder(orderId: number | null | undefined): Promise<void> {
  if (!orderId) return;
  await db.update(orders).set({ status: "cancelled" }).where(and(eq(orders.id, orderId), eq(orders.status, "awaiting_signature")));
}
