import crypto from "node:crypto";

/**
 * TOTP مطابق RFC 6238 (HMAC‑SHA1، ۶ رقم، بازه‌ی ۳۰ ثانیه) — سازگار با Google Authenticator،
 * Microsoft Authenticator، Authy، 2FAS و … بدون هیچ وابستگی بیرونی.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** راز تصادفی ۱۶۰ بیتی (۳۲ نویسه Base32) */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(key: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / TOTP_PERIOD);

/**
 * بررسی کد ۶ رقمی با تلرانس ±۱ بازه (اختلاف ساعت). اگر معتبر باشد شماره‌ی بازه‌ی منطبق،
 * وگرنه null برمی‌گردد. بازه‌هایی که از lastStep بیشتر نباشند (کد مصرف‌شده) رد می‌شوند.
 */
export function verifyTotp(secret: string, code: string, lastStep = 0, now = Date.now()): number | null {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const key = base32Decode(secret);
  const step = currentStep(now);
  let matched: number | null = null;
  for (const s of [step - 1, step, step + 1]) {
    const expected = Buffer.from(hotp(key, s));
    const given = Buffer.from(clean);
    // مقایسه‌ی زمان‌ثابت؛ حلقه عمداً زود خارج نمی‌شود
    if (crypto.timingSafeEqual(expected, given) && s > lastStep && matched === null) matched = s;
  }
  return matched;
}

/** آدرس otpauth:// برای QR و افزودن در اپ احراز هویت */
export function totpUri(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD}`;
}
