import { num, postJson, str } from "../http";
import type { GatewayAdapter, VerifyOutcome } from "../types";

const BASE = "https://api.idpay.ir/v1.1";
/** حالت آزمایشی (X-SANDBOX) با IDPAY_SANDBOX=1 */
const sandbox = () => process.env.IDPAY_SANDBOX === "1";
const headers = (key: string) => ({ "X-API-KEY": key, "X-SANDBOX": sandbox() ? "1" : "0" });

export const idpay: GatewayAdapter = {
  id: "idpay",
  label: "آیدی‌پی",
  blurb: "IDPay v1.1 — کلید API پذیرنده",
  credentialLabel: "کلید API (X-API-KEY)",
  envVar: "IDPAY_API_KEY",
  isValidCredential: (c) => /^[A-Za-z0-9-]{16,80}$/.test(c.trim()),

  async init(key, i) {
    const call = await postJson(`${BASE}/payment`, { order_id: i.orderId, amount: i.amountRial, desc: i.description.slice(0, 250), callback: i.callbackUrl, ...(i.mobile && /^09\d{9}$/.test(i.mobile) ? { phone: i.mobile } : {}) }, headers(key));
    if (call.transient) return { ok: false, transient: true, error: call.netError ?? "خطای ارتباط" };
    const id = str(call.json?.id);
    const link = str(call.json?.link);
    let hostOk = false;
    try {
      const u = new URL(link);
      hostOk = u.protocol === "https:" && (u.hostname === "idpay.ir" || u.hostname.endsWith(".idpay.ir"));
    } catch {
      hostOk = false;
    }
    if (!/^[A-Za-z0-9]{6,64}$/.test(id) || !hostOk) return { ok: false, transient: false, error: `کد ${str(call.json?.error_code) || "?"}: ${str(call.json?.error_message)}` };
    return { ok: true, token: id, redirectUrl: link, testMode: sandbox() };
  },

  // بازگشت (POST یا GET): status=10 یعنی پرداخت شد و منتظر تایید پذیرنده است
  parseCallback: (q) => ({ token: q.get("id"), ok: q.get("status") === "10" }),

  async verify(key, p): Promise<VerifyOutcome> {
    const call = await postJson(`${BASE}/payment/verify`, { id: p.token, order_id: p.orderId }, headers(key));
    const status = num(call.json?.status);
    // 100 = تایید شد، 101 = قبلاً تایید شده
    if (!call.transient && (status === 100 || status === 101)) {
      const pay = call.json?.payment && typeof call.json.payment === "object" ? (call.json.payment as Record<string, unknown>) : {};
      return { state: "paid", refId: str(call.json?.track_id) || p.token, amountRial: num(pay.amount) ?? num(call.json?.amount) };
    }
    // وضعیت‌های 1..8 یعنی پرداخت انجام نشده/ناموفق (قطعی)
    if (!call.transient && status !== undefined && status >= 1 && status <= 8) return { state: "failed", error: `تایید تراکنش ناموفق بود (وضعیت ${status})` };
    return { state: "unknown", error: call.netError ?? `کد ${str(call.json?.error_code) || "?"}: ${str(call.json?.error_message)}` };
  },
};
