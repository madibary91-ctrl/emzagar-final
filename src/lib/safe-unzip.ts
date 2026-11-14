import zlib from "node:zlib";

/**
 * M-02 — بازکردن امن ZIP (ضد Zip-bomb / حمله‌ی CPU و Event-loop).
 *
 * ریشه‌ی مشکل: سقف‌ها بر پایه‌ی `originalSize` «اعلام‌شده» در هدر ZIP بود که مهاجم هرچه بخواهد می‌نویسد؛ `unzipSync` (fflate)
 * همه‌ی داده را اینفلیت می‌کرد و فقط «بعد از» آن بریده می‌شد (۱۵–۲۰ ثانیه قفل کامل event loop برای یک آپلود ۵ مگابایتی).
 *
 * راه‌حل: خواننده‌ی مستقیم Central Directory + اینفلیت با `zlib.inflateRawSync(…, { maxOutputLength })`:
 *  • سقف روی «بایت‌های واقعی خروجی» اعمال می‌شود؛ zlib به‌محض رسیدن به سقف متوقف می‌شود و خطا می‌دهد
 *    (CPU و حافظه = O(سقف)، نه O(داده‌ی مهاجم))؛
 *  • فقط ورودی‌های «خواسته‌شده» (filter) اینفلیت می‌شوند؛ بقیه حتی لمس نمی‌شوند؛
 *  • سقف اینفلیت هر ورودی = min(سقف فایل، اندازه‌ی اعلام‌شده + ۱): اگر هدر دروغ بگوید، کار زیر چند کیلوبایت قطع می‌شود؛
 *  • بودجه‌ی «کل» برای مجموع خروجی همه‌ی فایل‌ها؛ سقف تعداد ورودی؛ رد ZIP64، رمزگذاری‌شده و روش‌های ناشناخته؛
 *  • اندازه‌ی اعلام‌شده با اندازه‌ی واقعی تطبیق داده می‌شود (ناهمخوان = فایل مخرب/آسیب‌دیده)؛
 *  • مسیرهای مشکوک (.. ، مطلق، NUL) رد می‌شوند.
 * خروجی همچنان همگام است (امضای توابع فراخوان‌ها عوض نمی‌شود) ولی زمان آن اکنون «محدود و قابل‌پیش‌بینی» است.
 * نسخه‌ی ناهمگام `safeUnzip` اینفلیت را در thread pool انجام می‌دهد (برای مسیرهای جدید که event loop را آزاد می‌خواهند).
 */
export class UnzipError extends Error {
  constructor(
    message: string,
    public code: "invalid" | "too_large" | "too_many" | "unsupported" = "invalid",
  ) {
    super(message);
    this.name = "UnzipError";
  }
}

export interface UnzipEntryInfo {
  name: string;
  /** اندازه‌ی «اعلام‌شده» (فقط برای تصمیم‌های اولیه؛ هرگز مرز امنیتی نیست) */
  declaredSize: number;
  compressedSize: number;
}

export interface SafeUnzipOptions {
  /** فقط ورودی‌هایی که true بدهند اینفلیت می‌شوند */
  filter: (e: UnzipEntryInfo) => boolean;
  /** سقف «واقعی» هر فایل (بایت) */
  maxFileBytes: number;
  /** سقف «واقعی» مجموع خروجی (بایت) */
  maxTotalBytes: number;
  /** برای ورودی‌هایی که filter ردشان کرده (مثلاً فقط شمارش تصاویر بدون اینفلیت) */
  onSkip?: (e: UnzipEntryInfo) => void;
  /** سقف تعداد ورودی‌های فهرست (پیش‌فرض ۵۰۰۰۰ برای OOXML؛ مهاجم با میلیون‌ها ورودی نمی‌تواند فهرست را باد کند) */
  maxEntries?: number;
}

type Raw = { name: string; method: number; flags: number; csize: number; usize: number; localOffset: number };

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function listEntries(buf: Uint8Array, maxEntries: number): Raw[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 22) throw new UnzipError("ZIP نامعتبر است");
  let eocd = -1;
  for (let i = buf.length - 22, min = Math.max(0, buf.length - 22 - 65535); i >= min; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UnzipError("ZIP نامعتبر است");
  const total = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new UnzipError("ZIP64 پشتیبانی نمی‌شود", "unsupported");
  if (total > maxEntries) throw new UnzipError("تعداد ورودی‌های ZIP بیش از حد است", "too_many");
  if (cdOff + cdSize > buf.length) throw new UnzipError("ZIP آسیب‌دیده است");
  const out: Raw[] = [];
  let p = cdOff;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== CEN_SIG) throw new UnzipError("ZIP آسیب‌دیده است");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    if (p + 46 + nameLen > buf.length) throw new UnzipError("ZIP آسیب‌دیده است");
    // نام: UTF-8 اگر بیت 11 روشن باشد، وگرنه latin1 (برای تطبیق نام‌های ثابت OOXML فرقی ندارد)
    const raw = buf.subarray(p + 46, p + 46 + nameLen);
    const name = flags & 0x800 ? Buffer.from(raw).toString("utf8") : Buffer.from(raw).toString("latin1");
    out.push({ name, method, flags, csize, usize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const suspicious = (name: string) => name.includes("\0") || name.startsWith("/") || name.split(/[\\/]/).includes("..");

/** داده‌ی فشرده‌ی یک ورودی (بدون اینفلیت) + بررسی‌های ساختاری */
function rawData(buf: Uint8Array, e: Raw): Uint8Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (e.flags & 0x1) throw new UnzipError("ZIP رمزگذاری‌شده پشتیبانی نمی‌شود", "unsupported");
  if (e.csize === 0xffffffff || e.usize === 0xffffffff) throw new UnzipError("ZIP64 پشتیبانی نمی‌شود", "unsupported");
  const o = e.localOffset;
  if (o + 30 > buf.length || dv.getUint32(o, true) !== LOC_SIG) throw new UnzipError("ZIP آسیب‌دیده است");
  const start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
  if (start + e.csize > buf.length) throw new UnzipError("ZIP آسیب‌دیده است");
  return buf.subarray(start, start + e.csize);
}

function selected(buf: Uint8Array, opts: SafeUnzipOptions): { e: Raw; data: Uint8Array }[] {
  const picks: { e: Raw; data: Uint8Array }[] = [];
  let declaredTotal = 0;
  for (const e of listEntries(buf, opts.maxEntries ?? 50_000)) {
    if (suspicious(e.name)) continue;
    const info = { name: e.name, declaredSize: e.usize, compressedSize: e.csize };
    if (!opts.filter(info)) {
      opts.onSkip?.(info);
      continue;
    }
    if (e.method !== 0 && e.method !== 8) throw new UnzipError("روش فشرده‌سازی ZIP پشتیبانی نمی‌شود", "unsupported");
    // رد زودهنگام: اندازه‌ی «اعلام‌شده» بزرگ‌تر از سقف حتی اگر راست باشد قبول نیست (ارزان؛ مرز واقعی در اینفلیت است)
    declaredTotal += e.usize;
    if (e.usize > opts.maxFileBytes || declaredTotal > opts.maxTotalBytes) throw new UnzipError("فایل داخل ZIP بیش از حد بزرگ است", "too_large");
    picks.push({ e, data: rawData(buf, e) });
  }
  return picks;
}

const tooLarge = () => new UnzipError("فایل داخل ZIP بیش از حد بزرگ است", "too_large");

function finishEntry(e: Raw, out: Uint8Array): Uint8Array {
  // اعلام‌شده باید با واقعی برابر باشد؛ ناهمخوانی = ZIP دست‌کاری‌شده (نشانه‌ی بمب فشرده‌سازی)
  if (out.length !== e.usize) throw new UnzipError("اندازه‌ی اعلام‌شده‌ی ZIP با محتوای واقعی نمی‌خواند");
  return out;
}

/** اینفلیت همگام با سقف «واقعی» خروجی (zlib در سقف متوقف می‌شود) */
export function safeUnzipSync(buf: Uint8Array, opts: SafeUnzipOptions): Record<string, Uint8Array> {
  const result: Record<string, Uint8Array> = {};
  let remaining = opts.maxTotalBytes;
  for (const { e, data } of selected(buf, opts)) {
    const cap = Math.min(opts.maxFileBytes, remaining);
    let out: Uint8Array;
    if (e.method === 0) {
      if (data.length > cap) throw tooLarge();
      out = data;
    } else {
      try {
        out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(cap, e.usize + 1)) });
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || /larger than|maxOutputLength/i.test(String((err as Error).message))) throw tooLarge();
        throw new UnzipError("ZIP آسیب‌دیده است");
      }
    }
    result[e.name] = finishEntry(e, out);
    remaining -= out.length;
  }
  return result;
}

/** نسخه‌ی ناهمگام: اینفلیت در thread pool انجام می‌شود و event loop را اشغال نمی‌کند */
export async function safeUnzip(buf: Uint8Array, opts: SafeUnzipOptions): Promise<Record<string, Uint8Array>> {
  const result: Record<string, Uint8Array> = {};
  let remaining = opts.maxTotalBytes;
  for (const { e, data } of selected(buf, opts)) {
    const cap = Math.min(opts.maxFileBytes, remaining);
    let out: Uint8Array;
    if (e.method === 0) {
      if (data.length > cap) throw tooLarge();
      out = data;
    } else {
      out = await new Promise<Uint8Array>((resolve, reject) => {
        zlib.inflateRaw(data, { maxOutputLength: Math.max(1, Math.min(cap, e.usize + 1)) }, (err, res) => {
          if (!err) return resolve(res);
          if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || /larger than|maxOutputLength/i.test(err.message)) return reject(tooLarge());
          reject(new UnzipError("ZIP آسیب‌دیده است"));
        });
      });
    }
    result[e.name] = finishEntry(e, out);
    remaining -= out.length;
  }
  return result;
}
