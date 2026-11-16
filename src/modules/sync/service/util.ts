import { wpConnections } from "@/db/schema";

/**
 * موتور همگام‌سازی دوطرفه‌ی ووکامرس ↔ ابر امضاگیر
 * ───────────────────────────────────────────────
 * وردپرس → ابر : سفارش‌ها، تغییر وضعیت، استرداد، مشتریان (دسته‌ای، ایدمپوتنت، با امضای HMAC)
 * ابر → وردپرس : وضعیت قرارداد (صدور/امضا/تکمیل/رد/انقضا/لغو) از طریق صف خروجی (Outbox):
 *   ۱) Push فوری و امضاشده به /wp-json/emzagar/v1/events (برای سایت‌های قابل‌دسترس)
 *   ۲) Pull توسط افزونه (برای سایت‌های پشت فایروال/لوکال) + تایید دریافت (ACK)
 *   ۳) تلاش مجدد با backoff نمایی؛ رویداد تحویل‌نشده تا ۷ روز نگه داشته می‌شود.
 */

export type Conn = typeof wpConnections.$inferSelect;
export const MAX_BATCH = 50;
const DEAD_AFTER_MS = 7 * 24 * 3600_000;
export const FINAL_ORDER_BAD = new Set(["cancelled", "failed", "refunded"]);
export const SYNC_CONTRACT_EVENTS = ["contract.issued", "contract.signed", "contract.completed", "contract.rejected", "contract.expired", "contract.cancelled", "contract.reminder"] as const;
export const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
export const int = (v: unknown) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 && n < 2_000_000_000 ? n : 0;
};
export const money = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) < 1e15 ? n.toFixed(2) : "0.00";
};
export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "" || v === 0) return null;
  const n = Number(v);
  const d = Number.isFinite(n) && n > 0 ? new Date(n < 1e11 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) || d.getFullYear() < 2000 || d.getFullYear() > 2100 ? null : d;
}
