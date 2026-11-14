/** قواعد مشترک اعتبارسنجی حساب (فایل «use server» نیست تا بتوان مقدارها را export کرد) */
export const PASSWORD_MIN = 8;
export const MOBILE_RE = /^09\d{9}$/;

export function passwordProblem(p: string): string | null {
  if (p.length < PASSWORD_MIN) return `رمز عبور باید حداقل ${PASSWORD_MIN} نویسه باشد`;
  if (!/[A-Za-z؀-ۿ]/.test(p) || !/\d/.test(p)) return "رمز عبور باید ترکیبی از حروف و عدد باشد";
  return null;
}

/** مسیر امن پس از ورود (فقط مسیرهای داخلی؛ جلوگیری از Open Redirect) */
export function safeNext(raw: unknown): string | null {
  const next = String(raw || "");
  return /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]*$/.test(next) ? next : null;
}
