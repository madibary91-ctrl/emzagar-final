/**
 * جانمایی بصری فیلدها روی صفحه‌های فایل (بدون وابستگی به سرور؛ هم در ویرایشگر مرورگر و هم در اعتبارسنجی سرور استفاده می‌شود).
 * مختصات «کسری» هستند (۰ تا ۱) و مبدأ گوشه‌ی بالا-راستِ چپِ صفحه‌ی «نمایشی» (پس از اعمال چرخش صفحه) است؛
 * بنابراین مستقل از اندازه‌ی نمایش در مرورگر یا اندازه‌ی واقعی PDF‌اند.
 */
export type FieldKind = "signature" | "name" | "date" | "text" | "checkbox";

export interface Placement {
  signerPosition: number;
  kind: FieldKind;
  label: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
}

export interface PageMeta {
  w: number;
  h: number;
}

export const FIELD_KINDS: { id: FieldKind; label: string; hint: string; w: number; h: number }[] = [
  { id: "signature", label: "امضا", hint: "تصویر امضای فرد", w: 150, h: 56 },
  { id: "name", label: "نام کامل", hint: "خودکار از نام امضاکننده", w: 130, h: 24 },
  { id: "date", label: "تاریخ امضا", hint: "خودکار (شمسی) در لحظه‌ی امضا", w: 92, h: 24 },
  { id: "text", label: "متن", hint: "امضاکننده تایپ می‌کند (مثلاً کد ملی)", w: 150, h: 24 },
  { id: "checkbox", label: "تیک تأیید", hint: "امضاکننده تیک می‌زند", w: 22, h: 22 },
];

export const KIND_LABEL: Record<FieldKind, string> = Object.fromEntries(FIELD_KINDS.map((k) => [k.id, k.label])) as Record<FieldKind, string>;
export const SIGNER_COLORS = ["#2563eb", "#db2777", "#16a34a", "#d97706", "#7c3aed", "#0891b2"];
export const MAX_PLACEMENTS = 60;
export const MAX_DOC_PAGES = 100;
export const fieldKey = (id: number) => `df_${id}`;

const KINDS = new Set<string>(FIELD_KINDS.map((k) => k.id));
const CTRL = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e<>]/g;
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

export type PlacementResult = { ok: true; items: Placement[] } | { ok: false; error: string };

/** ورودی نامطمئن (JSON کلاینت) را به فهرست استاندارد و ایمن تبدیل می‌کند */
export function sanitizePlacements(raw: unknown, pageCount: number, signerCount: number, opts: { requireSignatureFor?: number[] } = {}): PlacementResult {
  let list: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > 100_000) return { ok: false, error: "جانمایی بیش از حد بزرگ است" };
    try {
      list = JSON.parse(raw);
    } catch {
      return { ok: false, error: "جانمایی فیلدها معتبر نیست" };
    }
  }
  if (!Array.isArray(list)) return { ok: false, error: "جانمایی فیلدها معتبر نیست" };
  if (list.length > MAX_PLACEMENTS) return { ok: false, error: `حداکثر ${MAX_PLACEMENTS} فیلد روی یک فایل مجاز است` };
  const items: Placement[] = [];
  for (const r of list as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") return { ok: false, error: "جانمایی فیلدها معتبر نیست" };
    const kind = String(r.kind);
    const pos = Math.trunc(Number(r.signerPosition));
    const page = Math.trunc(Number(r.page));
    const [x, y, w, h] = [Number(r.x), Number(r.y), Number(r.w), Number(r.h)];
    if (!KINDS.has(kind) || !(pos >= 1 && pos <= signerCount) || !(page >= 1 && page <= pageCount) || ![x, y, w, h].every(Number.isFinite)) {
      return { ok: false, error: "یکی از فیلدها خارج از محدوده‌ی فایل یا امضاکنندگان است" };
    }
    const cw = clamp(w, 0.015, 1);
    const ch = clamp(h, 0.01, 1);
    items.push({
      signerPosition: pos,
      kind: kind as FieldKind,
      label: String(r.label ?? "").replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, 60),
      page,
      x: clamp(x, 0, 1 - cw),
      y: clamp(y, 0, 1 - ch),
      w: cw,
      h: ch,
      required: kind === "signature" ? true : r.required !== false,
    });
  }
  for (const pos of opts.requireSignatureFor ?? []) {
    if (!items.some((i) => i.signerPosition === pos && i.kind === "signature")) return { ok: false, error: `برای امضاکننده‌ی شماره‌ی ${pos} حداقل یک «جای امضا» روی فایل بگذارید` };
  }
  return { ok: true, items };
}
