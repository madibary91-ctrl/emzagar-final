import zlib from "node:zlib";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { RedirectError } from "./setup";
import { resetRateLimit } from "@/lib/rate-limit";

type Env = { cookies: Map<string, string>; headers: Map<string, string> };
export const env = (globalThis as unknown as { __testEnv: Env }).__testEnv;

/** هر آزمون با مرورگر «تازه» شروع می‌شود (کوکی خالی، IP یکتا برای محدودیت نرخ) */
let ipCounter = 10;
export function freshBrowser() {
  env.cookies.clear();
  env.headers.set("x-forwarded-for", `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`);
}
export const setIp = (ip: string) => env.headers.set("x-forwarded-for", ip);
export { resetRateLimit };

/** اجرای Server Action و گرفتن مقصد redirect (اگر داشت) */
export async function run<T>(fn: () => Promise<T>): Promise<{ result?: T; redirect?: string }> {
  try {
    return { result: await fn() };
  } catch (e) {
    if (e instanceof RedirectError) return { redirect: e.url };
    throw e;
  }
}

export function form(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

let seq = 0;
export const uniq = (p = "u") => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

/** آخرین ایمیل ثبت‌شده در صندوق ارتباطات برای یک گیرنده */
export async function lastMail(to: string) {
  const [row] = await db.select().from(notifications).where(eq(notifications.recipient, to)).orderBy(desc(notifications.id)).limit(1);
  return row;
}
export async function lastSms(to: string) {
  return lastMail(to);
}

/** PNG معتبر (ایمپورت‌شدنی در تست) با حجم بیش از ۳۰۰ بایت برای عبور از اعتبارسنجی امضا */
export function makePng(): string {
  const w = 120;
  const h = 60;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = (x * 31 + y * 17 + ((x * y) % 251)) & 255;
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** ساخت کد ملی معتبر از ۹ رقم اول */
export function makeNationalCode(first9: string): string {
  const sum = first9.split("").reduce((a, d, i) => a + Number(d) * (10 - i), 0);
  const r = sum % 11;
  return first9 + String(r < 2 ? r : 11 - r);
}

