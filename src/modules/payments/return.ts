import { flashQuery } from "@/lib/flash";
import { paymentIdByAuthority, type VerifyResult } from "./service";

/**
 * مقصد و پیام امضاشده‌ی بازگشت از درگاه (برای هر دو مسیر بازگشت).
 * پرداخت قرارداد به همان صفحه‌ای برمی‌گردد که از آن شروع شد (صفحه‌ی امضا یا لینک پرداخت)؛ مسیر فقط داخلی است.
 * پرداخت اشتراک/شارژ با `pid` برمی‌گردد تا صفحه «رسید» (کد پیگیری، فاکتور) را از دیتابیس نشان دهد، نه از متن آدرس.
 */
export async function paymentReturn(r: VerifyResult, authority: string): Promise<{ dest: string; query: string }> {
  const contractDest = r.kind === "contract" && r.returnPath?.startsWith("/") && !r.returnPath.startsWith("//") ? r.returnPath : null;
  const dest = contractDest ?? (r.kind === "topup" ? "/admin/wallet" : "/admin/billing");
  const pid = r.kind === "contract" ? null : await paymentIdByAuthority(authority).catch(() => null);
  return { dest, query: flashQuery(r.ok ? "ok" : "error", r.message, pid) };
}

/** خطاهای پیش از تایید (درگاه ناشناخته، درخواست زیاد) با همان قالب امضاشده */
export const flashBack = (path: string, kind: "ok" | "error", msg: string) => ({ dest: path, query: flashQuery(kind, msg) });
