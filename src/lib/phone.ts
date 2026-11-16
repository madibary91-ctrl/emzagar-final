import { normalizeDigits } from "./numbers";

/**
 * موبایل ایران به قالب استاندارد 09xxxxxxxxx؛ نامعتبر ⇒ null.
 * قالب‌های پذیرفته‌شده: ارقام فارسی/عربی، +98912…، 0098912…، 98912…، 912… و جداکننده‌های رایج (فاصله، خط تیره، پرانتز).
 * (نسخه‌ی خالص و بدون وابستگی؛ همان منطق `normalizeMobile` مهمان‌ها ولی برای فرم‌های ثبت‌نام/حساب/دعوت.)
 */
export function parseIranMobile(raw: unknown): string | null {
  let s = normalizeDigits(raw).replace(/[-().]/g, "");
  if (s.startsWith("+98")) s = "0" + s.slice(3);
  else if (s.startsWith("0098")) s = "0" + s.slice(4);
  else if (/^98\d{10}$/.test(s)) s = "0" + s.slice(2);
  else if (/^9\d{9}$/.test(s)) s = "0" + s;
  return /^09\d{9}$/.test(s) ? s : null;
}

export const MOBILE_HINT = "شماره‌ی موبایل معتبر نیست؛ مثل 09123456789 وارد کنید (ارقام فارسی و +98 هم پذیرفته می‌شود)";
