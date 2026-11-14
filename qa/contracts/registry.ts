/**
 * رجیستری قرارداد API — منبع حقیقت «آنچه مشتری‌ها و افزونه‌ی وردپرس روی آن حساب کرده‌اند».
 * هر مورد: چه کسی (بی‌ورود / کلید API / نشست مدیر / نشست کاربر) چه درخواستی می‌دهد و چه پاسخی (کد، نوع، schema) باید بگیرد.
 *
 * قاعده‌ی سازگاری: افزودن فیلد جدید آزاد است؛ حذف/تغییر نوع فیلد، تغییر کد وضعیت یا پیام خطا = شکست.
 * هر تغییر عمدی در schemaها باید با `QA_UPDATE_CONTRACTS=1 npm run qa:contract` در baseline.json ثبت شود (و در بازبینی دیده شود).
 */
import { z } from "zod";
import type { QaState } from "../lib/state";

export type Who = "anon" | "key" | "badkey" | "admin" | "user";
export type Kind = "json" | "csv" | "zip" | "text" | "redirect" | "empty";

export interface ContractCase {
  /** الگوی مسیر مطابق src/app (برای آزمون پوشش) */
  route: string;
  name: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  who: Who;
  path: string | ((s: QaState) => string);
  body?: object | ((s: QaState) => object);
  status: number | number[];
  kind?: Kind;
  schema?: z.ZodType;
  /** هدرهای پاسخ که باید مطابق باشند */
  headers?: Record<string, RegExp>;
}

/* ───────── schemaهای مشترک ───────── */
const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "تاریخ ISO نیست");
const nullableIso = iso.nullable();

/** پوشش خطای استاندارد APIهای v1 */
export const ErrorEnvelope = z.object({ ok: z.literal(false), error: z.string().min(1), detail: z.string().optional() });
/** پوشش خطای مسیرهای داخلی پنل */
export const BareError = z.object({ error: z.string().min(1) });

export const HealthSchema = z.object({ ok: z.literal(true), simulator: z.string().nullable().optional(), installed: z.boolean().optional() });

export const StatsSchema = z.object({
  ok: z.literal(true),
  workspace: z.string(),
  counts: z.object({ all: z.number(), draft: z.number(), sent: z.number(), signed: z.number(), rejected: z.number(), expired: z.number(), cancelled: z.number() }),
  stats: z.object({ total: z.number(), signed: z.number(), pending: z.number(), rate: z.number(), expiringSoon: z.number(), avgHours: z.number().nullable() }),
});

export const TemplatesSchema = z.object({
  ok: z.literal(true),
  items: z.array(z.object({ id: z.number().int(), title: z.string().min(1), description: z.string().nullable().optional() })).min(1),
});

export const ContractListSchema = z.object({
  ok: z.literal(true),
  page: z.number().int().min(1),
  limit: z.number().int().min(1).max(50),
  total: z.number().int().min(0),
  items: z.array(
    z.object({
      id: z.number().int(),
      number: z.string().regex(/^[A-Z]+-\d{4}-\d+$/),
      title: z.string(),
      status: z.string(),
      statusLabel: z.string(),
      issuedAt: iso,
      signedAt: nullableIso,
      expiresAt: nullableIso,
      customer: z.object({ name: z.string(), email: z.string().email() }),
      shortUrl: z.string().url().nullable(),
    }),
  ),
});

export const ContractDetailSchema = z.object({
  ok: z.literal(true),
  id: z.number().int(),
  number: z.string(),
  title: z.string(),
  status: z.string(),
  issuedAt: iso,
  expiresAt: nullableIso,
  signedAt: nullableIso,
  docHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  shortUrl: z.string().nullable(),
  signers: z.array(z.object({ position: z.number().int(), label: z.string(), status: z.string(), signedAt: nullableIso })),
});

export const IssueDraftSchema = z.object({ ok: z.literal(true), id: z.number().int(), status: z.literal("draft"), signUrl: z.null(), shortUrl: z.null() });

export const ConnectStatusSchema = z.object({ ok: z.literal(true), workspace: z.string(), managed: z.boolean(), verified: z.boolean(), sso: z.boolean(), panelUrl: z.string().url() });

export const NotificationsSchema = z.object({
  unread: z.number().int().min(0),
  items: z.array(z.object({ id: z.number().int(), kind: z.string(), title: z.string() })),
});
export const MarkReadSchema = z.object({ ok: z.literal(true), changed: z.number().int(), unread: z.number().int() });
export const AccountExportSchema = z.object({ exportedAt: iso, format: z.string().min(1) });
export const SearchSchema = z.object({ ok: z.literal(true), results: z.array(z.object({}).passthrough()) });
export const SearchDeniedSchema = z.object({ ok: z.literal(false), results: z.array(z.unknown()).length(0) });
export const AiStatusSchema = z.object({ ok: z.literal(true), configured: z.boolean(), used: z.number().int(), limit: z.number().int() });

/* ───────── نمونه‌ی مشتری معتبر برای صدور (پیش‌نویس؛ سقف طرح را مصرف نمی‌کند) ───────── */
const customer = { name: "مشتری آزمون قرارداد", email: "qa-contract-customer@example.com", mobile: "09123334444" };
const draftBody = (s: QaState) => ({ templateId: s.templateId, draft: true, customer });

const C = (c: ContractCase): ContractCase => c;
const J = (extra: Partial<ContractCase> & Pick<ContractCase, "route" | "name" | "method" | "who" | "path" | "status">): ContractCase => C({ kind: "json", ...extra });

export const REGISTRY: ContractCase[] = [
  /* ── سلامت ── */
  J({ route: "/api/health", name: "سالم", method: "GET", who: "anon", path: "/api/health", status: 200, schema: HealthSchema }),

  /* ── API عمومی نسخه‌ی ۱ (کلید API) ── */
  J({ route: "/api/v1/stats", name: "آمار با کلید", method: "GET", who: "key", path: "/api/v1/stats", status: 200, schema: StatsSchema, headers: { "cache-control": /no-store/ } }),
  J({ route: "/api/v1/stats", name: "بدون کلید", method: "GET", who: "anon", path: "/api/v1/stats", status: 401, schema: ErrorEnvelope.extend({ error: z.literal("invalid_api_key") }) }),
  J({ route: "/api/v1/stats", name: "کلید بدشکل", method: "GET", who: "badkey", path: "/api/v1/stats", status: 401, schema: ErrorEnvelope.extend({ error: z.literal("invalid_api_key") }) }),
  J({ route: "/api/v1/stats", name: "نشست مرورگر جای کلید نیست", method: "GET", who: "admin", path: "/api/v1/stats", status: 401, schema: ErrorEnvelope }),
  J({ route: "/api/v1/templates", name: "فهرست قالب‌ها", method: "GET", who: "key", path: "/api/v1/templates", status: 200, schema: TemplatesSchema, headers: { "cache-control": /no-store/ } }),
  J({ route: "/api/v1/templates", name: "بدون کلید", method: "GET", who: "anon", path: "/api/v1/templates", status: 401, schema: ErrorEnvelope }),
  J({ route: "/api/v1/contracts", name: "فهرست", method: "GET", who: "key", path: "/api/v1/contracts?limit=5", status: 200, schema: ContractListSchema, headers: { "cache-control": /no-store/ } }),
  J({ route: "/api/v1/contracts", name: "سقف limit=۵۰", method: "GET", who: "key", path: "/api/v1/contracts?limit=999&page=0", status: 200, schema: ContractListSchema.extend({ limit: z.literal(50), page: z.literal(1) }) }),
  J({ route: "/api/v1/contracts", name: "فیلتر وضعیت نامعتبر", method: "GET", who: "key", path: "/api/v1/contracts?status=hacked", status: 422, schema: ErrorEnvelope.extend({ error: z.literal("invalid_status") }) }),
  J({ route: "/api/v1/contracts", name: "فیلتر ایمیل ناموجود", method: "GET", who: "key", path: "/api/v1/contracts?email=nobody@example.com", status: 200, schema: ContractListSchema.extend({ total: z.literal(0), items: z.array(z.never()) }) }),
  J({ route: "/api/v1/contracts", name: "بدون کلید", method: "GET", who: "anon", path: "/api/v1/contracts", status: 401, schema: ErrorEnvelope }),
  J({ route: "/api/v1/contracts", name: "صدور پیش‌نویس", method: "POST", who: "key", path: "/api/v1/contracts", body: draftBody, status: 201, schema: IssueDraftSchema }),
  J({ route: "/api/v1/contracts", name: "بدنه‌ی خالی", method: "POST", who: "key", path: "/api/v1/contracts", body: {}, status: 422, schema: ErrorEnvelope.extend({ error: z.literal("templateId_required") }) }),
  J({ route: "/api/v1/contracts", name: "قالب ناموجود", method: "POST", who: "key", path: "/api/v1/contracts", body: (s) => ({ ...draftBody(s), templateId: 99999999 }), status: 404, schema: ErrorEnvelope.extend({ error: z.literal("template_not_found") }) }),
  J({ route: "/api/v1/contracts", name: "ایمیل مشتری نامعتبر", method: "POST", who: "key", path: "/api/v1/contracts", body: (s) => ({ ...draftBody(s), customer: { ...customer, email: "not-an-email" } }), status: 422, schema: ErrorEnvelope.extend({ error: z.literal("customer_email_invalid") }) }),
  J({ route: "/api/v1/contracts", name: "موبایل نامعتبر", method: "POST", who: "key", path: "/api/v1/contracts", body: (s) => ({ ...draftBody(s), customer: { ...customer, mobile: "123" } }), status: 422, schema: ErrorEnvelope.extend({ error: z.literal("customer_mobile_invalid") }) }),
  J({ route: "/api/v1/contracts", name: "بدون کلید", method: "POST", who: "anon", path: "/api/v1/contracts", body: {}, status: 401, schema: ErrorEnvelope }),
  J({ route: "/api/v1/contracts/[id]", name: "جزئیات", method: "GET", who: "key", path: (s) => `/api/v1/contracts/${s.contractId}`, status: 200, schema: ContractDetailSchema }),
  J({ route: "/api/v1/contracts/[id]", name: "شناسه نامعتبر", method: "GET", who: "key", path: "/api/v1/contracts/abc", status: 400, schema: ErrorEnvelope.extend({ error: z.literal("invalid_id") }) }),
  J({ route: "/api/v1/contracts/[id]", name: "ناموجود", method: "GET", who: "key", path: "/api/v1/contracts/99999999", status: 404, schema: ErrorEnvelope.extend({ error: z.literal("not_found") }) }),
  J({ route: "/api/v1/contracts/[id]", name: "بدون کلید", method: "GET", who: "anon", path: (s) => `/api/v1/contracts/${s.contractId}`, status: 401, schema: ErrorEnvelope }),

  /* ── اتصال وردپرس ── */
  J({ route: "/api/v1/connect/status", name: "وضعیت", method: "GET", who: "key", path: "/api/v1/connect/status", status: 200, schema: ConnectStatusSchema }),
  J({ route: "/api/v1/connect/status", name: "بدون کلید", method: "POST", who: "anon", path: "/api/v1/connect/status", body: {}, status: 401, schema: ErrorEnvelope }),
  J({ route: "/api/v1/connect/register", name: "شناسه‌ی نصب نامعتبر", method: "POST", who: "anon", path: "/api/v1/connect/register", body: {}, status: 422, schema: ErrorEnvelope.extend({ error: z.literal("install_id_invalid") }) }),
  J({ route: "/api/v1/connect/complete", name: "دست‌دادن نامعتبر", method: "POST", who: "anon", path: "/api/v1/connect/complete", body: {}, status: 422, schema: ErrorEnvelope.extend({ error: z.literal("handshake_invalid") }) }),
  J({ route: "/api/v1/connect/disconnect", name: "بدون کلید", method: "POST", who: "anon", path: "/api/v1/connect/disconnect", body: {}, status: 401, schema: ErrorEnvelope }),
  J({ route: "/api/v1/connect/sso", name: "بدون کلید", method: "POST", who: "anon", path: "/api/v1/connect/sso", body: {}, status: 401, schema: ErrorEnvelope }),
  C({ route: "/connect/sso", name: "بدون توکن به ورود هدایت می‌شود", method: "GET", who: "anon", path: "/connect/sso", status: [302, 303, 307, 308], kind: "redirect" }),

  /* ── لایسنس و به‌روزرسانی (در نصب معمولی سرور لایسنس خاموش است) ── */
  J({ route: "/api/license/v1/check", name: "سرور لایسنس خاموش", method: "POST", who: "anon", path: "/api/license/v1/check", body: {}, status: 404, schema: ErrorEnvelope.extend({ error: z.literal("not_found") }) }),
  J({ route: "/api/updates/v1/check", name: "سرور لایسنس خاموش", method: "POST", who: "anon", path: "/api/updates/v1/check", body: {}, status: 404, schema: ErrorEnvelope.extend({ error: z.literal("not_found") }) }),
  J({ route: "/api/updates/v1/download", name: "سرور لایسنس خاموش", method: "POST", who: "anon", path: "/api/updates/v1/download", body: {}, status: 404, schema: ErrorEnvelope.extend({ error: z.literal("not_found") }) }),
  J({ route: "/api/platform/releases", name: "سرور لایسنس خاموش", method: "PUT", who: "anon", path: "/api/platform/releases", body: {}, status: 404, schema: ErrorEnvelope }),

  /* ── مسیرهای داخلی پنل (نشست مرورگر) ── */
  J({ route: "/api/notifications", name: "فهرست اعلان‌ها", method: "GET", who: "admin", path: "/api/notifications", status: 200, schema: NotificationsSchema }),
  J({ route: "/api/notifications", name: "بدون ورود", method: "GET", who: "anon", path: "/api/notifications", status: 401, schema: BareError.extend({ error: z.literal("unauthorized") }) }),
  J({ route: "/api/notifications", name: "علامت خوانده‌شدن", method: "POST", who: "user", path: "/api/notifications", body: {}, status: 200, schema: MarkReadSchema }),
  J({ route: "/api/notifications", name: "کلید API نشست نیست", method: "GET", who: "key", path: "/api/notifications", status: 401, schema: BareError }),
  J({ route: "/api/account/export", name: "خروجی داده‌ها", method: "GET", who: "user", path: "/api/account/export", status: 200, schema: AccountExportSchema }),
  J({ route: "/api/account/export", name: "بدون ورود", method: "GET", who: "anon", path: "/api/account/export", status: 401, schema: BareError }),
  C({ route: "/api/admin/export", name: "CSV مدیر", method: "GET", who: "admin", path: "/api/admin/export", status: 200, kind: "csv", headers: { "content-type": /text\/csv/ } }),
  C({ route: "/api/admin/export", name: "بدون ورود", method: "GET", who: "anon", path: "/api/admin/export", status: 403, kind: "text" }),
  J({ route: "/api/admin/search", name: "جستجو", method: "GET", who: "admin", path: "/api/admin/search?q=قرارداد", status: 200, schema: SearchSchema }),
  J({ route: "/api/admin/search", name: "بدون ورود", method: "GET", who: "anon", path: "/api/admin/search?q=a", status: 403, schema: SearchDeniedSchema }),
  J({ route: "/api/ai/contract", name: "وضعیت سهمیه", method: "GET", who: "admin", path: "/api/ai/contract", status: 200, schema: AiStatusSchema }),
  J({ route: "/api/ai/contract", name: "بدون ورود", method: "GET", who: "anon", path: "/api/ai/contract", status: 403, schema: ErrorEnvelope }),
  J({ route: "/api/ai/contract", name: "توضیح کوتاه", method: "POST", who: "admin", path: "/api/ai/contract", body: { prompt: "x" }, status: 422, schema: ErrorEnvelope }),
  J({ route: "/api/ai/test", name: "بدون ورود", method: "POST", who: "anon", path: "/api/ai/test", body: {}, status: 403, schema: ErrorEnvelope }),
  C({ route: "/api/billing/callback", name: "بازگشت درگاه بدون پارامتر", method: "GET", who: "anon", path: "/api/billing/callback", status: 303, kind: "redirect" }),
  C({ route: "/api/billing/callback/[gateway]", name: "بازگشت درگاه چنددرگاهی بدون پارامتر", method: "GET", who: "anon", path: "/api/billing/callback/zibal", status: 303, kind: "redirect" }),
  J({ route: "/api/landing/upload", name: "بدون ورود", method: "POST", who: "anon", path: "/api/landing/upload", body: {}, status: 403, schema: ErrorEnvelope }),
  J({ route: "/api/landing/upload", name: "بدون فایل", method: "POST", who: "admin", path: "/api/landing/upload", body: {}, status: 400, schema: ErrorEnvelope }),
  C({ route: "/api/landing/image/[name]", name: "تصویر ناموجود", method: "GET", who: "anon", path: "/api/landing/image/missing.png", status: 404, kind: "text" }),
  C({ route: "/api/brand/logo", name: "بدون لوگو", method: "GET", who: "anon", path: "/api/brand/logo", status: 404, kind: "text" }),
  C({ route: "/api/wordpress/plugin", name: "دانلود افزونه (ZIP)", method: "GET", who: "anon", path: "/api/wordpress/plugin", status: 200, kind: "zip", headers: { "content-type": /zip/ } }),
  J({ route: "/api/cron/run", name: "بدون راز", method: "GET", who: "anon", path: "/api/cron/run", status: 401, schema: ErrorEnvelope.extend({ error: z.literal("unauthorized") }) }),

  /* ── قرارداد: فایل‌ها و PDF ── */
  J({ route: "/api/contracts/[id]/pdf", name: "بدون ورود", method: "GET", who: "anon", path: (s) => `/api/contracts/${s.contractId}/pdf`, status: 401, schema: BareError }),
  J({ route: "/api/contracts/[id]/pdf", name: "هنوز امضا نشده", method: "GET", who: "user", path: (s) => `/api/contracts/${s.contractId}/pdf`, status: 409, schema: BareError.extend({ error: z.literal("not_signed_yet") }) }),
  J({ route: "/api/contracts/[id]/amendments/[seq]/pdf", name: "بدون ورود", method: "GET", who: "anon", path: (s) => `/api/contracts/${s.contractId}/amendments/1/pdf`, status: 401, schema: BareError }),
  J({ route: "/api/contracts/[id]/amendments/[seq]/pdf", name: "الحاقیه‌ی ناموجود", method: "GET", who: "admin", path: (s) => `/api/contracts/${s.contractId}/amendments/1/pdf`, status: 404, schema: BareError }),
  J({ route: "/api/contracts/[id]/attachments", name: "آپلود بدون ورود", method: "POST", who: "anon", path: (s) => `/api/contracts/${s.contractId}/attachments`, body: {}, status: 401, schema: ErrorEnvelope }),
  J({ route: "/api/contracts/[id]/attachments", name: "آپلود نامعتبر", method: "POST", who: "admin", path: (s) => `/api/contracts/${s.contractId}/attachments`, body: {}, status: 400, schema: ErrorEnvelope }),
  C({ route: "/api/contracts/[id]/attachments/[aid]", name: "دانلود بدون ورود", method: "GET", who: "anon", path: (s) => `/api/contracts/${s.contractId}/attachments/1`, status: 401, kind: "json" }),
  C({ route: "/api/contracts/[id]/signature/[signerId]", name: "امضا بدون ورود", method: "GET", who: "anon", path: (s) => `/api/contracts/${s.contractId}/signature/1`, status: 401, kind: "text" }),
  J({ route: "/api/sign/[token]/pdf", name: "توکن بدون امضای نهایی", method: "GET", who: "anon", path: (s) => `/api/sign/${s.signToken}/pdf`, status: 404, schema: BareError.extend({ error: z.literal("not_found") }) }),
  J({ route: "/api/sign/[token]/attachments", name: "بدون نشست OTP", method: "POST", who: "anon", path: (s) => `/api/sign/${s.signToken}/attachments`, body: {}, status: 401, schema: ErrorEnvelope }),
];
