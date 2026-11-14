import { validateFieldValue, type FieldType } from "@/modules/fields";

/**
 * تعریف فیلدهای فرم جمع‌آوری امضا (کلاینت‌-سیف: هم سازنده‌ی فرم، هم فرم عمومی، هم اعتبارسنجی سرور).
 * نوع‌های «کد ملی، تاریخ، تلفن، عدد، ایمیل، نشانی، متن» همان اعتبارسنجی‌های فیلدهای قرارداد را دارند.
 */
export type CollectFieldType = FieldType | "select" | "checkbox";

export interface CollectField {
  key: string;
  label: string;
  type: CollectFieldType;
  required: boolean;
  options?: string[];
}

export const COLLECT_FIELD_TYPES: { id: CollectFieldType; label: string }[] = [
  { id: "text", label: "متن کوتاه" },
  { id: "nid", label: "کد ملی" },
  { id: "phone", label: "تلفن" },
  { id: "date", label: "تاریخ (شمسی)" },
  { id: "number", label: "عدد" },
  { id: "email", label: "ایمیل" },
  { id: "address", label: "نشانی" },
  { id: "select", label: "انتخاب از فهرست" },
  { id: "checkbox", label: "تیک تأیید" },
];

const TYPE_IDS = new Set<string>(COLLECT_FIELD_TYPES.map((t) => t.id));
const KEY_RE = /^[a-z][a-z0-9_]{0,29}$/;
export const MAX_COLLECT_FIELDS = 20;
const CTRL = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e<>]/g;
const cleanText = (s: unknown, max: number) => String(s ?? "").replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** خروجی همیشه امن و استاندارد است؛ ورودی نامعتبر کنار گذاشته می‌شود */
export function parseCollectFields(raw: unknown): CollectField[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: CollectField[] = [];
  for (const r of list as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const label = cleanText(r.label, 80);
    let key = String(r.key ?? "").toLowerCase();
    if (!KEY_RE.test(key) || key.startsWith("df_") || seen.has(key)) {
      key = `f${out.length + 1}`;
      while (seen.has(key)) key += "x";
    }
    const type = (TYPE_IDS.has(String(r.type)) ? String(r.type) : "text") as CollectFieldType;
    if (!label) continue;
    const f: CollectField = { key, label, type, required: r.required !== false };
    if (type === "select") {
      const opts = (Array.isArray(r.options) ? r.options : String(r.options ?? "").split(/[\n,،]/)).map((o) => cleanText(o, 60)).filter(Boolean);
      f.options = [...new Set(opts)].slice(0, 20);
      if (f.options.length < 2) continue;
    }
    seen.add(key);
    out.push(f);
    if (out.length >= MAX_COLLECT_FIELDS) break;
  }
  return out;
}

export type CollectValues = { ok: true; values: Record<string, string> } | { ok: false; error: string };

export function validateCollectValues(defs: CollectField[], input: Record<string, unknown> | undefined): CollectValues {
  const values: Record<string, string> = {};
  for (const d of defs) {
    const raw = input?.[d.key];
    if (d.type === "checkbox") {
      const on = ["1", "true", "on"].includes(String(raw ?? ""));
      if (!on && d.required) return { ok: false, error: `تیک «${d.label}» الزامی است` };
      if (on) values[d.key] = "1";
      continue;
    }
    if (d.type === "select") {
      const v = cleanText(raw, 60);
      if (!v) {
        if (d.required) return { ok: false, error: `«${d.label}» را انتخاب کنید` };
        continue;
      }
      if (!d.options?.includes(v)) return { ok: false, error: `گزینه‌ی «${d.label}» معتبر نیست` };
      values[d.key] = v;
      continue;
    }
    const r = validateFieldValue({ type: d.type as FieldType, label: d.label, required: d.required }, raw);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.value) values[d.key] = r.value;
  }
  return { ok: true, values };
}

export const displayValue = (d: CollectField, v: string | undefined) => (d.type === "checkbox" ? (v === "1" ? "بله" : "خیر") : (v ?? ""));
