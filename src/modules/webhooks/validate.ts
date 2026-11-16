import crypto from "node:crypto";
import { assertSafeUrl } from "@/lib/ssrf";
import { EVENTS, EXPLICIT_ONLY_EVENTS } from "./meta";

export const WEBHOOK_PROVIDER_IDS = ["telegram", "bale", "rubika", "eitaa", "generic"] as const;
/** سقف تعداد مقصد برای هر فضای کاری (جلوگیری از انفجار ارسال هم‌زمان و سوءاستفاده) */
export const MAX_ENDPOINTS_PER_WORKSPACE = 20;

/** کلید امضای HMAC خودکار برای وب‌هوک عمومی */
export const newSigningSecret = () => `whsec_${crypto.randomBytes(24).toString("hex")}`;

export type EndpointInput = {
  provider: string;
  name: string;
  target: string;
  secret: string;
  baseUrl: string;
  events: string[];
};

export type Checked = { ok: true; value: { name: string; target: string; secret: string; baseUrl: string; events: string } } | { ok: false; error: string; field?: "name" | "target" | "secret" | "baseUrl" };

/** نرمال‌سازی فهرست رویدادها به رشته‌ی ذخیره‌شده: هیچ‌کدام/همه‌ی رویدادهای قراردادی = * */
export function normalizeEvents(chosen: string[]): string {
  const valid = chosen.filter((e) => EVENTS.some((x) => x.id === e && e !== "test"));
  if (valid.length === 0) return "*";
  if (valid.some((c) => EXPLICIT_ONLY_EVENTS.includes(c))) return valid.join(",");
  return valid.length === EVENTS.length - 1 - EXPLICIT_ONLY_EVENTS.length ? "*" : valid.join(",");
}

/** اعتبارسنجی مشترک «ساخت» و «ویرایش»؛ پیام‌ها فارسی و دقیق‌اند و فیلد خطا را هم برمی‌گردانند */
export async function checkEndpointInput(i: EndpointInput): Promise<Checked> {
  const provider = i.provider;
  const name = i.name.trim().slice(0, 80);
  const target = i.target.trim();
  const secret = i.secret.trim();
  const baseUrl = i.baseUrl.trim();
  if (!(WEBHOOK_PROVIDER_IDS as readonly string[]).includes(provider)) return { ok: false, error: "نوع پیام‌رسان نامعتبر است" };
  if (!name) return { ok: false, error: "نام مقصد را وارد کنید", field: "name" };
  if (!target) return { ok: false, error: provider === "generic" ? "آدرس وب‌هوک را وارد کنید" : "شناسه‌ی چت را وارد کنید", field: "target" };

  if (provider === "generic") {
    try {
      await assertSafeUrl(target);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "آدرس نامعتبر", field: "target" };
    }
    return { ok: true, value: { name, target, secret, baseUrl: "", events: normalizeEvents(i.events) } };
  }
  if (!/^[A-Za-z0-9:_\-.]{10,200}$/.test(secret)) {
    return { ok: false, error: "توکن ربات نامعتبر است؛ آن را دقیقاً همان‌طور که BotFather/پدر بات‌ها داده کپی کنید (بدون فاصله).", field: "secret" };
  }
  if (!/^(-?\d{3,20}|@?[A-Za-z0-9_.-]{3,64})$/.test(target)) {
    return { ok: false, error: "شناسه‌ی چت نامعتبر است؛ شناسه‌ی عددی (مثل 123456789 یا -1001234567890) یا @نام‌کانال وارد کنید.", field: "target" };
  }
  if (baseUrl) {
    try {
      await assertSafeUrl(baseUrl);
    } catch (e) {
      return { ok: false, error: "آدرس پروکسی: " + (e instanceof Error ? e.message : "نامعتبر"), field: "baseUrl" };
    }
  }
  return { ok: true, value: { name, target, secret, baseUrl, events: normalizeEvents(i.events) } };
}
