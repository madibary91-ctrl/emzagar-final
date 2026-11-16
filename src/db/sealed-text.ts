import { customType } from "drizzle-orm/pg-core";

/**
 * D-01: ستون متنی «رمزنگاری‌شده در حالت سکون» (AES-256-GCM با قالب enc:v1:).
 *
 * رمزنگاری/رمزگشایی شفاف است: هر `insert/update` مقدار را مُهر می‌کند و هر `select` آن را باز می‌کند؛ پس کدِ سرویس‌ها بدون تغییر
 * متن ساده را می‌بینند ولی دیتابیس، بک‌آپ SQL و dump فقط متن رمزشده دارد. مقدار قدیمیِ بدون پیشوند (متن ساده) هنگام خواندن همان‌طور
 * برمی‌گردد و با اولین نوشتن (یا `sealLegacySecrets` در پاک‌سازی دوره‌ای) رمز می‌شود.
 *
 * چرا «کدک ثبت‌شده» و نه import مستقیم؟ این فایل توسط drizzle-kit و scripts/gen-schema-sql.mjs هم بارگذاری می‌شود (بدون alias `@/`)؛
 * کدک واقعی هنگام بارگذاری `src/db/index.ts` ثبت می‌شود و همه‌ی دسترسی‌های برنامه به دیتابیس از آنجا می‌گذرد.
 */
export interface SealCodec {
  seal: (plain: string) => string;
  open: (stored: string) => string;
}
type Holder = typeof globalThis & { __emzSealCodec?: SealCodec };

export function setSealCodec(c: SealCodec): void {
  (globalThis as Holder).__emzSealCodec = c;
}

export const sealedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return "text";
  },
  toDriver(value) {
    const c = (globalThis as Holder).__emzSealCodec;
    // بدون کدک (فقط ابزارهای ساخت DDL) هرگز چیزی نوشته نمی‌شود؛ در برنامه‌ی واقعی کدک همیشه ثبت است
    if (!c) throw new Error("SEAL_CODEC_NOT_REGISTERED");
    return c.seal(value);
  },
  fromDriver(value) {
    const c = (globalThis as Holder).__emzSealCodec;
    return c ? c.open(value) : value;
  },
});
