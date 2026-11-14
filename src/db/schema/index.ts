/**
 * ساختار دیتابیس (تنها منبع حقیقت) — بر اساس دامنه در فایل‌های جدا تقسیم شده است.
 * مسیر قدیمی `@/db/schema` و `drizzle.config.json` بدون تغییر کار می‌کنند.
 *
 * ⚠️ عمداً `export *` است: DDL نصب‌کننده (src/db/ddl.ts) از `import * as schema` ساخته می‌شود؛
 * هر جدولی که در یکی از این فایل‌ها export شود خودکار در نصب/ارتقا اعمال می‌شود.
 * هنگام افزودن «فایل دامنه‌ی جدید»، فقط یک خط `export * from "./نام"` به‌اینجا اضافه کنید.
 */
export * from "./ai";
export * from "./billing";
export * from "./chat";
export * from "./collect";
export * from "./contracts";
export * from "./developer";
export * from "./documents";
export * from "./health";
export * from "./identity";
export * from "./kyc";
export * from "./licensing";
export * from "./merge";
export * from "./messengers";
export * from "./negotiation";
export * from "./notifications";
export * from "./platform";
export * from "./security";
export * from "./shop";
export * from "./support";
export * from "./tenancy";
export * from "./vault";
export * from "./wallet";
export * from "./wordpress";
