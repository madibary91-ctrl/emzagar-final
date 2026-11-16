import crypto from "node:crypto";

/**
 * امضای دیجیتال Ed25519 برای پاسخ‌های سرور لایسنس.
 * سرور با کلید خصوصی امضا می‌کند و برنامه‌ی خریدار فقط با کلید عمومی (که داخل محصول است) راستی‌آزمایی می‌کند؛
 * پس هیچ‌کس نمی‌تواند با یک سرور جعلی، لایسنس یا فایل به‌روزرسانی ساختگی تحویل دهد.
 */
export interface KeyPairPem {
  privateKey: string;
  publicKey: string;
}

export function generateKeyPair(): KeyPairPem {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** PEM یا Base64 خام DER را می‌پذیرد (برای متغیر محیطی تک‌خطی) */
function normalizePem(raw: string, label: "PUBLIC KEY" | "PRIVATE KEY"): string {
  const t = raw.trim().replace(/\\n/g, "\n");
  if (t.includes("BEGIN")) return t;
  const body = t.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

export function signText(text: string, privateKeyPem: string): string {
  return crypto.sign(null, Buffer.from(text, "utf8"), crypto.createPrivateKey(normalizePem(privateKeyPem, "PRIVATE KEY"))).toString("base64");
}

export function verifyText(text: string, signatureB64: string, publicKeyPem: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(text, "utf8"), crypto.createPublicKey(normalizePem(publicKeyPem, "PUBLIC KEY")), Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export type Signed = { payload: string; sig: string };

export const signPayload = (obj: unknown, privateKeyPem: string): Signed => {
  const payload = JSON.stringify(obj);
  return { payload, sig: signText(payload, privateKeyPem) };
};

/**
 * کلید عمومی فروشنده (ریشه‌ی اعتماد زنجیره‌ی لایسنس/به‌روزرسانی).
 *  ۱) مقدار «تعبیه‌شده در محصول» (EMZ_EMBEDDED_LICENSE_PUBLIC_KEY هنگام build با next.config.ts داخل باندل می‌نشیند و
 *     در زمان اجرا با env قابل تغییر نیست) — اولویت با آن است؛
 *  ۲) در غیر این صورت متغیر محیطی LICENSE_PUBLIC_KEY (نصب‌های سورس / سرور فروشنده).
 * اگر هیچ‌کدام نباشد، تابع رشته‌ی خالی برمی‌گرداند و همه‌ی مصرف‌کننده‌ها باید «بسته شکست بخورند» (C-01).
 */
export function embeddedPublicKey(): string {
  const baked = (process.env.EMZ_EMBEDDED_LICENSE_PUBLIC_KEY || "").trim();
  if (baked) return baked;
  return (process.env.LICENSE_PUBLIC_KEY || "").trim();
}

/** کلید عمومی باید یک کلید Ed25519 قابل‌خواندن باشد (کلید خراب/اشتباه = نبود کلید) */
export function isUsablePublicKey(raw: string): boolean {
  if (!raw) return false;
  try {
    return crypto.createPublicKey(normalizePem(raw, "PUBLIC KEY")).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/** کلید عمومی «قابل اعتماد»؛ در نبود/خرابی کلید null (fail-closed) */
export function trustedPublicKey(): string | null {
  const k = embeddedPublicKey();
  return isUsablePublicKey(k) ? k : null;
}

/** کلید لایسنس خوانا: EMZ-XXXXX-XXXXX-XXXXX-XXXXX (بدون حروف مبهم) */
export function newLicenseKey(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const group = () => Array.from(crypto.randomBytes(5), (b) => alphabet[b % alphabet.length]).join("");
  return `EMZ-${group()}-${group()}-${group()}-${group()}`;
}

export const LICENSE_KEY_RE = /^EMZ-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/;

/** نام دامنه‌ی نرمال: حروف کوچک، بدون پروتکل/پورت/www */
export function normalizeDomain(input: string): string {
  let h = input.trim().toLowerCase();
  try {
    h = new URL(/^[a-z]+:\/\//.test(h) ? h : `https://${h}`).hostname;
  } catch {
    /* همان ورودی */
  }
  return h.replace(/^www\./, "").replace(/\.$/, "");
}

/** دامنه‌های توسعه سهمیه‌ی فعال‌سازی مصرف نمی‌کنند */
export const isDevDomain = (d: string) => d === "localhost" || /^127\./.test(d) || d === "::1" || d.endsWith(".local") || d.endsWith(".test") || d.endsWith(".localhost");
