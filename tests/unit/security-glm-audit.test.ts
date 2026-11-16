/**
 * بازبینی یافته‌های تیم GLM — آزمون‌های رگرسیون (فایل جدید؛ آزمون‌های موجود دست‌نخورده‌اند).
 *  GLM-1 SSRF (IPv4-mapped/SIIT) · GLM-2 بمب ZIP در docx · GLM-4 اثر انگشت پیوست · GLM-7 سقف صفحه حین رندر ·
 *  GLM-8 سقف واقعی بدنه · تاریخ جلالی کبیسه · altChunk · مقایسه‌ی امن کلید رسید
 */
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { isPrivateIp } from "@/lib/ssrf";
import { BodyTooLargeError, readBodyLimited, readFormDataLimited } from "@/lib/bounded-body";
import { safeEqualStr } from "@/lib/safe-equal";
import { isJalaliLeap, jalaliMonthLength } from "@/lib/jalali";
import { validateFieldValue } from "@/modules/fields";
import { docFingerprint } from "@/modules/signing/fingerprint";
import { docxToHtml, inspectDocx, isDocxBuffer } from "@/modules/docs/docx";
import { DocError } from "@/modules/docs/service/core";
import { ingestUpload } from "@/modules/docs/service/ingest";
import { PdfPageLimitError, renderHtmlDocumentPdf } from "@/modules/pdf/render";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docXml = (inner: string) => `<?xml version="1.0"?><w:document ${W}><w:body>${inner}</w:body></w:document>`;
const para = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const makeDocx = (files: Record<string, string | Uint8Array>) => {
  const z: Record<string, Uint8Array> = { "[Content_Types].xml": strToU8("<Types/>") };
  for (const [k, v] of Object.entries(files)) z[k] = typeof v === "string" ? strToU8(v) : v;
  return Buffer.from(zipSync(z, { level: 9 }));
};

describe("GLM-1 — SSRF: IPv4-mapped / SIIT", () => {
  it.each([
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::FFFF:10.1.2.3", "0:0:0:0:0:ffff:169.254.169.254", "::ffff:a9fe:a9fe", "[::ffff:192.168.0.1]",
    "::ffff:0:127.0.0.1", "::ffff:0:7f00:1", "::ffff:0:8.8.8.8", "::ffff:0.0.0.0", "64:ff9b::7f00:1", "::1", "::", "fe80::1", "fd00::1", "garbage", "",
  ])("%s مسدود است", (ip) => expect(isPrivateIp(ip)).toBe(true));
  it.each(["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "::ffff:8.8.8.8", "::ffff:808:808"])("%s عمومی است", (ip) => expect(isPrivateIp(ip)).toBe(false));
});

describe("GLM-2 — بمب ZIP در docx (سقف روی بایت واقعی و تعداد ورودی)", () => {
  it("بخش XML غول‌پیکر (۱۰۰MB صفر) رد می‌شود و سریع است", () => {
    const bomb = makeDocx({ "word/document.xml": docXml(para("x")) + " ".repeat(100 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(1_000_000);
    const t = Date.now();
    expect(isDocxBuffer(bomb)).toBe(false);
    expect(() => docxToHtml(bomb)).toThrow();
    expect(Date.now() - t).toBeLessThan(3000);
  });
  it("مجموع بخش‌های سرصفحه/پاصفحه از سقف تجمعی ۴۰MB می‌گذرد ← رد", () => {
    const files: Record<string, string> = { "word/document.xml": docXml(para("متن")) };
    for (let i = 1; i <= 60; i++) files[`word/header${i}.xml`] = docXml("") + " ".repeat(1024 * 1024);
    const z = makeDocx(files);
    expect(() => inspectDocx(z)).toThrow();
  });
  it("هزاران ورودی بی‌ربط حافظه‌ی بازشده نمی‌گیرند (فقط فهرست خوانده می‌شود)", () => {
    const files: Record<string, string> = { "word/document.xml": docXml(para("سلام")) };
    for (let i = 0; i < 3000; i++) files[`junk/f${i}.bin`] = "x".repeat(100);
    const z = makeDocx(files);
    expect(isDocxBuffer(z)).toBe(true);
    expect(docxToHtml(z).html).toContain("سلام");
  });
  it("ingestUpload بمب را با DocError (نه خطای ۵۰۰) رد می‌کند", async () => {
    const bomb = makeDocx({ "word/document.xml": docXml(para("x")) + " ".repeat(60 * 1024 * 1024) });
    await expect(ingestUpload(bomb, "bomb.docx")).rejects.toBeInstanceOf(DocError);
  });
});

describe("altChunk در Word — حذف بی‌صدا ممنوع", () => {
  const alt = makeDocx({ "word/document.xml": docXml(`${para("بند ۱")}<w:altChunk xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId9"/>`) });
  it("inspectDocx و docxToHtml آن را گزارش می‌کنند", () => {
    expect(inspectDocx(alt).hasAltChunk).toBe(true);
    expect(docxToHtml(alt).skippedAltChunks).toBe(1);
  });
  it("ingestUpload سند را با کد docx_has_embedded_content رد می‌کند", async () => {
    await expect(ingestUpload(alt, "alt.docx")).rejects.toMatchObject({ code: "docx_has_embedded_content" });
  });
  it("Word معمولی altChunk ندارد", () => {
    expect(inspectDocx(makeDocx({ "word/document.xml": docXml(para("ساده")) })).hasAltChunk).toBe(false);
  });
});

describe("GLM-7 — سقف صفحه «حین رندر»", () => {
  it("سند پرحجم با رسیدن به سقف قطع می‌شود", async () => {
    const html = Array.from({ length: 4000 }, (_, i) => `<p>بند شماره ${i} از قرارداد آزمایشی با متن نسبتاً بلند برای پرکردن صفحه‌ها</p>`).join("");
    await expect(renderHtmlDocumentPdf({ html, title: "big", maxPages: 3 })).rejects.toBeInstanceOf(PdfPageLimitError);
  });
  it("سند کوچک زیر سقف عادی رندر می‌شود", async () => {
    const pdf = await renderHtmlDocumentPdf({ html: "<p>سلام</p>", title: "ok", maxPages: 3 });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("GLM-8 — بدنه با سقف واقعی بایت (حتی بدون Content-Length)", () => {
  const stream = (chunks: number, size: number) =>
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (chunks-- <= 0) return c.close();
        c.enqueue(new Uint8Array(size));
      },
    });
  it("بدنه‌ی chunked بزرگ‌تر از سقف قطع می‌شود", async () => {
    const req = new Request("http://x/", { method: "POST", body: stream(50, 100_000), headers: { "content-type": "multipart/form-data; boundary=x" }, duplex: "half" } as RequestInit);
    await expect(readBodyLimited(req, 1_000_000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
  it("Content-Length دروغگو/بزرگ پیش از خواندن رد می‌شود", async () => {
    const req = new Request("http://x/", { method: "POST", body: "a", headers: { "content-length": "99999999" } });
    await expect(readBodyLimited(req, 1000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
  it("فرم معمولی سالم خوانده می‌شود و نوع نامعتبر رد می‌شود", async () => {
    const fd = new FormData();
    fd.set("a", "1");
    fd.set("file", new File([new Uint8Array([1, 2, 3])], "f.bin"));
    const ok = await readFormDataLimited(new Request("http://x/", { method: "POST", body: fd }), 100_000);
    expect(ok.get("a")).toBe("1");
    await expect(readFormDataLimited(new Request("http://x/", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), 1000)).rejects.toThrow();
  });
});

describe("GLM-4 — پیوست‌ها در اثر انگشت سند", () => {
  const signers = [{ userId: 1, signedAt: new Date("2026-01-01T00:00:00Z"), ip: "1.1.1.1" }];
  it("بدون پیوست: هش قبلی دقیقاً حفظ می‌شود (سازگاری رو به عقب)", () => {
    expect(docFingerprint("<p>x</p>", signers, [], [])).toBe(docFingerprint("<p>x</p>", signers));
  });
  it("افزودن/تغییر/حذف پیوست هش را عوض می‌کند و ترتیب بی‌اثر است", () => {
    const base = docFingerprint("<p>x</p>", signers, [], ["aa", "bb"]);
    expect(base).toBe(docFingerprint("<p>x</p>", signers, [], ["bb", "aa"]));
    expect(base).not.toBe(docFingerprint("<p>x</p>", signers, [], ["aa"]));
    expect(base).not.toBe(docFingerprint("<p>x</p>", signers, [], ["aa", "bc"]));
    expect(base).not.toBe(docFingerprint("<p>x</p>", signers));
  });
});

describe("تاریخ جلالی — سال کبیسه", () => {
  it("سال‌های کبیسه‌ی رسمی", () => {
    for (const y of [1399, 1403, 1408, 1412]) expect(isJalaliLeap(y)).toBe(true);
    for (const y of [1400, 1401, 1402, 1404, 1405, 1406, 1407]) expect(isJalaliLeap(y)).toBe(false);
    expect(jalaliMonthLength(1405, 12)).toBe(29);
    expect(jalaliMonthLength(1403, 12)).toBe(30);
  });
  const f = { type: "date" as const, label: "تاریخ", required: true };
  it("حالت سخت‌گیر: ۳۰ اسفند فقط در سال کبیسه پذیرفته می‌شود", () => {
    process.env.STRICT_JALALI_DATES = "1";
    try {
      strictChecks();
    } finally {
      delete process.env.STRICT_JALALI_DATES;
    }
  });
  it("حالت پیش‌فرض با آزمون قدیمی fields.test.ts سازگار می‌ماند", () => {
    expect(validateFieldValue(f, "1405/12/30").ok).toBe(true);
    expect(validateFieldValue(f, "1405/13/01").ok).toBe(false);
  });
  const strictChecks = () => {
    expect(validateFieldValue(f, "1405/12/30").ok).toBe(false);
    expect(validateFieldValue(f, "1405/12/29").ok).toBe(true);
    expect(validateFieldValue(f, "1403/12/30")).toMatchObject({ ok: true, value: "1403/12/30" });
    expect(validateFieldValue(f, "1405/06/31").ok).toBe(true);
    expect(validateFieldValue(f, "1405/07/31").ok).toBe(false);
  };
});

describe("مقایسه‌ی امن کلید (صفحه‌ی رسید)", () => {
  it("کلید چندبایتی/آرایه/خیلی بلند پرتاب نمی‌کند و رد می‌شود", () => {
    const want = "a".repeat(32);
    expect(safeEqualStr(want, want)).toBe(true);
    expect(safeEqualStr("é".repeat(32), want)).toBe(false);
    expect(safeEqualStr(["a"], want)).toBe(false);
    expect(safeEqualStr(undefined, want)).toBe(false);
    expect(safeEqualStr("a".repeat(100000), want)).toBe(false);
  });
});
