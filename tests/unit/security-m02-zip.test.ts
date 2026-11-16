import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { safeUnzip, safeUnzipSync, UnzipError } from "@/lib/safe-unzip";
import { parseXlsxBuffer, SheetError } from "@/lib/spreadsheet";
import { docxToHtml, inspectDocx, isDocxBuffer } from "@/modules/docs/docx";
import { extractText } from "@/modules/ai/knowledge/text/extract";

/** ZIP دستی با «اندازه‌ی اعلام‌شده»ی دلخواه (برای ساخت بمب فشرده‌سازی که هدرش دروغ می‌گوید) */
function craftZip(entries: { name: string; compressed: Buffer; method?: number; declared: number }[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.method ?? 8, 8);
    lh.writeUInt32LE(e.compressed.length, 18);
    lh.writeUInt32LE(e.declared, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, e.compressed);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.method ?? 8, 10);
    ch.writeUInt32LE(e.compressed.length, 20);
    ch.writeUInt32LE(e.declared, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + e.compressed.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, eocd]));
}

// بمب: ~۱۲۰ مگابایت صفر که به ~۱۲۰ کیلوبایت فشرده می‌شود؛ هدر می‌گوید «۱۰۰ بایت»
const BOMB_RAW = 120 * 1024 * 1024;
const bombData = zlib.deflateRawSync(Buffer.alloc(BOMB_RAW), { level: 9 });
const lyingBomb = (name: string) => craftZip([{ name, compressed: bombData, declared: 100 }]);

describe("M-02: بمب فشرده‌سازی با هدر دروغگو", () => {
  it("بمب فشرده‌شده کوچک است ولی واقعاً بزرگ", () => {
    expect(bombData.length).toBeLessThan(400 * 1024);
  });
  it("safeUnzipSync سریع و بدون اینفلیت کامل رد می‌کند (CPU محدود)", () => {
    const zip = lyingBomb("word/document.xml");
    const t0 = performance.now();
    expect(() => safeUnzipSync(zip, { filter: () => true, maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 40 * 1024 * 1024 })).toThrow(UnzipError);
    // اینفلیت کامل ۱۲۰ مگابایت صدها میلی‌ثانیه CPU می‌برد؛ اینجا کار به «اندازه‌ی اعلام‌شده + ۱» محدود است
    expect(performance.now() - t0).toBeLessThan(250);
  });
  it("حتی وقتی اعلام‌شده = سقف باشد، سقف «واقعی» اعمال می‌شود", () => {
    const zip = craftZip([{ name: "a.xml", compressed: bombData, declared: 1024 * 1024 }]);
    const t0 = performance.now();
    expect(() => safeUnzipSync(zip, { filter: () => true, maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 })).toThrow(UnzipError);
    expect(performance.now() - t0).toBeLessThan(250);
  });
  it("نسخه‌ی ناهمگام هم رد می‌کند", async () => {
    await expect(safeUnzip(lyingBomb("a.xml"), { filter: () => true, maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 40 * 1024 * 1024 })).rejects.toBeInstanceOf(UnzipError);
  });
  it("فایل واقعاً بزرگ‌تر از سقف (اعلام‌شده راست) → too_large", () => {
    const raw = Buffer.alloc(3 * 1024 * 1024, 7);
    const zip = craftZip([{ name: "a.xml", compressed: zlib.deflateRawSync(raw), declared: raw.length }]);
    try {
      safeUnzipSync(zip, { filter: () => true, maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 });
      throw new Error("باید خطا می‌داد");
    } catch (e) {
      expect(e).toBeInstanceOf(UnzipError);
      expect((e as UnzipError).code).toBe("too_large");
    }
  });
  it("ناهمخوانی اندازه‌ی اعلام‌شده و واقعی (کمتر) رد می‌شود", () => {
    const raw = Buffer.from("hello world");
    const zip = craftZip([{ name: "a.xml", compressed: zlib.deflateRawSync(raw), declared: 3 }]);
    expect(() => safeUnzipSync(zip, { filter: () => true, maxFileBytes: 1000, maxTotalBytes: 1000 })).toThrow(UnzipError);
  });
});

describe("M-02: مسیرهای مصرف‌کننده", () => {
  it("parseXlsxBuffer: بمب → SheetError سریع", () => {
    const t0 = performance.now();
    expect(() => parseXlsxBuffer(lyingBomb("xl/worksheets/sheet1.xml"))).toThrow(SheetError);
    expect(performance.now() - t0).toBeLessThan(250);
  });
  it("isDocxBuffer/docxToHtml/inspectDocx/extractText بمب را نمی‌پذیرند و event loop را قفل نمی‌کنند", () => {
    const docx = Buffer.concat([Buffer.from("504b0304", "hex"), Buffer.from(lyingBomb("word/document.xml"))]);
    const bomb = Buffer.from(lyingBomb("word/document.xml"));
    const t0 = performance.now();
    expect(isDocxBuffer(bomb)).toBe(false);
    expect(() => docxToHtml(bomb)).toThrow();
    expect(() => inspectDocx(bomb)).toThrow();
    expect(extractText(bomb, "x.docx").ok).toBe(false);
    void docx;
    expect(performance.now() - t0).toBeLessThan(600);
  });
  it("فایل‌های سالم همچنان کار می‌کنند (xlsx ساده و docx ساده)", () => {
    const sheet = `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>سلام</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>`;
    const xlsx = zipSync({ "xl/worksheets/sheet1.xml": strToU8(sheet) });
    expect(parseXlsxBuffer(xlsx)).toEqual([["سلام", "42"]]);

    const doc = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>متن آزمون</w:t></w:r></w:p></w:body></w:document>`;
    const docx = Buffer.from(zipSync({ "word/document.xml": strToU8(doc), "word/media/image1.png": new Uint8Array([1, 2, 3]) }));
    expect(isDocxBuffer(docx)).toBe(true);
    const ex = extractText(docx, "x.docx");
    expect(ex.ok && ex.text).toContain("متن آزمون");
    expect(docxToHtml(docx).html).toContain("متن آزمون");
    expect(inspectDocx(docx)).toMatchObject({ mediaFiles: 1, hasVisuals: true }); // شمارش تصویر بدون اینفلیت
  });
});

describe("M-02: سخت‌سازی ساختاری", () => {
  it("ورودی‌های با مسیر مشکوک نادیده گرفته می‌شوند", () => {
    const ok = zlib.deflateRawSync(Buffer.from("x"));
    const zip = craftZip([
      { name: "../evil.xml", compressed: ok, declared: 1 },
      { name: "/abs.xml", compressed: ok, declared: 1 },
      { name: "good.xml", compressed: ok, declared: 1 },
    ]);
    expect(Object.keys(safeUnzipSync(zip, { filter: () => true, maxFileBytes: 10, maxTotalBytes: 10 }))).toEqual(["good.xml"]);
  });
  it("تعداد ورودی بیش از سقف → too_many؛ ZIP خراب → invalid", () => {
    const many = zipSync(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.xml`, strToU8("x")])));
    expect(() => safeUnzipSync(many, { filter: () => true, maxFileBytes: 10, maxTotalBytes: 1000, maxEntries: 10 })).toThrow(/ورودی/);
    expect(() => safeUnzipSync(new Uint8Array([1, 2, 3, 4]), { filter: () => true, maxFileBytes: 10, maxTotalBytes: 10 })).toThrow(UnzipError);
  });
  it("ورودی رمزگذاری‌شده یا روش ناشناخته پذیرفته نمی‌شود", () => {
    const zip = craftZip([{ name: "a.xml", compressed: Buffer.from("zz"), method: 99, declared: 2 }]);
    expect(() => safeUnzipSync(zip, { filter: () => true, maxFileBytes: 10, maxTotalBytes: 10 })).toThrow(UnzipError);
  });
});
