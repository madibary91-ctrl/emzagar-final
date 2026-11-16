/**
 * مغز ربات: دستورها و دکمه‌های کاربر (لینک امضا، وضعیت قرارداد، یادآوری، نسخه‌ی نهایی، خلاصه‌ی تیم، اتصال حساب).
 * ورودی هر دو مسیر وب‌هوک و polling است. هیچ خطایی بیرون نمی‌پرد (وب‌هوک نباید با خطا برگردد و باعث بارش تکرار شود).
 */

const M_PENDING = "✍️ منتظر امضای من";
const M_CONTRACTS = "📄 قراردادهای من";
const M_SUMMARY = "📊 خلاصه‌ی کسب‌وکار";
const M_HELP = "❓ راهنما";
const MENU_TEXT: Record<string, string> = { [M_PENDING]: "pending", [M_CONTRACTS]: "contracts", [M_SUMMARY]: "summary", [M_HELP]: "help" };
export const MENU = { keyboard: [[{ text: M_PENDING }, { text: M_CONTRACTS }], [{ text: M_SUMMARY }, { text: M_HELP }]], resize_keyboard: true, is_persistent: true };
export const ASK_CONTACT = { keyboard: [[{ text: "📱 اشتراک شماره‌ی من", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
export function parseCommand(text: string): { cmd: string; arg: string } | null {
  const t = text.trim();
  const m = /^\/([A-Za-z_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(t);
  if (m) return { cmd: m[1].toLowerCase(), arg: (m[2] || "").trim() };
  if (MENU_TEXT[t]) return { cmd: MENU_TEXT[t], arg: "" };
  return null;
}
export const STATE_LABEL: Record<string, string> = { my_turn: "✍️ نوبت شماست", waiting: "⏳ در انتظار دیگران", signed: "✅ امضا شده", rejected: "❌ رد شده", expired: "⌛ منقضی", cancelled: "🚫 لغو شده" };
