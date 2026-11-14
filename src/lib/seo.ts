import { getOrigin } from "@/lib/request";

/** آدرس پایه‌ی عمومی سایت (APP_URL یا هدر Host). بدون آن، آدرس توسعه. */
export async function siteOrigin(): Promise<string> {
  const o = await getOrigin().catch(() => "");
  return o || "http://localhost:3000";
}

/** JSON-LD امن برای درج در <script>: جلوگیری از بسته‌شدن زودهنگام تگ */
export const jsonLdString = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** مسیرهایی که نباید ایندکس شوند (پنل، احراز هویت، لینک‌های امضا) */
export const PRIVATE_PATHS = ["/admin", "/dashboard", "/account", "/platform", "/support", "/notifications", "/contracts", "/shop", "/sign", "/amend", "/s/", "/embed", "/install", "/login", "/forgot", "/reset", "/invite", "/verify-email", "/landing-preview", "/connect", "/vault", "/api/"];
