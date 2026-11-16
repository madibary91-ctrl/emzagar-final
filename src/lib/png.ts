import zlib from "node:zlib";

/**
 * اعتبارسنجی «ساختاری» PNG پیش از رسیدن به رمزگشای تصویر (SEC-05).
 *
 * فقط بررسی امضای ۴/۸ بایت اول کافی نیست: فایلی با IDAT فشرده‌ی بسیار بزرگ (zip-bomb) یا ابعاد ساختگی
 * هنگام doc.image / رمزگشایی، حافظه‌ی زیادی می‌گیرد یا خطای کشنده می‌دهد و پروسه‌ی Node را از کار می‌اندازد.
 * این اعتبارسنج بدون رمزگشایی کامل تصویر:
 *  - امضای ۸ بایتی، ترتیب و طول تکه‌ها (IHDR اول، IDAT پشت‌سرهم، IEND آخر و بدون بایت اضافه) و CRC همه‌ی تکه‌ها را می‌سنجد
 *  - ابعاد/تعداد پیکسل را سقف‌گذاری می‌کند
 *  - IDAT را با سقف «دقیقاً به اندازه‌ی مورد انتظار» (maxOutputLength) باز می‌کند؛ پس بمب هرگز بیش از آن حافظه نمی‌گیرد،
 *    و طول بازشده باید دقیقاً با ابعاد/عمق رنگ بخواند و هر خط فیلتر معتبر (۰..۴) داشته باشد
 */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const PNG_LIMITS = {
  maxBytes: 700 * 1024,
  maxSide: 4096,
  maxPixels: 4_000_000,
  /** سقف بایت‌های بازشده (خام) — فراتر از این هرگز تخصیص داده نمی‌شود */
  maxRawBytes: 32 * 1024 * 1024,
  maxChunks: 256,
} as const;

export type PngInfo = { width: number; height: number; bitDepth: number; colorType: number; rawBytes: number };
export type PngCheck = ({ ok: true } & PngInfo) | { ok: false; reason: string };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** کانال‌های هر رنگ‌نوع + عمق‌های مجاز طبق مشخصات PNG */
const CHANNELS: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

const fail = (reason: string): PngCheck => ({ ok: false, reason });

export function inspectPng(buf: Buffer, limits: Partial<typeof PNG_LIMITS> = {}): PngCheck {
  const L = { ...PNG_LIMITS, ...limits };
  if (!Buffer.isBuffer(buf) || buf.length < 8 + 25 + 12 + 12) return fail("فایل بیش از حد کوچک است");
  if (buf.length > L.maxBytes) return fail("حجم فایل بیش از حد مجاز است");
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return fail("امضای PNG نامعتبر است");

  let pos = 8;
  let chunks = 0;
  let info: PngInfo | null = null;
  let sawPlte = false;
  let sawIdat = false;
  let idatClosed = false;
  let sawIend = false;
  const idat: Buffer[] = [];
  let idatBytes = 0;

  while (pos < buf.length) {
    if (sawIend) return fail("داده‌ی اضافه بعد از IEND");
    if (++chunks > L.maxChunks) return fail("تعداد تکه‌ها بیش از حد است");
    if (pos + 12 > buf.length) return fail("تکه‌ی ناقص");
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return fail("نوع تکه نامعتبر است");
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (len > 0x7fffffff || dataEnd + 4 > buf.length) return fail("طول تکه نامعتبر است");
    if (crc32(buf, pos + 4, dataEnd) !== buf.readUInt32BE(dataEnd)) return fail("CRC نامعتبر است");

    if (chunks === 1) {
      if (type !== "IHDR" || len !== 13) return fail("IHDR نامعتبر است");
      const width = buf.readUInt32BE(dataStart);
      const height = buf.readUInt32BE(dataStart + 4);
      const bitDepth = buf[dataStart + 8];
      const colorType = buf[dataStart + 9];
      const compression = buf[dataStart + 10];
      const filter = buf[dataStart + 11];
      const interlace = buf[dataStart + 12];
      if (!width || !height || width > L.maxSide || height > L.maxSide || width * height > L.maxPixels) return fail("ابعاد تصویر بیش از حد مجاز است");
      const spec = CHANNELS[colorType];
      if (!spec || !spec.depths.includes(bitDepth)) return fail("نوع رنگ یا عمق بیت نامعتبر است");
      if (compression !== 0 || filter !== 0) return fail("روش فشرده‌سازی/فیلتر نامعتبر است");
      // تصویر درهم‌تنیده (Adam7) را رمزگشای PDF پشتیبانی نمی‌کند و امضا هم هرگز درهم‌تنیده نیست
      if (interlace !== 0) return fail("PNG درهم‌تنیده پذیرفته نمی‌شود");
      const rowBytes = Math.ceil((width * spec.channels * bitDepth) / 8);
      const rawBytes = height * (rowBytes + 1);
      if (rawBytes > L.maxRawBytes) return fail("اندازه‌ی بازشده‌ی تصویر بیش از حد مجاز است");
      info = { width, height, bitDepth, colorType, rawBytes };
    } else if (type === "IHDR") {
      return fail("IHDR تکراری");
    } else if (type === "IDAT") {
      if (idatClosed) return fail("IDATها پشت‌سرهم نیستند");
      if (info?.colorType === 3 && !sawPlte) return fail("پالت (PLTE) وجود ندارد");
      sawIdat = true;
      idatBytes += len;
      if (idatBytes > L.maxBytes) return fail("داده‌ی فشرده بیش از حد است");
      idat.push(buf.subarray(dataStart, dataEnd));
    } else {
      if (sawIdat) idatClosed = true;
      if (type === "PLTE") {
        if (sawIdat || sawPlte || len === 0 || len % 3 !== 0 || len > 768) return fail("PLTE نامعتبر است");
        if (info && (info.colorType === 0 || info.colorType === 4)) return fail("PLTE برای این نوع رنگ مجاز نیست");
        sawPlte = true;
      } else if (type === "IEND") {
        if (len !== 0 || !sawIdat) return fail("IEND نامعتبر است");
        sawIend = true;
      } else if (type.charCodeAt(0) < 0x61) {
        // تکه‌ی «حیاتی» ناشناخته (حرف اول بزرگ) طبق مشخصات یعنی تصویر قابل رمزگشایی نیست
        return fail("تکه‌ی حیاتی ناشناخته");
      }
    }
    pos = dataEnd + 4;
  }
  if (!info || !sawIend) return fail("ساختار PNG کامل نیست");

  // بازکردن IDAT با سقفِ دقیق: بمب فشرده‌سازی هرگز بیش از rawBytes حافظه نمی‌گیرد
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat, idatBytes), { maxOutputLength: info.rawBytes });
  } catch {
    return fail("داده‌ی تصویر خراب است یا بیش از حد بزرگ بازمی‌شود");
  }
  if (raw.length !== info.rawBytes) return fail("اندازه‌ی داده‌ی تصویر با ابعاد نمی‌خواند");
  const rowLen = info.rawBytes / info.height;
  for (let y = 0; y < info.height; y++) if (raw[y * rowLen] > 4) return fail("فیلتر خط نامعتبر است");
  return { ok: true, ...info };
}

export const isValidPng = (buf: Buffer): boolean => inspectPng(buf).ok;
