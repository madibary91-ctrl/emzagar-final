import { devFlag } from "@/lib/dev-flags";
import crypto from "node:crypto";
import type { GatewayAdapter } from "../types";

/** درگاه آزمایشی داخلی: فقط وقتی هیچ درگاه واقعی تنظیم نشده و محیط توسعه است (یا ALLOW_DEMO_PAYMENTS=1) */
export const demoAllowed = () => process.env.NODE_ENV !== "production" || devFlag("ALLOW_DEMO_PAYMENTS");

export const sandboxGateway: GatewayAdapter = {
  id: "sandbox",
  label: "درگاه آزمایشی",
  blurb: "پرداخت شبیه‌سازی‌شده برای توسعه و دمو",
  credentialLabel: "—",
  envVar: "",
  isValidCredential: () => true,

  async init(_cred, i) {
    const token = `DEMO-${crypto.randomBytes(12).toString("hex")}`;
    const sep = i.callbackUrl.includes("?") ? "&" : "?";
    return { ok: true, token, redirectUrl: `${i.callbackUrl}${sep}Authority=${token}&Status=OK`, testMode: true };
  },
  parseCallback: (q) => ({ token: q.get("Authority"), ok: q.get("Status") === "OK" }),
  async verify(_cred, p) {
    if (!demoAllowed()) return { state: "failed", error: "پرداخت آزمایشی در این محیط مجاز نیست" };
    return { state: "paid", refId: `DEMO-${p.orderId}` };
  },
};
