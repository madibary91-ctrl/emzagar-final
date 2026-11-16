/**
 * فهرست مرکزی صفحه‌ها. دسترس‌پذیری، دود، سئو/عملکرد و آزمون بصری همگی از همین‌جا می‌خوانند؛
 * یک صفحه‌ی جدید فقط یک‌بار اینجا اضافه می‌شود و در همه‌ی لایه‌ها پوشش داده می‌شود.
 * آزمون «پوشش مسیرها» (qa/specs/route-coverage.spec.ts) تضمین می‌کند هیچ page.tsx جدیدی از قلم نیفتد.
 */
import type { QaState } from "./lib/state";

export type AuthKind = "none" | "user" | "admin";

export interface PageDef {
  /** نام کوتاه و یکتا (در نام عکس‌های بصری و گزارش‌ها) */
  name: string;
  /** مسیر یا تابعی که از روی وضعیت آماده‌سازی مسیر می‌سازد */
  path: string | ((s: QaState) => string);
  auth: AuthKind;
  /** الگوی مسیر در src/app (برای آزمون پوشش) */
  route: string;
  /** صفحه‌ی بازاریابی عمومی که باید ایندکس شود (سئو سخت‌گیرانه) */
  indexable?: boolean;
  /** در آزمون بصری شرکت کند */
  visual?: boolean;
  /** در تست دود (مسیر حیاتی) شرکت کند */
  critical?: boolean;
  /** اجرای axe روی حالت تاریک هم */
  dark?: boolean;
}

const P = (d: PageDef): PageDef => d;

export const PAGES: PageDef[] = [
  /* ── عمومی ── */
  P({ name: "home", path: "/", auth: "none", route: "/", indexable: true, visual: true, critical: true, dark: true }),
  P({ name: "pricing", path: "/pricing", auth: "none", route: "/pricing", indexable: true, visual: true, critical: true }),
  P({ name: "login", path: "/login", auth: "none", route: "/login", visual: true, critical: true, dark: true }),
  P({ name: "register", path: "/register", auth: "none", route: "/register", indexable: true, visual: true, critical: true }),
  P({ name: "forgot", path: "/forgot", auth: "none", route: "/forgot", visual: true }),
  P({ name: "verify", path: "/verify", auth: "none", route: "/verify", visual: true }),
  P({ name: "verify-hash-unknown", path: `/verify/${"0".repeat(64)}`, auth: "none", route: "/verify/[hash]", visual: true }),
  P({ name: "sign-valid", path: (s) => `/sign/${s.signToken}`, auth: "none", route: "/sign/[token]", critical: true }),
  P({ name: "sign-invalid", path: `/sign/${"a".repeat(43)}`, auth: "none", route: "/sign/[token]-invalid", visual: true }),
  P({ name: "amend-invalid", path: `/amend/${"b".repeat(43)}`, auth: "none", route: "/amend/[token]" }),
  P({ name: "reset-invalid", path: `/reset/${"c".repeat(43)}`, auth: "none", route: "/reset/[token]" }),
  P({ name: "invite-invalid", path: `/invite/${"d".repeat(43)}`, auth: "none", route: "/invite/[token]" }),
  P({ name: "verify-email-invalid", path: `/verify-email/${"e".repeat(43)}`, auth: "none", route: "/verify-email/[token]" }),
  P({ name: "verify-email", path: "/verify-email", auth: "none", route: "/verify-email" }),
  P({ name: "shortlink-invalid", path: "/s/zzzzzzzz", auth: "none", route: "/s/[code]" }),
  P({ name: "offline", path: "/offline.html", auth: "none", route: "(public)/offline.html", visual: true }),

  /* ── کاربر ── */
  P({ name: "dashboard", path: "/dashboard", auth: "user", route: "/dashboard", critical: true, visual: true }),
  P({ name: "account", path: "/account", auth: "user", route: "/account", visual: true }),
  P({ name: "notifications", path: "/notifications", auth: "user", route: "/notifications" }),
  P({ name: "support", path: "/support", auth: "user", route: "/support", visual: true }),
  P({ name: "support-new", path: "/support/new", auth: "user", route: "/support/new", visual: true }),
  P({ name: "support-ticket", path: (s) => `/support/${s.ticketId}`, auth: "user", route: "/support/[id]" }),
  P({ name: "contract", path: (s) => `/contracts/${s.contractId}`, auth: "user", route: "/contracts/[id]", critical: true }),
  P({ name: "contract-print", path: (s) => `/contracts/${s.contractId}/print`, auth: "user", route: "/contracts/[id]/print" }),
  P({ name: "shop", path: "/shop", auth: "user", route: "/shop" }),

  /* ── مدیر فضای کاری ── */
  P({ name: "admin", path: "/admin", auth: "admin", route: "/admin", critical: true, dark: true }),
  P({ name: "admin-new", path: "/admin/new", auth: "admin", route: "/admin/new", critical: true }),
  P({ name: "admin-templates", path: "/admin/templates", auth: "admin", route: "/admin/templates", visual: true }),
  P({ name: "admin-template", path: (s) => `/admin/templates/${s.templateId}`, auth: "admin", route: "/admin/templates/[id]" }),
  P({ name: "admin-contract-edit", path: (s) => `/admin/contracts/${s.draftContractId}/edit`, auth: "admin", route: "/admin/contracts/[id]/edit" }),
  P({ name: "admin-customers", path: "/admin/customers", auth: "admin", route: "/admin/customers" }),
  P({ name: "admin-products", path: "/admin/products", auth: "admin", route: "/admin/products" }),
  P({ name: "admin-renewals", path: "/admin/renewals", auth: "admin", route: "/admin/renewals" }),
  P({ name: "admin-reports", path: "/admin/reports", auth: "admin", route: "/admin/reports" }),
  P({ name: "admin-insights", path: "/admin/insights", auth: "admin", route: "/admin/insights" }),
  P({ name: "admin-risk", path: "/admin/risk", auth: "admin", route: "/admin/risk" }),
  P({ name: "admin-billing", path: "/admin/billing", auth: "admin", route: "/admin/billing" }),
  P({ name: "admin-wallet", path: "/admin/wallet", auth: "admin", route: "/admin/wallet" }),
  P({ name: "admin-referrals", path: "/admin/referrals", auth: "admin", route: "/admin/referrals" }),
  P({ name: "admin-kyc", path: "/admin/kyc", auth: "admin", route: "/admin/kyc" }),
  P({ name: "admin-branding", path: "/admin/branding", auth: "admin", route: "/admin/branding", visual: true }),
  P({ name: "admin-settings", path: "/admin/settings", auth: "admin", route: "/admin/settings", visual: true }),
  P({ name: "admin-team", path: "/admin/team", auth: "admin", route: "/admin/team" }),
  P({ name: "admin-webhooks", path: "/admin/webhooks", auth: "admin", route: "/admin/webhooks" }),
  P({ name: "admin-api", path: "/admin/api", auth: "admin", route: "/admin/api" }),
  P({ name: "admin-automation", path: "/admin/automation", auth: "admin", route: "/admin/automation" }),
  P({ name: "admin-logs", path: "/admin/logs", auth: "admin", route: "/admin/logs" }),
  P({ name: "admin-demo", path: "/admin/demo", auth: "admin", route: "/admin/demo", visual: true }),
  P({ name: "admin-wordpress", path: "/admin/wordpress", auth: "admin", route: "/admin/wordpress" }),
  P({ name: "admin-landing", path: "/admin/landing", auth: "admin", route: "/admin/landing" }),
  P({ name: "landing-preview", path: "/landing-preview", auth: "admin", route: "/landing-preview" }),
  P({ name: "embed-dashboard", path: "/embed/dashboard", auth: "admin", route: "/embed/dashboard" }),

  /* ── مدیر کل پلتفرم (اولین کاربر) ── */
  P({ name: "platform", path: "/platform", auth: "admin", route: "/platform" }),
  P({ name: "platform-tickets", path: "/platform/tickets", auth: "admin", route: "/platform/tickets" }),
  P({ name: "platform-ticket", path: (s) => `/platform/tickets/${s.ticketId}`, auth: "admin", route: "/platform/tickets/[id]" }),
  P({ name: "platform-commerce", path: "/platform/commerce", auth: "admin", route: "/platform/commerce" }),
  P({ name: "platform-kyc", path: "/platform/kyc", auth: "admin", route: "/platform/kyc" }),
  P({ name: "platform-license", path: "/platform/license", auth: "admin", route: "/platform/license" }),
  P({ name: "platform-vendor", path: "/platform/vendor", auth: "admin", route: "/platform/vendor" }),
];

export const resolvePath = (p: PageDef, s: QaState): string => (typeof p.path === "function" ? p.path(s) : p.path);

/** مسیرهای page.tsx که عمداً در PAGES نیستند (با دلیل) */
export const COVERAGE_EXCLUDES: Record<string, string> = {
  "/install": "پس از نصب به /login هدایت می‌شود؛ آزمون نصب‌کننده در مرحله‌ی آماده‌سازی و e2e/01 است",
  "/contracts/[id]/print": "در PAGES (contract-print)",
};

/** مسیرهای ساده‌ی آماده‌ی سئو */
export const PUBLIC_INDEXABLE = PAGES.filter((p) => p.indexable);
