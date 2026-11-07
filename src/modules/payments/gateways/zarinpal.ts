import { externalBase, externalPublicBase, simActive } from "@/lib/external";
import { num, postJson, str } from "../http";
import type { GatewayAdapter, VerifyOutcome } from "../types";

const LIVE = "https://payment.zarinpal.com";
const SANDBOX = "https://sandbox.zarinpal.com";
const sandbox = () => !simActive() && process.env.ZARINPAL_SANDBOX === "1";
const real = () => (sandbox() ? SANDBOX : LIVE);
const base = () => externalBase("zarinpal", real());
const publicBase = () => externalPublicBase("zarinpal", real());

/** کدهای «قطعی» verify: پرداخت انجام نشده/نامعتبر است و دیگر نباید منتظر ماند */
const DEFINITIVE_FAIL = new Set([-50, -51, -53, -54]);

const errText = (j: Record<string, unknown> | null) => {
  const e = j?.errors;
  return e && typeof e === "object" && !Array.isArray(e) ? `کد ${str((e as Record<string, unknown>).code) || "?"}: ${str((e as Record<string, unknown>).message)}` : "پاسخ نامعتبر از درگاه";
};
const dataOf = (j: Record<string, unknown> | null): Record<string, unknown> => (j?.data && typeof j.data === "object" && !Array.isArray(j.data) ? (j.data as Record<string, unknown>) : {});

export const zarinpal: GatewayAdapter = {
  id: "zarinpal",
  label: "زرین‌پال",
  blurb: "API نسخه‌ی ۴ — شناسه‌ی مرچنت ۳۶ نویسه‌ای",
  credentialLabel: "شناسه‌ی مرچنت (Merchant ID)",
  envVar: "ZARINPAL_MERCHANT_ID",
  isValidCredential: (c) => /^[0-9a-fA-F-]{36}$/.test(c.trim()),

  async init(merchant, i) {
    const call = await postJson(`${base()}/pg/v4/payment/request.json`, {
      merchant_id: merchant,
      amount: i.amountRial,
      currency: "IRR",
      callback_url: i.callbackUrl,
      description: i.description,
      metadata: { order_id: i.orderId, ...(i.mobile ? { mobile: i.mobile } : {}) },
    });
    if (call.transient) return { ok: false, transient: true, error: call.netError ?? "خطای ارتباط" };
    const d = dataOf(call.json);
    const authority = str(d.authority);
    if (num(d.code) !== 100 || !/^[A-Za-z0-9]{10,60}$/.test(authority)) return { ok: false, transient: false, error: errText(call.json) };
    return { ok: true, token: authority, redirectUrl: `${publicBase()}/pg/StartPay/${authority}`, testMode: sandbox() || simActive() };
  },

  parseCallback: (q) => ({ token: q.get("Authority"), ok: q.get("Status") === "OK" }),

  async verify(merchant, p): Promise<VerifyOutcome> {
    const call = await postJson(`${base()}/pg/v4/payment/verify.json`, { merchant_id: merchant, amount: p.amountRial, authority: p.token });
    const d = dataOf(call.json);
    const code = num(d.code);
    if (code === 100 || code === 101) return { state: "paid", refId: str(d.ref_id) };
    const errs = call.json?.errors;
    const errCode = errs && typeof errs === "object" && !Array.isArray(errs) ? num((errs as Record<string, unknown>).code) : undefined;
    // فقط پاسخ «قطعی» درگاه تراکنش را ناموفق می‌کند؛ قطعی شبکه/5xx/خطای پیکربندی مرچنت: pending می‌ماند
    if (call.transient || errCode === undefined || !DEFINITIVE_FAIL.has(errCode)) return { state: "unknown", error: call.netError ?? errText(call.json) };
    return { state: "failed", error: `تایید تراکنش ناموفق بود (${errText(call.json)})` };
  },
};
