import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { wpConnections } from "@/db/schema";
import { assertSafeUrl, safeFetch } from "@/lib/ssrf";
import { isLocalSite } from "./core";

/**
 * «تست اتصال» واقعی یک سایت وردپرس، بدون نیاز به تغییر افزونه:
 * مسیر عمومی /wp-json/emzagar/v1/verify فقط در طول دست‌دادن پاسخ می‌دهد و در غیر آن با کد خطای اختصاصی
 * `emzagar_not_found` (404) جواب می‌دهد؛ اما اگر افزونه غیرفعال باشد خود وردپرس `rest_no_route` برمی‌گرداند.
 * همین تفاوت، «افزونه فعال و سایت در دسترس» را از «افزونه غیرفعال» و «مسدود شدن توسط فایروال» تفکیک می‌کند.
 */
export type SiteProbe = {
  state: "ok" | "plugin_inactive" | "blocked" | "redirect" | "unreachable" | "server_error" | "local";
  title: string;
  hint: string;
  status?: number;
  ms?: number;
};

export function classifyProbe(input: { local?: boolean; status: number | null; body?: string; error?: string; ms?: number }): SiteProbe {
  const { ms } = input;
  if (input.local) return { state: "local", title: "سایت محلی/آزمایشی است", hint: "ابر از بیرون به آدرس محلی دسترسی ندارد؛ همگام‌سازی فقط به‌صورت Pull (افزونه خودش رویدادها را می‌گیرد) کار می‌کند.", ms };
  if (input.status === null) {
    const e = input.error || "";
    if (/مهلت|timeout|abort/i.test(e)) return { state: "unreachable", title: "سایت در ۹ ثانیه پاسخ نداد", hint: "سرور وردپرس کند یا خاموش است. هاست، منابع سرور یا حالت نگهداری را بررسی کنید.", ms };
    if (/ENOTFOUND|EAI_AGAIN|شناسایی نیست/i.test(e)) return { state: "unreachable", title: "نام دامنه‌ی سایت پیدا نشد", hint: "دامنه منقضی شده یا DNS آن درست نیست.", ms };
    if (/certificate|CERT|SSL|TLS/i.test(e)) return { state: "unreachable", title: "گواهی HTTPS سایت معتبر نیست", hint: "گواهی SSL سایت را تمدید یا درست نصب کنید.", ms };
    return { state: "unreachable", title: "ارتباط با سایت برقرار نشد", hint: "سایت از اینترنت در دسترس نیست یا ورودی ابر را مسدود کرده است.", ms };
  }
  const s = input.status;
  let code = "";
  try {
    code = String((JSON.parse(input.body || "") as { code?: unknown }).code ?? "");
  } catch {
    code = "";
  }
  if (code === "emzagar_not_found" || (s === 200 && /"challenge"/.test(input.body || ""))) return { state: "ok", title: "سایت در دسترس است و افزونه فعال است", hint: "مسیر REST افزونه پاسخ می‌دهد.", status: s, ms };
  if (code === "rest_no_route") return { state: "plugin_inactive", title: "افزونه در وردپرس فعال نیست", hint: "در وردپرس به «افزونه‌ها» بروید و «امضاگیر» را فعال کنید. با فعال‌سازی، اتصال خودکار برمی‌گردد (مگر اتصال را از این پنل قطع کرده باشید).", status: s, ms };
  if (s >= 300 && s < 400) return { state: "redirect", title: "سایت به آدرس دیگری هدایت می‌شود", hint: "آدرس سایت در وردپرس (تنظیمات ← همگانی) با آدرس ثبت‌شده فرق دارد؛ مثلاً www یا https. افزونه را دوباره متصل کنید.", status: s, ms };
  if (s === 401 || s === 403 || s === 406 || s === 429 || s === 503 || code === "rest_forbidden" || /<html/i.test(input.body || "")) return { state: "blocked", title: `سایت پاسخ داد ولی مسیر افزونه بسته است (${s})`, hint: "فایروال، افزونه‌ی امنیتی (مثل Wordfence/iThemes)، Cloudflare یا حالت «به‌زودی/نگهداری» مسیر /wp-json/emzagar را بسته است. آن را برای این مسیر و آدرس‌های ابر باز بگذارید.", status: s, ms };
  if (s >= 500) return { state: "server_error", title: `سایت خطای سرور داد (${s})`, hint: "خطای PHP یا دیتابیس در سایت وردپرس است؛ لاگ خطای هاست را بررسی کنید.", status: s, ms };
  return { state: "blocked", title: `پاسخ غیرمنتظره از سایت (${s})`, hint: "مسیر REST وردپرس را در مرورگر باز کنید و از سالم بودن آن مطمئن شوید.", status: s, ms };
}

export async function probeSite(workspaceId: number, connId: number): Promise<SiteProbe | null> {
  const [c] = await db.select().from(wpConnections).where(and(eq(wpConnections.id, connId), eq(wpConnections.workspaceId, workspaceId)));
  if (!c) return null;
  let local = false;
  try {
    local = isLocalSite(new URL(c.siteUrl));
  } catch {
    local = false;
  }
  if (local) return classifyProbe({ local: true, status: null });
  const t0 = Date.now();
  try {
    const target = await assertSafeUrl(`${c.siteUrl}/?rest_route=${encodeURIComponent("/emzagar/v1/verify")}&handshake=probe`, { allowHttp: true });
    const res = await safeFetch(target, { allowHttp: true, redirect: "manual", signal: AbortSignal.timeout(9000), headers: { Accept: "application/json", "User-Agent": "EmzagarCloud/1.0 (probe)" } });
    const body = (await res.text()).slice(0, 4000);
    return classifyProbe({ status: res.status, body, ms: Date.now() - t0 });
  } catch (e) {
    return classifyProbe({ status: null, error: e instanceof Error ? `${e.message} ${(e as { cause?: { code?: string } }).cause?.code ?? ""}` : "", ms: Date.now() - t0 });
  }
}
