import { escapeHtml } from "@/lib/html";

/**
 * فیلدهای قابل‌پرکردن داخل متن قرارداد (بدون وابستگی به سرور؛ قابل استفاده در کلاینت).
 *
 * نحو توکن در متن قرارداد:
 *     {{field:کلید|عنوان|نوع|اجباری|شماره‌ی امضاکننده}}
 * مثال‌ها:
 *     {{field:national_id|کد ملی|nid}}
 *     {{field:address|نشانی محل سکونت|address|req|2}}
 *     {{field:start_date|تاریخ شروع|date|opt}}
 * کلید: حروف کوچک لاتین/عدد/خط‌زیر؛ نوع پیش‌فرض text؛ پیش‌فرض اجباری؛ پیش‌فرض امضاکننده: نفر آخر (مشتری).
 */
export type FieldType = "text" | "nid" | "date" | "address" | "phone" | "number" | "email";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** شماره‌ی (position) امضاکننده‌ای که باید پر کند؛ null = آخرین امضاکننده */
  signerPos: number | null;
}

export const FIELD_TYPES: { id: FieldType; label: string; hint: string }[] = [
  { id: "text", label: "متن کوتاه", hint: "حداکثر ۲۰۰ نویسه" },
  { id: "nid", label: "کد ملی", hint: "۱۰ رقم معتبر" },
  { id: "date", label: "تاریخ (شمسی)", hint: "مثلاً ۱۴۰۵/۰۲/۱۵" },
  { id: "address", label: "نشانی", hint: "۸ تا ۵۰۰ نویسه" },
  { id: "phone", label: "تلفن", hint: "مثلاً ۰۹۱۲۱۲۳۴۵۶۷ یا ۰۲۱۸۸۸۸۸۸۸۸" },
  { id: "number", label: "عدد", hint: "فقط رقم" },
  { id: "email", label: "ایمیل", hint: "نشانی ایمیل معتبر" },
];

/** میان‌برهای درج در ویرایشگر */
export const FIELD_SNIPPETS: { label: string; token: string }[] = [
  { label: "کد ملی", token: "{{field:national_id|کد ملی|nid}}" },
  { label: "نشانی", token: "{{field:address|نشانی|address}}" },
  { label: "تاریخ", token: "{{field:date|تاریخ|date}}" },
  { label: "تلفن", token: "{{field:phone|تلفن|phone}}" },
  { label: "متن", token: "{{field:note|توضیح|text|opt}}" },
];

export const FIELD_TOKEN_RE = /\{\{\s*field:([^{}]+?)\s*\}\}/g;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const TYPE_IDS = new Set<string>(FIELD_TYPES.map((t) => t.id));

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
export function toEnDigits(s: string): string {
  return s.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
}

function parseToken(inner: string): FieldDef | null {
  const parts = inner.split("|").map((p) => p.trim());
  const key = (parts[0] || "").toLowerCase();
  if (!KEY_RE.test(key)) return null;
  const type = (TYPE_IDS.has((parts[2] || "").toLowerCase()) ? (parts[2] || "").toLowerCase() : "text") as FieldType;
  const flag = (parts[3] || "").toLowerCase();
  const required = !["opt", "optional", "0", "no", "اختیاری"].includes(flag);
  const pos = Number(toEnDigits(parts[4] || ""));
  return {
    key,
    label: (parts[1] || key).slice(0, 80),
    type,
    required,
    signerPos: Number.isInteger(pos) && pos >= 1 && pos <= 50 ? pos : null,
  };
}

/** استخراج تعریف فیلدها از متن (کلید تکراری: اولین تعریف معتبر است) */
export function parseFieldDefs(html: string): FieldDef[] {
  const seen = new Map<string, FieldDef>();
  for (const m of (html || "").matchAll(FIELD_TOKEN_RE)) {
    const def = parseToken(m[1]);
    if (def && !seen.has(def.key)) seen.set(def.key, def);
  }
  return [...seen.values()];
}

/** فیلدهایی که یک امضاکننده‌ی مشخص باید پر کند */
export function defsForSigner(defs: FieldDef[], signerPositions: number[], signerPosition: number): FieldDef[] {
  const last = Math.max(...signerPositions, 1);
  return defs.filter((d) => (d.signerPos && signerPositions.includes(d.signerPos) ? d.signerPos : last) === signerPosition);
}

function validNationalId(v: string): boolean {
  if (!/^\d{10}$/.test(v) || /^(\d)\1{9}$/.test(v)) return false;
  const check = Number(v[9]);
  const sum = v.split("").slice(0, 9).reduce((a, d, i) => a + Number(d) * (10 - i), 0);
  const r = sum % 11;
  return r < 2 ? check === r : check === 11 - r;
}

export type FieldCheck = { ok: true; value: string } | { ok: false; error: string };

/** اعتبارسنجی و نرمال‌سازی مقدار یک فیلد (ارقام فارسی/عربی به انگلیسی تبدیل می‌شوند، به‌جز متن آزاد) */
export function validateFieldValue(def: Pick<FieldDef, "type" | "label" | "required">, raw: unknown): FieldCheck {
  const cleaned = String(raw ?? "").replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return def.required ? { ok: false, error: `«${def.label}» را وارد کنید` } : { ok: true, value: "" };
  switch (def.type) {
    case "nid": {
      const v = toEnDigits(cleaned).replace(/[\s-]/g, "");
      return validNationalId(v) ? { ok: true, value: v } : { ok: false, error: `«${def.label}» معتبر نیست (کد ملی ۱۰ رقمی صحیح وارد کنید)` };
    }
    case "date": {
      const v = toEnDigits(cleaned).replace(/[-.]/g, "/");
      const m = /^(13\d{2}|14\d{2})\/(\d{1,2})\/(\d{1,2})$/.exec(v);
      if (m) {
        const mo = Number(m[2]);
        const d = Number(m[3]);
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= (mo <= 6 ? 31 : 30)) return { ok: true, value: `${m[1]}/${String(mo).padStart(2, "0")}/${String(d).padStart(2, "0")}` };
      }
      return { ok: false, error: `«${def.label}» باید تاریخ شمسی به‌صورت ۱۴۰۵/۰۲/۱۵ باشد` };
    }
    case "phone": {
      const v = toEnDigits(cleaned).replace(/[\s-]/g, "");
      return /^0\d{10}$/.test(v) ? { ok: true, value: v } : { ok: false, error: `«${def.label}» معتبر نیست (۱۱ رقم با صفر اول)` };
    }
    case "number": {
      const v = toEnDigits(cleaned).replace(/[,٬\s]/g, "");
      return /^\d{1,20}$/.test(v) ? { ok: true, value: v } : { ok: false, error: `«${def.label}» باید فقط عدد باشد` };
    }
    case "email":
      return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(cleaned) && cleaned.length <= 120 ? { ok: true, value: cleaned.toLowerCase() } : { ok: false, error: `«${def.label}» ایمیل معتبر نیست` };
    case "address":
      return cleaned.length >= 8 && cleaned.length <= 500 ? { ok: true, value: cleaned } : { ok: false, error: `«${def.label}» باید بین ۸ تا ۵۰۰ نویسه باشد` };
    default:
      return cleaned.length <= 200 ? { ok: true, value: cleaned } : { ok: false, error: `«${def.label}» حداکثر ۲۰۰ نویسه می‌تواند باشد` };
  }
}

/**
 * جایگزینی توکن‌ها با مقدار واقعی (یا جای خالی). خروجی از ساختار امن ساخته می‌شود و همه‌ی متن‌ها escape می‌شوند؛
 * بنابراین باید روی HTML «پس از sanitize» اجرا شود.
 */
export function renderFieldTokens(html: string, values: ReadonlyMap<string, string>, mode: "web" | "pdf" = "web"): string {
  return (html || "").replace(FIELD_TOKEN_RE, (whole, inner: string) => {
    const def = parseToken(inner);
    if (!def) return whole;
    const v = values.get(def.key);
    if (v) return mode === "pdf" ? `<strong>${escapeHtml(v)}</strong>` : `<span class="amz-field amz-field-filled" title="${escapeHtml(def.label)}">${escapeHtml(v)}</span>`;
    return mode === "pdf" ? `${escapeHtml(def.label)}: ……………` : `<span class="amz-field amz-field-blank">${escapeHtml(def.label)}</span>`;
  });
}
