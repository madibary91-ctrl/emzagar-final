import { type FieldDef, ICON_NAMES, type Props, type Value } from "./model";

/* ───────── پاک‌سازی (سرور و کلاینت) ───────── */
const HEX = /^#[0-9a-fA-F]{6}$/;
const LINK_OK = [/^\/(?!\/)[^\s<>"']*$/, /^#[A-Za-z0-9_-]*$/, /^https?:\/\/[^\s<>"']+$/i, /^mailto:[^\s<>"']+$/i, /^tel:[+0-9-]+$/];
const IMAGE_OK = [/^\/api\/landing\/image\/[A-Za-z0-9._-]{1,80}$/, /^https:\/\/[^\s<>"']+$/i];
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
export function cleanText(v: unknown, max: number, multiline = false): string {
  let s = typeof v === "string" ? v : "";
  s = s.replace(/\r\n?/g, "\n").replace(CTRL, "");
  if (!multiline) s = s.replace(/\s*\n+\s*/g, " ");
  return s.trim().slice(0, max);
}
export function cleanLink(v: unknown): string {
  const s = cleanText(v, 300);
  return LINK_OK.some((re) => re.test(s)) ? s : "";
}
export function cleanImage(v: unknown): string {
  const s = cleanText(v, 400);
  return IMAGE_OK.some((re) => re.test(s)) ? s : "";
}
export function emptyValue(f: FieldDef): Value {
  switch (f.kind) {
    case "toggle": return false;
    case "list": return [];
    case "select": return f.options[0]?.value ?? "";
    default: return "";
  }
}
export function sanitizeProps(fields: FieldDef[], input: unknown): Props {
  const src = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: Props = {};
  for (const f of fields) {
    const raw = src[f.key];
    switch (f.kind) {
      case "text": out[f.key] = cleanText(raw, f.max ?? 120); break;
      case "textarea": out[f.key] = cleanText(raw, f.max ?? 400, true); break;
      case "toggle": out[f.key] = raw === true; break;
      case "link": out[f.key] = cleanLink(raw); break;
      case "image": out[f.key] = cleanImage(raw); break;
      case "color": out[f.key] = typeof raw === "string" && HEX.test(raw) ? raw.toLowerCase() : ""; break;
      case "icon": out[f.key] = (ICON_NAMES as readonly string[]).includes(String(raw)) ? String(raw) : "check"; break;
      case "select": out[f.key] = f.options.some((o) => o.value === raw) ? String(raw) : (f.options[0]?.value ?? ""); break;
      case "list": out[f.key] = Array.isArray(raw) ? raw.slice(0, f.max).map((it) => sanitizeProps(f.fields, it)) : []; break;
    }
  }
  return out;
}
export const ID_RE = /^[a-z0-9-]{3,24}$/;
export function newId(): string {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 7; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
export const MAX_SECTIONS = 30;
