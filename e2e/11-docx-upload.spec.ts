/**
 * مسیر آپلود Word (docx) — همان‌جا که بمب ZIP (GLM-2) و دور زدن سقف‌ها (GLM-7/8) پیدا شد.
 * این آزمون روی سرور تولیدی واقعی و با نشست مدیر اجرا می‌شود و بعد از هر حمله «زنده‌ماندن سرور» را هم می‌سنجد.
 */
import { strToU8, zipSync } from "fflate";
import { AUTH, expect, newContext, test } from "./lib/kit";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docXml = (inner: string) => `<?xml version="1.0"?><w:document ${W}><w:body>${inner}</w:body></w:document>`;
const para = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const docx = (files: Record<string, string>) => {
  const z: Record<string, Uint8Array> = { "[Content_Types].xml": strToU8("<Types/>") };
  for (const [k, v] of Object.entries(files)) z[k] = strToU8(v);
  return Buffer.from(zipSync(z, { level: 9 }));
};
const MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

test.describe.configure({ mode: "serial" });

test("[D1] docx سالم پذیرفته و به PDF قابل‌امضا تبدیل می‌شود", async ({ browser }) => {
  const ctx = await newContext(browser, { auth: AUTH.admin });
  const res = await ctx.request.post("/api/docs/upload?mode=team", {
    multipart: { file: { name: "ok.docx", mimeType: MIME, buffer: docx({ "word/document.xml": docXml(para("ماده ۱ — قرارداد آزمایشی")) }) } },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.kind).toBe("docx");
  expect(body.pageCount).toBeGreaterThanOrEqual(1);
  await ctx.close();
});

test("[D2] بمب ZIP رد می‌شود (۴۲۲، نه ۵۰۰) و سرور زنده می‌ماند", async ({ browser }) => {
  const ctx = await newContext(browser, { auth: AUTH.admin });
  const t = Date.now();
  const bomb = docx({ "word/document.xml": docXml(para("x")) + " ".repeat(150 * 1024 * 1024) });
  expect(bomb.length).toBeLessThan(2 * 1024 * 1024); // فشرده‌ی کوچک، بازشده‌ی غول‌پیکر
  const res = await ctx.request.post("/api/docs/upload?mode=team", { multipart: { file: { name: "bomb.docx", mimeType: MIME, buffer: bomb } } });
  expect(res.status()).toBe(422);
  expect(Date.now() - t).toBeLessThan(15_000);
  const many: Record<string, string> = { "word/document.xml": docXml(para("متن")) };
  for (let i = 1; i <= 60; i++) many[`word/header${i}.xml`] = docXml("") + " ".repeat(1024 * 1024);
  const res2 = await ctx.request.post("/api/docs/upload?mode=team", { multipart: { file: { name: "many.docx", mimeType: MIME, buffer: docx(many) } } });
  expect(res2.status()).toBe(422);
  expect((await ctx.request.get("/api/health")).status()).toBe(200);
  await ctx.close();
});

test("[D3] altChunk (محتوای جاسازی‌شده) به‌جای حذف بی‌صدا رد می‌شود", async ({ browser }) => {
  const ctx = await newContext(browser, { auth: AUTH.admin });
  const alt = docx({ "word/document.xml": docXml(`${para("بند ۱")}<w:altChunk xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId9"/>`) });
  const res = await ctx.request.post("/api/docs/upload?mode=team", { multipart: { file: { name: "alt.docx", mimeType: MIME, buffer: alt } } });
  expect(res.status()).toBe(422);
  expect((await res.json()).code).toBe("docx_has_embedded_content");
  await ctx.close();
});

test("[D4] بدنه‌ی بزرگ‌تر از سقف پیش از پردازش رد می‌شود و ورود نکرده ۴۰۱ می‌گیرد", async ({ browser }) => {
  const ctx = await newContext(browser, { auth: AUTH.admin });
  const huge = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(20 * 1024 * 1024)]);
  const res = await ctx.request.post("/api/docs/upload?mode=team", { multipart: { file: { name: "huge.docx", mimeType: MIME, buffer: huge } } });
  expect(res.status()).toBe(413);
  await ctx.close();

  const anon = await newContext(browser, {});
  const noAuth = await anon.request.post("/api/docs/upload?mode=team", { multipart: { file: { name: "a.docx", mimeType: MIME, buffer: docx({ "word/document.xml": docXml(para("x")) }) } } });
  expect(noAuth.status()).toBe(401);
  await anon.close();
});
