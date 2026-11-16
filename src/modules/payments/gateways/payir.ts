import { num, postJson, str } from "../http";
import type { GatewayAdapter, VerifyOutcome } from "../types";

const BASE = "https://pay.ir/pg";
/** کلید آزمایشی Pay.ir مقدار «test» است */
const isTest = (k: string) => k.trim() === "test";

export const payir: GatewayAdapter = {
  id: "payir",
  label: "پی‌دات‌آی‌آر (Pay.ir)",
  blurb: "درگاه Pay.ir — برای تست از کلید «test» استفاده کنید",
  credentialLabel: "کلید API",
  envVar: "PAYIR_API_KEY",
  isValidCredential: (c) => /^[A-Za-z0-9]{4,64}$/.test(c.trim()),

  async init(api, i) {
    const call = await postJson(`${BASE}/send`, {
      api,
      amount: i.amountRial,
      redirect: i.callbackUrl,
      factorNumber: i.orderId,
      description: i.description.slice(0, 200),
      ...(i.mobile && /^09\d{9}$/.test(i.mobile) ? { mobile: i.mobile } : {}),
    });
    if (call.transient) return { ok: false, transient: true, error: call.netError ?? "خطای ارتباط" };
    const token = str(call.json?.token);
    if (num(call.json?.status) !== 1 || !/^[A-Za-z0-9]{4,64}$/.test(token)) return { ok: false, transient: false, error: `کد ${str(call.json?.errorCode) || "?"}: ${str(call.json?.errorMessage)}` };
    return { ok: true, token, redirectUrl: `${BASE}/${token}`, testMode: isTest(api) };
  },

  // بازگشت (POST یا GET): status=1 یعنی پرداخت موفق
  parseCallback: (q) => ({ token: q.get("token"), ok: q.get("status") === "1" }),

  async verify(api, p): Promise<VerifyOutcome> {
    const call = await postJson(`${BASE}/verify`, { api, token: p.token });
    if (!call.transient && num(call.json?.status) === 1) return { state: "paid", refId: str(call.json?.transId) || p.token, amountRial: num(call.json?.amount) };
    // پاسخ غیرموفق Pay.ir ممکن است «تایید قبلی» یا خطای موقت باشد؛ برای امنیت پول کاربر، قطعی رد نمی‌کنیم و بعداً دوباره بررسی می‌شود
    return { state: "unknown", error: call.netError ?? `کد ${str(call.json?.errorCode) || "?"}: ${str(call.json?.errorMessage)}` };
  },
};
