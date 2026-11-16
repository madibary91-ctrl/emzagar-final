import { num, postJson, str } from "../http";
import type { GatewayAdapter, VerifyOutcome } from "../types";

const BASE = "https://gateway.zibal.ir";
/** در سندباکس زیبال، مرچنت «zibal» است */
const isTest = (m: string) => m.trim() === "zibal";

/** نتیجه‌های قطعی verify: پرداخت نشده / شناسه‌ی نامعتبر */
const DEFINITIVE_FAIL = new Set([202, 203]);

export const zibal: GatewayAdapter = {
  id: "zibal",
  label: "زیبال",
  blurb: "درگاه v1 — برای تست از مرچنت «zibal» استفاده کنید",
  credentialLabel: "مرچنت زیبال (Merchant)",
  envVar: "ZIBAL_MERCHANT",
  isValidCredential: (c) => /^[A-Za-z0-9_-]{4,64}$/.test(c.trim()),

  async init(merchant, i) {
    const call = await postJson(`${BASE}/v1/request`, {
      merchant,
      amount: i.amountRial,
      callbackUrl: i.callbackUrl,
      description: i.description.slice(0, 200),
      orderId: i.orderId,
      ...(i.mobile && /^09\d{9}$/.test(i.mobile) ? { mobile: i.mobile } : {}),
    });
    if (call.transient) return { ok: false, transient: true, error: call.netError ?? "خطای ارتباط" };
    const track = str(call.json?.trackId);
    if (num(call.json?.result) !== 100 || !/^\d{4,20}$/.test(track)) return { ok: false, transient: false, error: `کد ${str(call.json?.result) || "?"}: ${str(call.json?.message)}` };
    return { ok: true, token: track, redirectUrl: `${BASE}/start/${track}`, testMode: isTest(merchant) };
  },

  // بازگشت: ?success=1&status=2&trackId=...&orderId=...
  parseCallback: (q) => ({ token: q.get("trackId"), ok: q.get("success") === "1" }),

  async verify(merchant, p): Promise<VerifyOutcome> {
    const call = await postJson(`${BASE}/v1/verify`, { merchant, trackId: Number(p.token) });
    const result = num(call.json?.result);
    // 100 = تایید شد، 201 = قبلاً تایید شده
    if (!call.transient && (result === 100 || result === 201)) return { state: "paid", refId: str(call.json?.refNumber) || p.token, amountRial: num(call.json?.amount) };
    if (!call.transient && result !== undefined && DEFINITIVE_FAIL.has(result)) return { state: "failed", error: `تایید تراکنش ناموفق بود (کد ${result}: ${str(call.json?.message)})` };
    return { state: "unknown", error: call.netError ?? `کد ${str(result) || "?"}: ${str(call.json?.message)}` };
  },
};
