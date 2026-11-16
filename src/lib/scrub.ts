/**
 * AI-01: پاک‌سازی «رازها و داده‌ی شخصی» از هر متنی که ممکن است به کاربر، لاگ یا دیتابیس برگردد
 * (به‌ویژه پیام خطای سرویس‌های بیرونی که گاهی کلید API، توکن، ایمیل یا حتی بخشی از درخواست ما را بازتاب می‌دهند).
 *
 * بدون وابستگی؛ هم در `lib/external` و هم در ماژول AI استفاده می‌شود.
 */

/** الگوهای رازهای رایج (کلید سرویس‌ها، توکن Bearer، JWT، هش/توکن بلند) */
const PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer …"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.?[A-Za-z0-9_-]*/g, "…jwt…"],
  [/\bsk-[A-Za-z0-9_*.-]{4,}/gi, "sk-…"],
  [/\b(?:AIza|gsk_|xai-|pplx-|r8_|hf_|ghp_|glpat-|AKIA)[A-Za-z0-9_*-]{6,}/g, "…key…"],
  [/\b(api[_-]?key|x-api-key|authorization|access[_-]?token|secret|password|passwd|token)(["']?\s*[:=]\s*["']?)[^\s"',;}]{4,}/gi, "$1$2…"],
  // آدرس: query-string (اغلب توکن/کلید دارد) و اطلاعات کاربری درون URL حذف می‌شوند
  [/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1…@"],
  [/(https?:\/\/[^\s?#"')]+)\?[^\s"')]*/gi, "$1?…"],
  [/\b[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g, "[email]"],
  [/(?<![\d\w])(?:\+?98|0098|0)?9\d{9}(?!\d)/g, "[phone]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[ip]"],
  // هر رشته‌ی لاتین/عددی بلند بدون فاصله (توکن، هش، شناسه‌ی درخواست) — حداقل ۳۲ نویسه
  [/\b[A-Za-z0-9_+/=-]{32,}\b/g, "…"],
];

/**
 * @param text   متن ورودی (پیام خطا، بدنه‌ی پاسخ سرویس، …)
 * @param secrets مقادیر دقیقی که هرگز نباید دیده شوند (کلید فعلی، مقدارهای واقعی نشانگرسازی‌شده، …)
 */
export function scrubSecrets(text: string, secrets: readonly string[] = [], max = 300): string {
  let out = String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ");
  // رازهای شناخته‌شده: طولانی‌ترها اول تا رازِ پیشوندِ دیگری نیمه‌باز نماند
  const list = [...new Set(secrets.filter((s) => typeof s === "string" && s.trim().length >= 4))].sort((a, b) => b.length - a.length);
  for (const s of list) out = out.split(s).join("•••");
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  out = out.trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}
