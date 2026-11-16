import type { Conv } from "./service/core";
import { TtlCache } from "@/lib/ttl-cache";

/**
 * P-07: کش‌های کوتاه‌مدت و «مشترک بین همه‌ی اتصال‌های SSE» همین پروسه.
 *
 * بدون این‌ها هر اتصال زنده هر ۲٫۵ ثانیه ۳ تا ۶ کوئری مستقل می‌زد (خواندن گفتگو، پیام‌ها، حضور پشتیبان، نام مسئول، تیکت، فهرست و شمارنده‌ها)
 * که اغلب «برای همه‌ی اتصال‌ها دقیقاً یک جواب» دارند. اکنون:
 *  - هر نوشتنِ همین پروسه (`chatWake`) کش‌های وابسته را فوراً باطل می‌کند ⇒ در تک‌نمونه هیچ تأخیر/کهنگی‌ای دیده نمی‌شود؛
 *  - نوشتن‌های پروسه‌ی دیگر حداکثر به‌اندازه‌ی TTL (۱ تا ۳ ثانیه؛ کمتر از دوره‌ی poll) دیرتر دیده می‌شود، و هرگز گم نمی‌شود؛
 *  - بارگذاری هم‌زمان یک کلید single-flight است: ۵۰ اتصال به یک گفتگو = ۱ کوئری.
 * در NODE_ENV=test پیش‌فرض خاموش است (آزمون‌ها همیشه داده‌ی تازه می‌بینند).
 */
export const convCache = new TtlCache<string, Conv | null>("CHAT_CONV_CACHE_TTL_MS", 1_000, 5_000);
/** «آیا پشتیبان آنلاین است» به‌ازای هر دامنه (platform | ws:id) */
export const onlineCache = new TtlCache<string, boolean>("CHAT_ONLINE_CACHE_TTL_MS", 3_000, 1_000);
/** نام مسئول / شماره‌ی تیکت (تقریباً هرگز تغییر نمی‌کند) */
export const metaCache = new TtlCache<string, string | null>("CHAT_META_CACHE_TTL_MS", 60_000, 5_000);
/** ردیف‌های صندوق پشتیبان و شمارنده‌ها (مشترک بین همه‌ی پشتیبان‌های همان دامنه) */
export const listCache = new TtlCache<string, unknown>("CHAT_LIST_CACHE_TTL_MS", 1_500, 500);

/** پس از هر نوشتن در گفتگو (توسط bus.chatWake) */
export function invalidateChatCaches(code?: string): void {
  convCache.invalidate(code);
  listCache.invalidate();
}
