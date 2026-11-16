/**
 * منطق خالص ارسال انبوه (بدون دیتابیس؛ در سرور و کلاینت مشترک):
 * کشف متغیرهای قالب، نگاشت خودکار ستون‌ها، جایگزینی امن مقدارها و اعتبارسنجی هر ردیف.
 */
export const BUILTIN_KEYS = ["USER_NAME", "USER_EMAIL", "USER_MOBILE", "CONTRACT_NUMBER", "DATE", "SITE_NAME", "PRODUCT_NAME", "AMOUNT"] as const;
const SYSTEM_KEYS = new Set<string>(["USER_EMAIL", "CONTRACT_NUMBER", "DATE", "SITE_NAME"]);

export type Roles = { name: string; mobile: string; amount: string; deposit: string; count: string };
export interface MergeMapping {
  roles: Roles;
  /** متغیر قالب ← سرستون */
  vars: Record<string, string>;
}
export interface PlanOptions {
  enabled: boolean;
  depositPercent: number;
  count: number;
  intervalDays: number;
  gateDeposit: boolean;
}
export interface MergeOptions {
  contractTitle: string;
  signerLabel: string;
  expiryDays: number | null;
  tags: string;
  skipDuplicates: boolean;
  plan: PlanOptions;
}

export const DEFAULT_OPTIONS: MergeOptions = {
  contractTitle: "",
  signerLabel: "امضاکننده",
  expiryDays: 14,
  tags: "",
  skipDuplicates: true,
  plan: { enabled: false, depositPercent: 30, count: 3, intervalDays: 30, gateDeposit: true },
};

export interface Placeholder {
  key: string;
  /** نحوه‌ی نوشتن در قالب (برای نمایش) */
  style: "curly" | "bracket";
  builtin: boolean;
}

const CURLY = /\{\{\s*(?!field:)([^{}]+?)\s*\}\}/g;
const BRACKET = /\[([A-Z][A-Z0-9_]*)\]/g;

/** متغیرهای قابل‌جایگزینی در متن قالب: {{نام ستون}} و [KEY]؛ توکن‌های {{field:…}} (پرشدنی توسط امضاکننده) نادیده گرفته می‌شوند */
export function detectPlaceholders(...texts: string[]): Placeholder[] {
  const out = new Map<string, Placeholder>();
  for (const t of texts) {
    for (const m of t.matchAll(CURLY)) {
      const key = m[1].trim();
      if (key && key.length <= 60 && !out.has(key)) out.set(key, { key, style: "curly", builtin: false });
    }
    for (const m of t.matchAll(BRACKET)) {
      const key = m[1];
      if (!out.has(key)) out.set(key, { key, style: "bracket", builtin: (BUILTIN_KEYS as readonly string[]).includes(key) });
    }
  }
  return [...out.values()].filter((p) => !SYSTEM_KEYS.has(p.key));
}

const FA = "۰۱۲۳۴۵۶۷۸۹";
const AR = "٠١٢٣٤٥٦٧٨٩";
export const toEn = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));

/** نرمال‌سازی نام ستون/متغیر برای تطبیق (فارسی/عربی، فاصله، نیم‌فاصله، زیرخط، حروف) */
export function norm(s: string): string {
  return toEn(String(s))
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\s\u200c\u200d_\-.]/g, "")
    .toLowerCase();
}

const SYN: Record<keyof Roles, string[]> = {
  name: ["نام", "نامونامخانوادگی", "نامخانوادگی", "اسم", "نامکامل", "name", "fullname", "employee", "کارمند", "مشتری", "username"],
  mobile: ["موبایل", "شمارهموبایل", "تلفنهمراه", "همراه", "شماره", "تلفن", "mobile", "phone", "cell", "tel", "whatsapp", "usermobile"],
  amount: ["مبلغ", "مبلغکل", "مبلغقرارداد", "حقوق", "اجاره", "amount", "total", "price", "salary", "قیمت"],
  deposit: ["بیعانه", "پیشپرداخت", "deposit", "advance"],
  count: ["تعداداقساط", "اقساط", "قسط", "installments", "count"],
};

export function guessRole(headers: string[], role: keyof Roles): string {
  const hn = headers.map(norm);
  for (const syn of SYN[role]) {
    const i = hn.indexOf(norm(syn));
    if (i >= 0) return headers[i];
  }
  for (const syn of SYN[role]) {
    const i = hn.findIndex((h) => h.includes(norm(syn)) && h.length <= norm(syn).length + 6);
    if (i >= 0) return headers[i];
  }
  return "";
}

export function guessMapping(headers: string[], placeholders: Placeholder[]): MergeMapping {
  const roles: Roles = { name: guessRole(headers, "name"), mobile: guessRole(headers, "mobile"), amount: guessRole(headers, "amount"), deposit: guessRole(headers, "deposit"), count: guessRole(headers, "count") };
  if (roles.name && roles.name === roles.mobile) roles.name = "";
  const vars: Record<string, string> = {};
  const hn = headers.map(norm);
  for (const p of placeholders) {
    const i = hn.indexOf(norm(p.key));
    if (i >= 0) vars[p.key] = headers[i];
    else if (p.key === "USER_NAME") vars[p.key] = roles.name;
    else if (p.key === "USER_MOBILE") vars[p.key] = roles.mobile;
    else if (p.key === "AMOUNT") vars[p.key] = roles.amount;
  }
  return { roles, vars };
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** جایگزینی مقدارها (HTML-escape شده؛ جلوگیری از تزریق). متغیر بدون مقدار دست‌نخورده می‌ماند. */
export function renderMerge(html: string, values: Record<string, string>): string {
  const byNorm = new Map(Object.entries(values).map(([k, v]) => [norm(k), v]));
  const r1 = html.replace(CURLY, (m, key: string) => (byNorm.has(norm(key)) ? escHtml(byNorm.get(norm(key)) ?? "") : m));
  return r1.replace(BRACKET, (m, key: string) => (Object.prototype.hasOwnProperty.call(values, key) ? escHtml(values[key]) : m));
}

/** مقدار متن ساده (برای عنوان قرارداد؛ بدون HTML) */
export function renderPlain(text: string, values: Record<string, string>): string {
  const byNorm = new Map(Object.entries(values).map(([k, v]) => [norm(k), v]));
  return text
    .replace(CURLY, (m, key: string) => (byNorm.has(norm(key)) ? (byNorm.get(norm(key)) ?? "") : m))
    .replace(BRACKET, (m, key: string) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : m))
    .replace(/[\u0000-\u001f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** نرمال‌سازی موبایل ایران به 09xxxxxxxxx (نسخه‌ی خالص؛ هم‌منطق با guests/service) */
export function normalizeMobilePure(raw: string | null | undefined): string | null {
  let s = toEn(String(raw ?? "")).replace(/[\s\-().]/g, "");
  if (s.startsWith("+98")) s = "0" + s.slice(3);
  else if (s.startsWith("0098")) s = "0" + s.slice(4);
  else if (/^9\d{9}$/.test(s)) s = "0" + s;
  return /^09\d{9}$/.test(s) ? s : null;
}

/** مقدارهای یک ردیف برای جایگزینی در قالب: نگاشت متغیرها + نام/موبایل/مبلغ */
export function rowValues(data: Record<string, string>, mapping: MergeMapping, extra: { name: string; mobile: string; amount?: number | null }): Record<string, string> {
  const v: Record<string, string> = {};
  for (const [key, header] of Object.entries(mapping.vars)) if (header) v[key] = (data[header] ?? "").trim();
  v.USER_NAME = extra.name;
  v.USER_MOBILE = extra.mobile;
  return v;
}

export type RowIssue = { ok: true; name: string; mobile: string } | { ok: false; error: string };

export function checkRow(data: Record<string, string>, mapping: MergeMapping): RowIssue {
  const name = (data[mapping.roles.name] ?? "").replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  if (name.length < 3) return { ok: false, error: "نام خالی یا کوتاه است" };
  const mobile = normalizeMobilePure(data[mapping.roles.mobile]);
  if (!mobile) return { ok: false, error: `موبایل «${(data[mapping.roles.mobile] ?? "").slice(0, 20)}» معتبر نیست` };
  for (const [key, header] of Object.entries(mapping.vars)) {
    if (header && key !== "USER_NAME" && key !== "USER_MOBILE" && !(data[header] ?? "").trim()) return { ok: false, error: `مقدار «${header}» خالی است` };
  }
  return { ok: true, name, mobile };
}

export const MERGE_STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار",
  queued: "در صف ارسال",
  processing: "در حال ارسال",
  sent: "ارسال شد",
  failed: "ناموفق",
  invalid: "نامعتبر",
  skipped: "ردشده",
};
