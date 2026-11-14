/**
 * رفع ۳ نگرانی تیم بازرسی روی فاز ۲ (آزمون‌های «جدید»؛ هیچ آزمون موجودی تغییر نکرده است):
 *  ۱) ایزولاسیون کامل فضای کاری «ارسال سریع» از پنل، فهرست‌ها، آمار نام‌دار، پروفایل عمومی و ایمیل مدیریتی
 *  ۲) Word دارای تصویر/مهر/امضای اسکن‌شده → رد با پیام روشن (به‌جای تبدیل ناقص)
 *  ۳) دقت مختصات فیلدها (عدد صحیح «ده‌هزارم صفحه») و نبود هیچ افت قابل‌سنجش در جانمایی امضا
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { eq, sql } from "drizzle-orm";
import { db, getPool } from "@/db";
import { documentFields, notifications, users, workspaceMembers, workspaces } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { getContractForUser } from "@/modules/contracts/service";
import { createWorkspace } from "@/modules/tenancy/service";
import { createInvite, findInvite } from "@/modules/tenancy/invites";
import { getMemberships } from "@/modules/tenancy/context";
import { isIsolatedWorkspace } from "@/modules/tenancy/isolation";
import { trustProfile } from "@/modules/hub/service";
import { createQuickSend, getQuickContext } from "@/modules/quick/service";
import { quickSendCodeAction, quickVerifyCodeAction } from "@/modules/quick/actions";
import { guestSendOtpAction, guestSignAction, guestVerifyOtpAction } from "@/modules/signing/guest-actions";
import { drainJobs } from "@/modules/jobs/queue";
import { BP, createDraft, DocError, DOCX_IMAGES_MESSAGE, ingestUpload, listDocFields, attachSourceToContract, getUsableDraft, sourceStubHtml } from "@/modules/docs/service";
import { sanitizePlacements } from "@/modules/docs/placement";
import { issueContract } from "@/modules/contracts/service";
import { ensureGuestSigner } from "@/modules/guests/service";
import { POST as uploadRoute } from "@/app/api/docs/upload/route";
import type { SessionUser } from "@/modules/auth/session";
import { freshBrowser, makePng, setIp, uniq } from "../helpers";
import { newContract, setupWorkspace, signAll } from "../flows";

beforeEach(() => freshBrowser());

/* ───────────────────────── ۱) ایزولاسیون ───────────────────────── */

describe("بازرسی ۱ — فضای کاری ارسال سریع کاملاً ایزوله است", () => {
  let admin: { id: number; email: string };
  let quickWs = 0;
  let systemOwner = 0;
  let contractId = 0;
  let recipientToken = "";

  const proofFor = async (mobile: string) => {
    const s = await quickSendCodeAction(mobile);
    expect(s.ok).toBe(true);
    const v = await quickVerifyCodeAction(mobile, s.devCode!);
    expect(v.ok).toBe(true);
    return v.proof!;
  };

  beforeAll(async () => {
    const [a] = await db
      .insert(users)
      .values({ name: "مدیر کل", email: `${uniq("pa")}@example.com`, mobile: "09120000101", passwordHash: hashPassword("Admin123x"), role: "admin", emailVerifiedAt: new Date() })
      .returning();
    admin = a;
    setIp("8.8.7.1");
    const r = await createQuickSend({
      title: "سند خصوصی محرمانه",
      bodyHtml: "<p>این متن خصوصی فرستنده است و نباید به مدیر برسد.</p>",
      sender: { name: "کاوه خسروی", mobile: "09127770001" },
      recipient: { name: "نیلوفر رضایی", mobile: "09127770002" },
      proof: await proofFor("09127770001"),
      signature: makePng(),
      method: "draw",
      agree: true,
      ip: "8.8.7.1",
    });
    contractId = r.contractId;
    recipientToken = r.recipientUrl!.split("/sign/")[1];
    const ctx = await getQuickContext();
    quickWs = ctx.workspaceId;
    systemOwner = ctx.ownerId;
  });

  it("فضای ارسال سریع با پرچم kind=quick علامت خورده و admin_email آن خالی است", async () => {
    const [w] = await db.select().from(workspaces).where(eq(workspaces.id, quickWs));
    expect(w.kind).toBe("quick");
    expect(await isIsolatedWorkspace(quickWs)).toBe(true);
    const rows = await db.execute<{ value: string }>(sql`select value from workspace_settings where workspace_id = ${quickWs} and key = 'admin_email'`);
    expect(rows.rows[0]?.value).toBe("");
    // فضای عادی ایزوله نیست
    const team = await setupWorkspace("تیم عادی");
    expect(await isIsolatedWorkspace(team.wsId)).toBe(false);
  });

  it("هیچ‌کس (حتی مالک سیستمی یا مدیر کل با عضویتِ دستی) این فضا را در فهرست/پنل نمی‌بیند", async () => {
    expect((await getMemberships(systemOwner)).map((m) => m.workspaceId)).not.toContain(quickWs);
    // حمله: مدیر کل خودش را عضو/مالک فضای ایزوله می‌کند (مثلاً با SQL مستقیم)
    await db.insert(workspaceMembers).values({ workspaceId: quickWs, userId: admin.id, role: "owner" });
    expect((await getMemberships(admin.id)).map((m) => m.workspaceId)).not.toContain(quickWs);
    // ... و حتی با نقش تیمی، به خود قرارداد دسترسی ندارد
    const asAdmin = { id: admin.id, email: admin.email, role: "admin", name: "مدیر کل" } as unknown as SessionUser;
    expect(await getContractForUser(asAdmin, contractId)).toBeNull();
    // اما امضاکننده‌ی خود قرارداد دسترسی‌اش را از دست نمی‌دهد (سند خودش است)
    const [{ id: senderUid }] = (await db.execute<{ id: number }>(sql`select sender_user_id as id from quick_sends where contract_id = ${contractId}`)).rows;
    expect(await getContractForUser({ id: senderUid } as unknown as SessionUser, contractId)).not.toBeNull();
    // مُهر دوباره (خودترمیمی) عضو تیمیِ غیرمجاز را پاک می‌کند
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, admin.id));
  });

  it("ارتقای دیتابیس قدیمی: فضای ساخته‌شده پیش از اصلاح (kind=team، بدون مهر) خودکار مُهر می‌شود", async () => {
    const { sealIsolatedWorkspace } = await import("@/modules/tenancy/isolation");
    // شبیه‌سازی وضعیت قبل از اصلاح: برچسب عادی، admin_email پیش‌فرض (بدون ردیف) و یک عضو تیمی ناخواسته
    await db.update(workspaces).set({ kind: "team" }).where(eq(workspaces.id, quickWs));
    await db.execute(sql`delete from workspace_settings where workspace_id = ${quickWs} and key = 'admin_email'`);
    await db.insert(workspaceMembers).values({ workspaceId: quickWs, userId: admin.id, role: "admin" });
    await sealIsolatedWorkspace(quickWs, systemOwner, { force: true });
    expect(await isIsolatedWorkspace(quickWs)).toBe(true);
    const rows = await db.execute<{ value: string }>(sql`select value from workspace_settings where workspace_id = ${quickWs} and key = 'admin_email'`);
    expect(rows.rows[0]?.value).toBe("");
    const members = await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, quickWs));
    expect(members.some((m) => m.userId === admin.id)).toBe(false);
    expect(members.some((m) => m.userId === systemOwner)).toBe(true);
  });

  it("پروفایل عمومی اعتماد و دعوت‌نامه برای فضای ایزوله وجود ندارد", async () => {
    const [w] = await db.select().from(workspaces).where(eq(workspaces.id, quickWs));
    expect(await trustProfile(w.slug)).toBeNull();
    await expect(createInvite(quickWs, "x@example.com", "admin", admin.id)).rejects.toThrow();
    // دعوتِ از پیش‌ساخته‌شده (حمله با SQL) هم یافت نمی‌شود
    const { workspaceInvites } = await import("@/db/schema");
    const { sha256 } = await import("@/lib/password");
    const plain = "a".repeat(64);
    await db.insert(workspaceInvites).values({ workspaceId: quickWs, email: "x@example.com", role: "admin", tokenHash: sha256(plain), invitedBy: admin.id, expiresAt: new Date(Date.now() + 1e7) });
    expect(await findInvite(plain)).toBeNull();
  });

  it("نسخه‌ی نهایی سند خصوصی به ایمیل مدیریتی نمی‌رود (و در فضای عادی می‌رود: گروه شاهد)", async () => {
    // ارسال سریع: طرف مقابل امضا می‌کند ← صف finalize
    const send = await guestSendOtpAction(recipientToken);
    expect(send.ok).toBe(true);
    expect((await guestVerifyOtpAction(recipientToken, send.devCode!)).ok).toBe(true);
    const done = await guestSignAction(recipientToken, { signature: makePng(), method: "draw", agree: true });
    expect(done.completed).toBe(true);
    await drainJobs();
    const quickMails = await db.select().from(notifications).where(eq(notifications.contractId, contractId));
    expect(quickMails.some((n) => n.recipient === "admin@example.com")).toBe(false);

    // گروه شاهد: همین مسیر در فضای عادی به admin_email پیش‌فرض ایمیل می‌دهد؛ پس آزمون حساس است
    const team = await setupWorkspace("تیم شاهد");
    const c = await newContract(team.wsId, team.owner.id);
    await signAll(c.id);
    await drainJobs();
    const teamMails = await db.select().from(notifications).where(eq(notifications.contractId, c.id));
    expect(teamMails.some((n) => n.recipient === "admin@example.com")).toBe(true);
  });
});

/* ───────────────────────── ۲) Word دارای تصویر ───────────────────────── */

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:schemas-microsoft-com:vml"';
const para = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const docXml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><w:document ${NS}><w:body>${body}</w:body></w:document>`;
const part = (root: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?><w:${root} ${NS}>${body}</w:${root}>`;
const DRAWING = '<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><a:blip r:embed="rId5"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
const zipDocx = (files: Record<string, string | Uint8Array>) =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])) as Record<string, Uint8Array>));

describe("بازرسی ۲ — Word دارای تصویر به‌جای تبدیل ناقص رد می‌شود", () => {
  it("Word متنی ساده همچنان تبدیل می‌شود (بدون رد)", async () => {
    const r = await ingestUpload(zipDocx({ "word/document.xml": docXml(para("متن قرارداد ساده")) }), "ok.docx");
    expect(r.kind).toBe("docx");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  const cases: [string, Record<string, string | Uint8Array>][] = [
    ["تصویر در بدنه (مهر/امضای اسکن‌شده)", { "word/document.xml": docXml(para("متن") + DRAWING) }],
    ["فقط فایل رسانه در بسته (word/media)", { "word/document.xml": docXml(para("متن")), "word/media/image1.png": new Uint8Array([137, 80, 78, 71, 1, 2, 3]) }],
    ["تصویر فقط در سرصفحه (لوگو/مهر اداری)", { "word/document.xml": docXml(para("متن")), "word/header1.xml": part("hdr", DRAWING) }],
    ["تصویر در پاصفحه", { "word/document.xml": docXml(para("متن")), "word/footer1.xml": part("ftr", DRAWING) }],
    ["تصویر داخل mc:AlternateContent (شناور)", { "word/document.xml": docXml(`<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor/></w:drawing></mc:Choice></mc:AlternateContent></w:r></w:p>` + para("متن")) }],
    ["تصویر VML قدیمی (w:pict)", { "word/document.xml": docXml(`<w:p><w:r><w:pict><v:shape><v:imagedata r:id="rId9"/></v:shape></w:pict></w:r></w:p>` + para("متن")) }],
    ["تصویر داخل جدول", { "word/document.xml": docXml(`<w:tbl><w:tr><w:tc>${DRAWING}</w:tc></w:tr></w:tbl>` + para("متن")) }],
  ];
  for (const [title, files] of cases) {
    it(`رد می‌شود: ${title}`, async () => {
      const err = await ingestUpload(zipDocx(files), "c.docx").catch((e) => e);
      expect(err).toBeInstanceOf(DocError);
      expect((err as DocError).code).toBe("docx_has_images");
      expect((err as DocError).message).toBe(DOCX_IMAGES_MESSAGE);
      expect((err as DocError).message).toContain("PDF");
    });
  }

  it("هیچ فایل یا پیش‌نویسی از Word رد‌شده در دیتابیس باقی نمی‌ماند", async () => {
    const before = (await db.execute<{ n: number }>(sql`select count(*)::int as n from document_drafts`)).rows[0].n;
    await expect(createDraft({ buf: zipDocx({ "word/document.xml": docXml(para("متن") + DRAWING) }), name: "c.docx", workspaceId: null, userId: null, ip: "5.5.5.5" })).rejects.toBeInstanceOf(DocError);
    const after = (await db.execute<{ n: number }>(sql`select count(*)::int as n from document_drafts`)).rows[0].n;
    expect(after).toBe(before);
  });

  it("مسیر API (ارسال سریع): ۴۲۲ + کد docx_has_images + پیام درخواست PDF", async () => {
    setIp("9.9.8.8");
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(zipDocx({ "word/document.xml": docXml(para("متن") + DRAWING) }))], "stamp.docx"));
    fd.set("mode", "quick");
    const res = await uploadRoute(new Request("http://localhost/api/docs/upload", { method: "POST", body: fd }));
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.code).toBe("docx_has_images");
    expect(j.error).toContain("PDF");
  });

  it("PDF دارای تصویر مشکلی ندارد (فایل اصلی بدون تغییر نگه‌داری می‌شود)", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const r = await ingestUpload(Buffer.from(await doc.save()), "scan.pdf");
    expect(r.kind).toBe("pdf");
    expect(r.warnings).toEqual([]);
  });

  it("متن سرصفحه/پاصفحه (که تبدیل نمی‌شود) هشدار می‌گیرد", async () => {
    const r = await ingestUpload(zipDocx({ "word/document.xml": docXml(para("متن")), "word/header1.xml": part("hdr", para("شماره قرارداد ۱۲۳")) }), "h.docx");
    expect(r.warnings.some((w) => w.includes("سرصفحه"))).toBe(true);
  });
});

/* ───────────────────────── ۳) دقت مختصات ───────────────────────── */

describe("بازرسی ۳ — عدد صحیح «ده‌هزارم صفحه» دقت جانمایی را کم نمی‌کند", () => {
  it("ستون‌های مختصات integer هستند و تبدیل رفت‌وبرگشت برای همه‌ی ۰..۱۰۰۰۰ بدون خطا و بدون رانش است", async () => {
    const info = await getPool().query("select column_name, data_type from information_schema.columns where table_name = 'document_fields' and column_name in ('x','y','w','h')");
    expect(info.rows.map((r) => r.data_type)).toEqual(["integer", "integer", "integer", "integer"]);
    const { toBp } = await import("@/modules/docs/service");
    for (let i = 0; i <= BP; i++) expect(toBp(i / BP)).toBe(i);
  });

  it("خطای بیشینه‌ی گرد کردن ≤ نیم ده‌هزارم؛ روی A4/A3/A0 زیر ۰٫۱۷ pt و روی A4 زیر ۰٫۰۵ pt", () => {
    const worst = 0.5 / BP;
    const pt = (dim: number) => worst * dim;
    expect(pt(595)).toBeLessThan(0.03);
    expect(pt(842)).toBeLessThan(0.043);
    expect(pt(1191)).toBeLessThan(0.06); // A3 (ارتفاع)
    expect(pt(3370)).toBeLessThan(0.17); // A0 (ارتفاع)
    // کمتر از یک پیکسل چاپگر ۶۰۰dpi (۰٫۱۲ pt) برای هر کاغذ معمول
    expect(pt(842)).toBeLessThan(72 / 600);
  });

  it("ذخیره در دیتابیس و خواندن: هر چهار مقدار نهایتاً به‌اندازه‌ی نیم ده‌هزارم جابه‌جا می‌شوند", async () => {
    const t = await setupWorkspace("دقت");
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const draft = await createDraft({ buf: Buffer.from(await doc.save()), name: "p.pdf", workspaceId: t.wsId, userId: t.owner.id, ip: "1.1.1.1" });
    // مقادیر «غیرگرد» عمدی (شبیه کشیدن با ماوس روی صفحه با اعشار زیاد)
    const input = [
      { signerPosition: 1, kind: "signature", page: 1, x: 0.123456789, y: 0.7654321, w: 0.2345678, h: 0.0812345 },
      { signerPosition: 2, kind: "signature", page: 1, x: 0.5000049, y: 0.30000501, w: 0.18181818, h: 0.07070707 },
      { signerPosition: 1, kind: "text", label: "کد ملی", page: 1, x: 0.3333333, y: 0.1111111, w: 0.3, h: 0.025 },
    ];
    const pl = sanitizePlacements(input, 1, 2, { requireSignatureFor: [1, 2] });
    expect(pl.ok).toBe(true);
    if (!pl.ok) return;
    const g1 = await ensureGuestSigner(t.wsId, { name: "علی رضایی", mobile: "09121110991" });
    const g2 = await ensureGuestSigner(t.wsId, { name: "مریم احمدی", mobile: "09121110992" });
    const d = await getUsableDraft(draft.code, t.wsId);
    const id = await issueContract({
      workspaceId: t.wsId,
      title: "دقت مختصات",
      bodyHtml: sourceStubHtml(d.originalName, d.originalSha256),
      customerId: g2.userId,
      customerLabel: "طرف دوم",
      extraSigners: [{ label: "طرف اول", userId: g1.userId }],
      createdBy: t.owner.id,
      onCreated: (cid) => attachSourceToContract(cid, d, pl.items),
    });
    const stored = await listDocFields(id);
    expect(stored).toHaveLength(pl.items.length);
    const raw = await db.select().from(documentFields).where(eq(documentFields.contractId, id));
    for (const r of raw) for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(v)).toBe(true);
    const key = (f: { signerPosition: number; kind: string; x?: number }) => `${f.signerPosition}:${f.kind}`;
    for (const want of pl.items) {
      const got = stored.find((s) => key(s) === key(want))!;
      for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(got[k] - want[k]), `${key(want)}.${k}`).toBeLessThanOrEqual(0.5 / BP + 1e-12);
      // جابه‌جایی لبه‌ی راست/پایین روی A4 زیر ۰٫۰۶ و ۰٫۰۹ pt (≈ ۰٫۰۳ mm)
      expect(Math.abs((got.x + got.w) - (want.x + want.w)) * 595).toBeLessThan(0.07);
      expect(Math.abs((got.y + got.h) - (want.y + want.h)) * 842).toBeLessThan(0.09);
    }
    // ذخیره‌ی دوباره‌ی مقدارِ خوانده‌شده تغییری ایجاد نمی‌کند (رانش صفر)
    const { toBp } = await import("@/modules/docs/service");
    for (const s of stored) for (const k of ["x", "y", "w", "h"] as const) expect(toBp(s[k]) / BP).toBe(s[k]);
  });
});
