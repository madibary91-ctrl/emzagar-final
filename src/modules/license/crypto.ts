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

/** کلید عمومی فروشنده: متغیر محیطی یا مقدار تعبیه‌شده در محصول (public-key.ts) */
export function embeddedPublicKey(): string {
  return (process.env.LICENSE_PUBLIC_KEY || "").trim();
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
