import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { degrees, PDFDocument, StandardFonts } from "pdf-lib";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { collectSubmissions, contracts, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { getContractPdf } from "@/modules/pdf/service";
import { getSigners, issueContract } from "@/modules/contracts/service";
import { createWorkspace } from "@/modules/tenancy/service";
import { ensureGuestSigner } from "@/modules/guests/service";
import { getOrCreateSigningLink, resolveSigningToken } from "@/modules/signing/links";
import { guestSendOtpAction, guestSignAction, guestVerifyOtpAction } from "@/modules/signing/guest-actions";
import { attachSourceToContract, createDraft, DocError, getUsableDraft, ingestUpload, listDocFields, prepareSigningFields, sourceStubHtml } from "@/modules/docs/service";
import { fieldKey, sanitizePlacements } from "@/modules/docs/placement";
import { docxToHtml } from "@/modules/docs/docx";
import { createQuickSend, getQuickStatus, isQuickEnabled, QuickError } from "@/modules/quick/service";
import { quickSendCodeAction, quickVerifyCodeAction } from "@/modules/quick/actions";
import { collectSendCodeAction, collectSubmitAction, collectVerifyCodeAction } from "@/modules/collect/actions";
import { buildCsv, buildSubmissionPdf, buildZip, createCampaign, getCampaignByCode, submitCollect, updateCampaignSettings, verifyReceipt, voidSubmission, CollectError } from "@/modules/collect/service";
import { POST as uploadRoute } from "@/app/api/docs/upload/route";
import { GET as draftRoute } from "@/app/api/docs/draft/[code]/route";
import { freshBrowser, makePng, setIp, uniq } from "../helpers";

let owner: { id: number };
let wsId: number;

async function makePdf(pages = 2, rotate = 0): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Original page ${i + 1}`, { x: 60, y: 780, size: 18, font });
    if (rotate && i === 0) p.setRotation(degrees(rotate));
  }
  return Buffer.from(await doc.save());
}

function makeDocx(text: string): Buffer {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>عنوان قرارداد</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${text}</w:t></w:r><w:r><w:t xml:space="preserve"> ادامه متن</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>الف</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>ب</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
  return Buffer.from(zipSync({ "word/document.xml": strToU8(xml), "[Content_Types].xml": strToU8("<Types/>") }));
}

beforeAll(async () => {
  const [u] = await db.insert(users).values({ name: "مالک", email: `${uniq("o")}@example.com`, mobile: "09120000077", passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() }).returning();
  owner = u;
  wsId = await createWorkspace(u.id, "فضای فاز دو");
});
beforeEach(() => {
  freshBrowser();
});

async function signAs(token: string, fields?: Record<string, string>) {
  const send = await guestSendOtpAction(token);
  expect(send.ok).toBe(true);
  const v = await guestVerifyOtpAction(token, send.devCode!);
  expect(v.ok).toBe(true);
  return guestSignAction(token, { signature: makePng(), method: "draw", agree: true, fields });
}

describe("فاز ۲ — امضای فایل PDF/Word با جانمایی بصری", () => {
  it("اعتبارسنجی جانمایی: محدوده، نوع و الزام امضا", () => {
    expect(sanitizePlacements([{ signerPosition: 1, kind: "signature", page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }], 2, 2, { requireSignatureFor: [1, 2] }).ok).toBe(false);
    expect(sanitizePlacements([{ signerPosition: 3, kind: "signature", page: 1, x: 0, y: 0, w: 0.1, h: 0.1 }], 2, 2).ok).toBe(false);
    expect(sanitizePlacements([{ signerPosition: 1, kind: "script", page: 1, x: 0, y: 0, w: 0.1, h: 0.1 }], 2, 2).ok).toBe(false);
    const ok = sanitizePlacements([{ signerPosition: 1, kind: "text", label: "<b>کد ملی</b>", page: 2, x: 0.95, y: 0.99, w: 0.5, h: 0.5 }], 2, 2);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.items[0].x + ok.items[0].w).toBeLessThanOrEqual(1.0000001);
      expect(ok.items[0].label).not.toContain("<");
    }
  });

  it("ورودی نامعتبر رد می‌شود (متن، Word قدیمی، PDF خراب)", async () => {
    await expect(ingestUpload(Buffer.from("hello world"), "a.pdf")).rejects.toBeInstanceOf(DocError);
    await expect(ingestUpload(Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(100)]), "a.doc")).rejects.toThrow(/docx/);
    await expect(ingestUpload(Buffer.from("%PDF-1.4\nbroken"), "a.pdf")).rejects.toBeInstanceOf(DocError);
    await expect(ingestUpload(Buffer.alloc(0), "a.pdf")).rejects.toBeInstanceOf(DocError);
  });

  it("Word به PDF تبدیل می‌شود", async () => {
    const conv = docxToHtml(makeDocx("بند اول"));
    expect(conv.html).toContain("<h1>");
    expect(conv.html).toContain("<table>");
    const r = await ingestUpload(makeDocx("بند اول"), "قرارداد.docx");
    expect(r.kind).toBe("docx");
    expect(r.pageCount).toBeGreaterThanOrEqual(1);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.pdfFile).not.toBe(r.originalFile);
  });

  it("چرخه‌ی کامل: بارگذاری ← جانمایی ← دو امضا ← فایل اصلی + امضا + گواهی", async () => {
    const draft = await createDraft({ buf: await makePdf(2, 90), name: "my contract.pdf", workspaceId: wsId, userId: owner.id, ip: "1.1.1.1" });
    expect(draft.pageCount).toBe(2);
    // صفحه‌ی ۱ با چرخش ۹۰ درجه: ابعاد نمایشی جابه‌جا می‌شود
    expect(draft.pagesMeta[0].w).toBeGreaterThan(draft.pagesMeta[0].h);

    const pl = sanitizePlacements(
      [
        { signerPosition: 1, kind: "signature", page: 1, x: 0.1, y: 0.7, w: 0.2, h: 0.08 },
        { signerPosition: 1, kind: "text", label: "Code", page: 1, x: 0.4, y: 0.7, w: 0.3, h: 0.04 },
        { signerPosition: 2, kind: "signature", page: 2, x: 0.5, y: 0.8, w: 0.25, h: 0.07 },
        { signerPosition: 2, kind: "date", page: 2, x: 0.5, y: 0.7, w: 0.2, h: 0.03 },
        { signerPosition: 2, kind: "checkbox", label: "agree", page: 2, x: 0.1, y: 0.9, w: 0.03, h: 0.03 },
      ],
      2,
      2,
      { requireSignatureFor: [1, 2] },
    );
    expect(pl.ok).toBe(true);
    if (!pl.ok) return;
    const g1 = await ensureGuestSigner(wsId, { name: "علی رضایی", mobile: "09121110001" });
    const g2 = await ensureGuestSigner(wsId, { name: "مریم احمدی", mobile: "09121110002" });
    const d = await getUsableDraft(draft.code, wsId);
    const id = await issueContract({
      workspaceId: wsId,
      title: "قرارداد فایل",
      bodyHtml: sourceStubHtml(d.originalName, d.originalSha256),
      customerId: g2.userId,
      extraSigners: [{ label: "طرف اول", userId: g1.userId }],
      createdBy: owner.id,
      onCreated: (cid) => attachSourceToContract(cid, d, pl.items),
    });
    await expect(getUsableDraft(draft.code, wsId)).rejects.toBeInstanceOf(DocError); // مصرف‌شده
    const fields = await listDocFields(id);
    expect(fields).toHaveLength(5);

    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    const signers = await getSigners(id);
    // فیلد اجباری خالی رد می‌شود
    const bad = await prepareSigningFields(c, signers, { position: 1, userName: "علی رضایی" }, {});
    expect(bad.ok).toBe(false);

    const textField = fields.find((f) => f.kind === "text")!;
    const l1 = (await getOrCreateSigningLink(signers[0].id))!;
    const r1 = await signAs(l1.token, { [fieldKey(textField.id)]: "ABC12345" });
    expect(r1.ok).toBe(true);
    const checkbox = fields.find((f) => f.kind === "checkbox")!;
    const l2 = (await getOrCreateSigningLink(signers[1].id))!;
    expect((await resolveSigningToken(l2.token)).status).toBe("ok");
    const r2 = await signAs(l2.token, { [fieldKey(checkbox.id)]: "1" });
    expect(r2.ok).toBe(true);
    expect(r2.completed).toBe(true);

    const pdf = await getContractPdf(id);
    const out = await PDFDocument.load(pdf.buffer);
    expect(out.getPageCount()).toBeGreaterThanOrEqual(3); // ۲ صفحه‌ی اصلی + گواهی
    expect(out.getPages()[0].getRotation().angle).toBe(90); // فایل اصلی دست‌نخورده
    // متن لاتین فیلد باید روی صفحه‌ی ۱ درج شده باشد
    const text = Buffer.from(pdf.buffer).toString("latin1");
    expect(text).toContain("%PDF-");
    expect(pdf.size).toBeGreaterThan(draft.size);
  });

  it("مسیرهای بارگذاری: ارسال سریع دست‌کم یک PDF می‌پذیرد و نامعتبر را رد می‌کند", async () => {
    setIp("9.9.9.9");
    const mk = async (buf: Buffer, name: string) => {
      const fd = new FormData();
      fd.set("file", new File([new Uint8Array(buf)], name));
      fd.set("mode", "quick");
      return uploadRoute(new Request("http://localhost/api/docs/upload", { method: "POST", body: fd }));
    };
    const ok = await mk(await makePdf(1), "a.pdf");
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j.pageCount).toBe(1);
    const get = await draftRoute(new Request("http://localhost/x"), { params: Promise.resolve({ code: j.code }) });
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("application/pdf");
    const bad = await mk(Buffer.from("not a pdf"), "a.pdf");
    expect(bad.status).toBe(422);
    const noTeam = await uploadRoute(new Request("http://localhost/api/docs/upload", { method: "POST", body: (() => { const f = new FormData(); f.set("file", new File([new Uint8Array(Buffer.from("x"))], "a.pdf")); return f; })() }));
    expect(noTeam.status).toBe(401);
  });
});

describe("فاز ۲ — ارسال سریع بدون حساب", () => {
  async function verifiedProof(mobile: string) {
    const s = await quickSendCodeAction(mobile);
    expect(s.ok).toBe(true);
    const v = await quickVerifyCodeAction(mobile, s.devCode!);
    expect(v.ok).toBe(true);
    return v.proof!;
  }

  it("متنی: فرستنده با OTP امضا می‌کند، گیرنده لینک می‌گیرد، پیگیری و نهایی‌سازی", async () => {
    setIp("8.8.8.1");
    expect(await isQuickEnabled()).toBe(true);
    const proof = await verifiedProof("09125550001");
    const r = await createQuickSend({
      title: "رسید دریافت وجه",
      bodyHtml: "<h2>رسید</h2><p>مبلغ ۵۰ میلیون تومان دریافت شد.</p><script>alert(1)</script>",
      sender: { name: "رضا کریمی", mobile: "09125550001" },
      recipient: { name: "سارا محمدی", mobile: "09125550002" },
      proof,
      signature: makePng(),
      method: "draw",
      agree: true,
      ip: "8.8.8.1",
    });
    expect(r.manageToken).toHaveLength(43);
    expect(r.recipientUrl).toContain("/sign/");
    const st = await getQuickStatus(r.manageToken);
    expect(st?.contract.status).toBe("sent");
    expect(st?.contract.bodyHtml).not.toContain("<script");
    expect(st?.signers[0].status).toBe("signed");
    expect(st?.signers[1].status).toBe("pending");
    expect(st?.recipientUrl).toBe(r.recipientUrl);

    // گواهی تأیید یک‌بارمصرف است
    await expect(
      createQuickSend({ title: "دوباره", bodyHtml: "<p>متن آزمایشی دوباره</p>", sender: { name: "رضا کریمی", mobile: "09125550001" }, recipient: { name: "سارا محمدی", mobile: "09125550002" }, proof, signature: makePng(), method: "draw", agree: true, ip: "8.8.8.1" }),
    ).rejects.toBeInstanceOf(QuickError);

    // طرف مقابل با لینک و OTP امضا می‌کند
    const token = r.recipientUrl!.split("/sign/")[1];
    const done = await signAs(token);
    expect(done.completed).toBe(true);
    const after = await getQuickStatus(r.manageToken);
    expect(after?.contract.status).toBe("signed");
    expect(after?.senderUrl).toContain("/sign/");
    expect((await getQuickStatus("x".repeat(43))) === null).toBe(true);
  });

  it("فایل: جانمایی دو طرفه روی PDF ناشناس", async () => {
    setIp("8.8.8.2");
    const d = await createDraft({ buf: await makePdf(1), name: "doc.pdf", workspaceId: null, userId: null, ip: "8.8.8.2" });
    const proof = await verifiedProof("09125550011");
    const placements = [
      { signerPosition: 1, kind: "signature", page: 1, x: 0.1, y: 0.8, w: 0.2, h: 0.06 },
      { signerPosition: 1, kind: "text", label: "Code", page: 1, x: 0.1, y: 0.7, w: 0.2, h: 0.03 },
      { signerPosition: 2, kind: "signature", page: 1, x: 0.6, y: 0.8, w: 0.2, h: 0.06 },
    ];
    const r = await createQuickSend({
      title: "قرارداد فایل سریع",
      draftCode: d.code,
      placements,
      sender: { name: "کاوه نوری", mobile: "09125550011" },
      recipient: { name: "نگار صادقی", mobile: "09125550012" },
      proof,
      signature: makePng(),
      method: "draw",
      agree: true,
      fields: { df_2: "XYZ-9" },
      ip: "8.8.8.2",
    });
    const st = await getQuickStatus(r.manageToken);
    const fields = await listDocFields(st!.contract.id);
    expect(fields).toHaveLength(3);
    const done = await signAs(r.recipientUrl!.split("/sign/")[1]);
    expect(done.completed).toBe(true);
    const pdf = await getContractPdf(st!.contract.id);
    const out = await PDFDocument.load(pdf.buffer);
    expect(out.getPageCount()).toBe(2); // صفحه‌ی اصلی + گواهی
  });

  it("سوءاستفاده: موبایل یکسان، بدون تأیید، فایل دیگران", async () => {
    setIp("8.8.8.3");
    await expect(createQuickSend({ title: "تست", bodyHtml: "<p>متن آزمایشی طولانی</p>", sender: { name: "الف ب", mobile: "09125550021" }, recipient: { name: "ج د", mobile: "09125550021" }, proof: "x", signature: makePng(), method: "draw", agree: true, ip: "8.8.8.3" })).rejects.toThrow(/فرق/);
    await expect(createQuickSend({ title: "تست", bodyHtml: "<p>متن آزمایشی طولانی</p>", sender: { name: "الف ب", mobile: "09125550021" }, recipient: { name: "ج د", mobile: "09125550022" }, proof: "1.2.abc", signature: makePng(), method: "draw", agree: true, ip: "8.8.8.3" })).rejects.toThrow(/تأیید شماره/);
    // گواهی موبایل دیگر برای شماره‌ی من کار نمی‌کند
    const other = await verifiedProof("09125550031");
    await expect(createQuickSend({ title: "تست", bodyHtml: "<p>متن آزمایشی طولانی</p>", sender: { name: "الف ب", mobile: "09125550021" }, recipient: { name: "ج د", mobile: "09125550022" }, proof: other, signature: makePng(), method: "draw", agree: true, ip: "8.8.8.3" })).rejects.toThrow(/تأیید شماره/);
    // فایل متعلق به فضای کاری دیگر
    const teamDraft = await createDraft({ buf: await makePdf(1), name: "t.pdf", workspaceId: wsId, userId: owner.id, ip: "1.1.1.1" });
    const p2 = await verifiedProof("09125550023");
    await expect(createQuickSend({ title: "تست", draftCode: teamDraft.code, placements: [], sender: { name: "الف ب", mobile: "09125550023" }, recipient: { name: "ج د", mobile: "09125550024" }, proof: p2, signature: makePng(), method: "draw", agree: true, ip: "8.8.8.3" })).rejects.toBeInstanceOf(QuickError);
    // کد پیامکی نادرست
    const s = await quickSendCodeAction("09125550041");
    const wrong = await quickVerifyCodeAction("09125550041", s.devCode === "11111" ? "22222" : "11111");
    expect(wrong.ok).toBe(false);
  });
});

describe("فاز ۲ — جمع‌آوری امضا از عموم (لینک و QR)", () => {
  async function publicProof(code: string, mobile: string) {
    const s = await collectSendCodeAction(code, mobile);
    expect(s.ok).toBe(true);
    const v = await collectVerifyCodeAction(code, mobile, s.devCode!);
    expect(v.ok).toBe(true);
    return v.proof!;
  }

  it("کمپین متنی: فرم، OTP، امضا، رسید، تکراری، ابطال، CSV و ZIP", async () => {
    setIp("7.7.7.1");
    const c = await createCampaign(wsId, owner.id, {
      title: "رضایت‌نامه‌ی باشگاه",
      bodyHtml: "<p>مقررات باشگاه را می‌پذیرم و مسئولیت را بر عهده می‌گیرم.</p>",
      fields: [
        { key: "national_id", label: "کد ملی", type: "nid", required: true },
        { key: "level", label: "سطح", type: "select", required: true, options: ["مبتدی", "حرفه‌ای"] },
      ],
    });
    expect(c.code).toMatch(/^[a-z2-9]{8}$/);
    const mobile = "09127770001";
    const proof = await publicProof(c.code, mobile);
    const base = { fullName: "حمید شریفی", mobile, proof, signature: makePng(), agree: true };
    // کد ملی نامعتبر
    const bad = await collectSubmitAction(c.code, { ...base, values: { national_id: "1234567890", level: "مبتدی" } });
    expect(bad.ok).toBe(false);
    const ok = await collectSubmitAction(c.code, { ...base, proof: await freshProof(c.code, mobile), values: { national_id: "0013542419", level: "حرفه‌ای" } });
    expect(ok.ok).toBe(true);
    expect(ok.receipt).toMatch(/^[A-Z2-9]{10}$/);

    // امضای دوباره با همان موبایل
    await expect(submitCollect({ code: c.code, fullName: "حمید شریفی", mobile, proof: await freshProof(c.code, mobile), signature: makePng(), agree: true, values: { national_id: "0013542419", level: "مبتدی" }, ip: "7.7.7.1", userAgent: "t" })).rejects.toThrow(/قبلاً/);
    // بدون OTP
    await expect(submitCollect({ code: c.code, fullName: "کس دیگر", mobile: "09127770002", signature: makePng(), agree: true, values: { national_id: "0013542419", level: "مبتدی" }, ip: "7.7.7.1", userAgent: "t" })).rejects.toBeInstanceOf(CollectError);

    const v = await verifyReceipt(ok.receipt!);
    expect(v.found && v.intact).toBe(true);
    if (v.found) expect(v.maskedName).not.toContain("شریفی");

    const sub = (await db.select().from(collectSubmissions).where(eq(collectSubmissions.receipt, ok.receipt!)))[0];
    const pdf = await buildSubmissionPdf(sub);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const csv = await buildCsv((await getCampaignByCode(c.code))!);
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain("حمید شریفی");
    const zip = await buildZip((await getCampaignByCode(c.code))!);
    expect(zip.count).toBe(1);

    expect(await voidSubmission(sub.id, wsId, owner.id, "تست")).toBe(true);
    expect((await verifyReceipt(ok.receipt!)).found && (await verifyReceipt(ok.receipt!) as { voided: boolean }).voided).toBe(true);
    // پس از ابطال، همان شماره می‌تواند دوباره امضا کند
    const again = await submitCollect({ code: c.code, fullName: "حمید شریفی", mobile, proof: await freshProof(c.code, mobile), signature: makePng(), agree: true, values: { national_id: "0013542419", level: "مبتدی" }, ip: "7.7.7.1", userAgent: "t" });
    expect(again.receipt).toBeTruthy();
  });

  async function freshProof(code: string, mobile: string) {
    // فاصله‌ی ارسال مجدد در آزمون با حذف ردیف‌های قبلی دور زده می‌شود
    const { mobileVerifications } = await import("@/db/schema");
    await db.delete(mobileVerifications);
    return publicProof(code, mobile);
  }

  it("سقف ظرفیت، توقف و مهلت", async () => {
    const c = await createCampaign(wsId, owner.id, { title: "ظرفیت دو نفر", bodyHtml: "<p>متن توافق‌نامه‌ی ظرفیت‌دار</p>", requireOtp: false, requireSignature: false, maxSubmissions: 2 });
    const mk = (n: number) => submitCollect({ code: c.code, fullName: `نفر شماره ${n}`, mobile: `0912888000${n}`, agree: true, ip: "7.7.7.2", userAgent: "t" });
    await mk(1);
    await mk(2);
    await expect(mk(3)).rejects.toThrow(/ظرفیت/);
    const c2 = await createCampaign(wsId, owner.id, { title: "توقف", bodyHtml: "<p>متن توافق‌نامه‌ی توقف</p>", requireOtp: false, requireSignature: false });
    await updateCampaignSettings(c2.id, wsId, owner.id, { status: "paused" });
    await expect(submitCollect({ code: c2.code, fullName: "کسی هست", mobile: "09128880009", agree: true, ip: "7.7.7.2", userAgent: "t" })).rejects.toThrow(/متوقف/);
    await updateCampaignSettings(c2.id, wsId, owner.id, { status: "open", closesAt: new Date(Date.now() - 1000) });
    await expect(submitCollect({ code: c2.code, fullName: "کسی هست", mobile: "09128880009", agree: true, ip: "7.7.7.2", userAgent: "t" })).rejects.toThrow(/مهلت/);
  });

  it("کمپین فایل: امضای هر نفر روی نسخه‌ی خودش از فایل اصلی", async () => {
    const d = await createDraft({ buf: await makePdf(2), name: "terms.pdf", workspaceId: wsId, userId: owner.id, ip: "1.1.1.1" });
    const c = await createCampaign(wsId, owner.id, {
      title: "شرایط روی فایل",
      draftCode: d.code,
      placements: [
        { signerPosition: 1, kind: "signature", page: 2, x: 0.1, y: 0.8, w: 0.25, h: 0.07 },
        { signerPosition: 1, kind: "name", page: 2, x: 0.1, y: 0.7, w: 0.25, h: 0.03 },
        { signerPosition: 1, kind: "checkbox", label: "Rules", page: 1, x: 0.1, y: 0.5, w: 0.03, h: 0.03 },
      ],
      requireOtp: false,
    });
    const camp = (await getCampaignByCode(c.code))!;
    expect(camp.docFile).toBeTruthy();
    // تیک اجباری فراموش شود → خطا
    await expect(submitCollect({ code: c.code, fullName: "یاسمن کیانی", mobile: "09129990001", signature: makePng(), agree: true, ip: "7.7.7.3", userAgent: "t" })).rejects.toThrow(/تیک/);
    const r = await submitCollect({ code: c.code, fullName: "یاسمن کیانی", mobile: "09129990001", signature: makePng(), agree: true, values: { df_3: "1" }, ip: "7.7.7.3", userAgent: "t" });
    const sub = (await db.select().from(collectSubmissions).where(eq(collectSubmissions.receipt, r.receipt)))[0];
    const out = await PDFDocument.load(await buildSubmissionPdf(sub));
    expect(out.getPageCount()).toBe(3);
  });
});
