import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, contractAmendments, contractAttachments, contractFieldValues, contracts, users } from "@/db/schema";
import { attachmentsDir } from "@/lib/storage-paths";
import { createSession } from "@/modules/auth/session";
import { getSigners } from "@/modules/contracts/service";
import { resolveSigningToken, getOrCreateSigningLink } from "@/modules/signing/links";
import { guestSendOtpAction, guestSignAction, guestVerifyOtpAction } from "@/modules/signing/guest-actions";
import { verifyDocument } from "@/modules/verify/service";
import { getContractPdf } from "@/modules/pdf/service";
import { buildPdfInput } from "@/modules/pdf/service";
import { amendDecideAction, amendSendOtpAction } from "@/modules/amendments/actions";
import { buildAmendmentPdfInput, contractVersion, createAmendment, listAmendments, resolveAmendToken } from "@/modules/amendments/service";
import { renderContractPdf } from "@/modules/pdf/render";
import { listAttachments } from "@/modules/attachments/service";
import { POST as uploadAccount } from "@/app/api/contracts/[id]/attachments/route";
import { GET as downloadAccount, DELETE as deleteAccount } from "@/app/api/contracts/[id]/attachments/[aid]/route";
import { POST as uploadGuest, GET as guestAttachments } from "@/app/api/sign/[token]/attachments/route";
import { GET as amendPdf } from "@/app/api/contracts/[id]/amendments/[seq]/pdf/route";
import { clearOtps, guestSignWith, newClient, newContract, setupWorkspace, signAll } from "../flows";
import { freshBrowser, makePng } from "../helpers";

let owner: { id: number };
let wsId: number;

const FIELD_BODY =
  "<h2>قرارداد با فیلد</h2><p>خریدار با کد ملی {{field:national_id|کد ملی|nid}} و نشانی {{field:address|نشانی|address}} ساکن است. تاریخ تحویل: {{field:delivery|تاریخ تحویل|date|opt}}. فروشنده: {{field:seller_phone|تلفن فروشنده|phone|req|1}}</p>";

beforeAll(async () => {
  ({ owner, wsId } = await setupWorkspace());
});
beforeEach(() => freshBrowser());

const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });
const upload = (bytes: Buffer, name = "id.png", title = "") => {
  const f = new FormData();
  f.set("file", new File([new Uint8Array(bytes)], name));
  f.set("title", title);
  return new Request("http://localhost/x", { method: "POST", body: f });
};
const asUser = async (userId: number) => {
  freshBrowser();
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  await createSession(u.id, u.passwordHash);
  return u;
};

describe("فیلدهای قابل‌پرکردن هنگام امضا", () => {
  it("فیلد اجباری/نامعتبر امضا را رد می‌کند؛ مقدارها ذخیره، در هش قفل و در PDF درج می‌شوند", async () => {
    const { id, signers } = await newContract(wsId, owner.id, { body: FIELD_BODY });
    const [seller, buyer] = signers;

    // فروشنده فقط فیلد خودش (تلفن فروشنده) را پر می‌کند؛ بدون آن رد می‌شود
    freshBrowser();
    const l1 = (await getOrCreateSigningLink(seller.id))!;
    const s1 = await guestSendOtpAction(l1.token);
    await guestVerifyOtpAction(l1.token, s1.devCode!);
    const missing = await guestSignAction(l1.token, { signature: makePng(), method: "draw", agree: true, fields: {} });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/تلفن فروشنده/);
    // رد شدنِ اعتبارسنجی، OTP را نسوزانده و امضا ثبت نشده است
    expect((await getSigners(id))[0].status).toBe("pending");
    const sellerOk = await guestSignAction(l1.token, { signature: makePng(), method: "draw", agree: true, fields: { seller_phone: "۰۲۱۸۸۸۸۸۸۸۸", national_id: "0013542419" } });
    expect(sellerOk.ok).toBe(true);
    // فیلد متعلق به خریدار توسط فروشنده نادیده گرفته می‌شود (تزریق ممکن نیست)
    expect((await db.select().from(contractFieldValues).where(eq(contractFieldValues.contractId, id))).map((f) => f.key)).toEqual(["seller_phone"]);

    // خریدار: کد ملی نامعتبر
    freshBrowser();
    const l2 = (await getOrCreateSigningLink(buyer.id))!;
    const s2 = await guestSendOtpAction(l2.token);
    await guestVerifyOtpAction(l2.token, s2.devCode!);
    const badNid = await guestSignAction(l2.token, { signature: makePng(), method: "draw", agree: true, fields: { national_id: "0013542418", address: "تهران، خیابان آزادی، پلاک ۱۲" } });
    expect(badNid.ok).toBe(false);
    expect(badNid.error).toMatch(/کد ملی/);
    const done = await guestSignAction(l2.token, { signature: makePng(), method: "draw", agree: true, fields: { national_id: "۰۰۱۳۵۴۲۴۱۹", address: "تهران، خیابان آزادی، پلاک ۱۲" } });
    expect(done).toMatchObject({ ok: true, completed: true });

    const vals = await db.select().from(contractFieldValues).where(eq(contractFieldValues.contractId, id));
    expect(Object.fromEntries(vals.map((v) => [v.key, v.value]))).toEqual({ seller_phone: "02188888888", national_id: "0013542419", address: "تهران، خیابان آزادی، پلاک ۱۲" });

    // اثر انگشت شامل فیلدهاست؛ دستکاری مقدار = «سند دستکاری شده»
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect((await verifyDocument(c.docHash!)).found && (await verifyDocument(c.docHash!))).toMatchObject({ intact: true, version: 1 });
    await db.update(contractFieldValues).set({ value: "9999999999" }).where(eq(contractFieldValues.key, "national_id"));
    expect(await verifyDocument(c.docHash!)).toMatchObject({ found: true, intact: false });
    await db.update(contractFieldValues).set({ value: "0013542419" }).where(eq(contractFieldValues.key, "national_id"));
    expect(await verifyDocument(c.docHash!)).toMatchObject({ intact: true });

    // متن PDF با مقدارها پر شده (توکن خام نمی‌ماند) و PDF معتبر ساخته می‌شود
    const input = await buildPdfInput(id);
    expect(input!.bodyHtml).toContain("0013542419");
    expect(input!.bodyHtml).not.toContain("{{field:");
    const pdf = await getContractPdf(id);
    expect(pdf.buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await db.select().from(auditLogs).where(eq(auditLogs.contractId, id))).some((a) => a.action === "fields.filled")).toBe(true);
  });

  it("قرارداد بدون فیلد مثل قبل امضا می‌شود (سازگاری)", async () => {
    const { id } = await newContract(wsId, owner.id);
    await signAll(id);
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c.status).toBe("signed");
    expect(await verifyDocument(c.docHash!)).toMatchObject({ intact: true });
  });
});

describe("پیوست فایل", () => {
  it("آپلود امن با هش، دانلود، حذف و کنترل دسترسی", async () => {
    const { id, signers, buyer } = await newContract(wsId, owner.id);
    const png = Buffer.from(makePng().split(",")[1], "base64");

    // بدون ورود: 401
    freshBrowser();
    expect((await uploadAccount(upload(png), params({ id: String(id) }))).status).toBe(401);

    // امضاکننده‌ی واردشده آپلود می‌کند
    await asUser(buyer.userId);
    const res = await uploadAccount(upload(png, "کارت ملی.png", "کارت ملی"), params({ id: String(id) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; sha256: string };
    const [row] = await db.select().from(contractAttachments).where(eq(contractAttachments.id, body.id));
    expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row.mime).toBe("image/png");
    expect(row.file).not.toContain("کارت");
    const onDisk = path.join(attachmentsDir(), row.file);
    expect(fs.statSync(onDisk).mode & 0o077).toBe(0);

    // دانلود: attachment + nosniff + CSP sandbox
    const dl = await downloadAccount(new Request("http://x"), params({ id: String(id), aid: String(row.id) }));
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await dl.arrayBuffer()).equals(png)).toBe(true);

    // کاربر بی‌ارتباط (فضای کاری/قرارداد دیگر): 404
    const stranger = await newClient(wsId, "غریبه", "09121110099");
    const other = await newContract(wsId, owner.id, { title: "دیگری" });
    void stranger;
    await asUser((await getSigners(other.id))[1].userId);
    expect((await downloadAccount(new Request("http://x"), params({ id: String(id), aid: String(row.id) }))).status).toBe(404);
    expect((await uploadAccount(upload(png), params({ id: String(id) }))).status).toBe(404);

    // دستکاری فایل روی دیسک شناسایی می‌شود
    await asUser(buyer.userId);
    fs.appendFileSync(onDisk, "tamper");
    const tampered = await downloadAccount(new Request("http://x"), params({ id: String(id), aid: String(row.id) }));
    expect(tampered.status).toBe(409);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.contractId, id))).some((a) => a.action === "attachment.tampered")).toBe(true);

    // حذف توسط بارگذارنده (قرارداد هنوز نهایی نشده)
    const del = await deleteAccount(new Request("http://x", { method: "DELETE" }), params({ id: String(id), aid: String(row.id) }));
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);
    expect(fs.existsSync(onDisk)).toBe(false);
    void signers;
  });

  it("فایل‌های خطرناک، بزرگ و جعلی رد می‌شوند", async () => {
    const { id, buyer } = await newContract(wsId, owner.id);
    await asUser(buyer.userId);
    const p = params({ id: String(id) });
    const html = await uploadAccount(upload(Buffer.from("<html><script>alert(1)</script></html>"), "x.png"), p);
    expect(html.status).toBe(400);
    expect(((await html.json()) as { error: string }).error).toMatch(/PDF|PNG/);
    expect((await uploadAccount(upload(Buffer.alloc(0), "e.png"), p)).status).toBe(400);
    const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(5 * 1024 * 1024 + 10)]);
    expect((await uploadAccount(upload(big, "big.pdf"), p)).status).toBe(400);
    const pdf = await uploadAccount(upload(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2000)]), "../../evil.pdf"), p);
    expect(pdf.status).toBe(200);
    const [row] = await db.select().from(contractAttachments).where(eq(contractAttachments.contractId, id));
    expect(row.originalName).toBe("evil.pdf");
  });

  it("امضاکننده‌ی مهمان فقط پس از OTP آپلود می‌کند و فقط پیوست‌های خودش را می‌بیند", async () => {
    const { id, signers } = await newContract(wsId, owner.id);
    freshBrowser();
    const { token } = (await getOrCreateSigningLink(signers[0].id))!;
    const png = Buffer.from(makePng().split(",")[1], "base64");
    expect((await uploadGuest(upload(png), params({ token }))).status).toBe(401);
    const sent = await guestSendOtpAction(token);
    await guestVerifyOtpAction(token, sent.devCode!);
    const ok = await uploadGuest(upload(png, "card.png", "کارت ملی"), params({ token }));
    expect(ok.status).toBe(200);
    const list = (await (await guestAttachments(new Request(`http://x/api/sign/${token}/attachments`), params({ token }))).json()) as { items: { id: number }[] };
    expect(list.items).toHaveLength(1);
    // توکن نامعتبر
    expect((await uploadGuest(upload(png), params({ token: "x".repeat(43) }))).status).toBe(401);
    expect((await listAttachments(id))).toHaveLength(1);
  });

  it("پیوست قرارداد امضاشده حذف‌شدنی نیست", async () => {
    const { id, buyer } = await newContract(wsId, owner.id);
    await asUser(buyer.userId);
    const png = Buffer.from(makePng().split(",")[1], "base64");
    const up = (await (await uploadAccount(upload(png), params({ id: String(id) }))).json()) as { id: number };
    await signAll(id);
    await asUser(buyer.userId);
    const del = await deleteAccount(new Request("http://x", { method: "DELETE" }), params({ id: String(id), aid: String(up.id) }));
    expect(del.status).toBe(400);
  });
});

describe("الحاقیه و نسخه‌بندی", () => {
  async function signedContract() {
    const c = await newContract(wsId, owner.id);
    await signAll(c.id);
    return c;
  }

  it("فقط برای قرارداد امضاشده؛ یک الحاقیه‌ی باز در هر زمان؛ اعتبارسنجی ورودی", async () => {
    const draftLike = await newContract(wsId, owner.id);
    const r0 = await createAmendment({ contractId: draftLike.id, workspaceId: wsId, title: "تغییر مبلغ", bodyText: "مبلغ قرارداد افزایش می‌یابد.", actorId: owner.id });
    expect(r0).toMatchObject({ ok: false });

    const { id } = await signedContract();
    expect((await createAmendment({ contractId: id, workspaceId: wsId, title: "x", bodyText: "متن کافی برای الحاقیه", actorId: owner.id })).ok).toBe(false);
    expect((await createAmendment({ contractId: id, workspaceId: wsId, title: "عنوان خوب", bodyText: "کوتاه", actorId: owner.id })).ok).toBe(false);
    expect((await createAmendment({ contractId: id, workspaceId: wsId + 999, title: "عنوان خوب", bodyText: "متن کافی برای الحاقیه", actorId: owner.id })).ok).toBe(false);
    const ok = await createAmendment({ contractId: id, workspaceId: wsId, title: "تغییر مبلغ", bodyText: "مبلغ قرارداد به ۲۰۰ میلیون تومان افزایش می‌یابد.\n\nسایر مفاد ثابت است.", actorId: owner.id });
    expect(ok.ok).toBe(true);
    const dup = await createAmendment({ contractId: id, workspaceId: wsId, title: "دومی", bodyText: "یک متن دیگر برای الحاقیه", actorId: owner.id });
    expect(dup).toMatchObject({ ok: false });
    expect(await contractVersion(id)).toBe(1);
  });

  it("تأیید OTP همه‌ی طرفین → الحاقیه اجرایی، نسخه ۲، اثر انگشت و PDF", async () => {
    const { id, signers } = await signedContract();
    const created = await createAmendment({ contractId: id, workspaceId: wsId, title: "تمدید تحویل", bodyText: "تاریخ تحویل یک ماه به تعویق می‌افتد.", actorId: owner.id });
    if (!created.ok) throw new Error(created.error);
    const tokens = created.links.map((l) => l.url.split("/amend/")[1]);
    expect(tokens.every((t) => /^[A-Za-z0-9_-]{43}$/.test(t))).toBe(true);

    // کد غلط، و تأیید بدون تیک مطالعه رد می‌شود
    freshBrowser();
    await clearOtps(signers[0].id);
    const sent = await amendSendOtpAction({ token: tokens[0] });
    expect(sent.ok).toBe(true);
    expect((await amendDecideAction({ token: tokens[0] }, { accept: true, code: sent.devCode!, agree: false })).ok).toBe(false);
    expect((await amendDecideAction({ token: tokens[0] }, { accept: true, code: sent.devCode === "10000" ? "10001" : "10000", agree: true })).ok).toBe(false);
    const first = await amendDecideAction({ token: tokens[0] }, { accept: true, code: sent.devCode!, agree: true });
    expect(first).toMatchObject({ ok: true, completed: false });
    // تصمیم دوباره ممکن نیست
    expect((await amendDecideAction({ token: tokens[0] }, { accept: true, code: "12345", agree: true })).ok).toBe(false);
    expect(await contractVersion(id)).toBe(1);

    freshBrowser();
    await clearOtps(signers[1].id);
    const sent2 = await amendSendOtpAction({ token: tokens[1] });
    const second = await amendDecideAction({ token: tokens[1] }, { accept: true, code: sent2.devCode!, agree: true });
    expect(second).toMatchObject({ ok: true, completed: true });

    expect(await contractVersion(id)).toBe(2);
    const [am] = await listAmendments(id);
    expect(am.status).toBe("signed");
    expect(am.docHash).toMatch(/^[a-f0-9]{64}$/);
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(await verifyDocument(c.docHash!)).toMatchObject({ intact: true, version: 2, amendments: [{ seq: 1, title: "تمدید تحویل" }] });

    const built = await buildAmendmentPdfInput(id, 1);
    expect(built!.input.signers).toHaveLength(2);
    const buf = await renderContractPdf(built!.input);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");

    // مسیر HTTP PDF: فقط کاربر دارای دسترسی
    await asUser(signers[0].userId);
    const res = await amendPdf(new Request("http://x"), params({ id: String(id), seq: "1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-amendment-fingerprint")).toBe(am.docHash);
    freshBrowser();
    expect((await amendPdf(new Request("http://x"), params({ id: String(id), seq: "1" }))).status).toBe(401);
  });

  it("رد توسط یک نفر کل الحاقیه را رد می‌کند و می‌توان الحاقیه‌ی جدید داد", async () => {
    const { id, signers } = await signedContract();
    const created = await createAmendment({ contractId: id, workspaceId: wsId, title: "پیشنهاد", bodyText: "پیشنهاد تغییر در مفاد قرارداد.", actorId: owner.id });
    if (!created.ok) throw new Error(created.error);
    const token = created.links[0].url.split("/amend/")[1];
    freshBrowser();
    await clearOtps(signers[0].id);
    const sent = await amendSendOtpAction({ token });
    expect(await amendDecideAction({ token }, { accept: false, code: sent.devCode!, agree: false })).toMatchObject({ ok: true });
    expect((await resolveAmendToken(token))!.amendment.status).toBe("rejected");
    expect(await contractVersion(id)).toBe(1);
    const again = await createAmendment({ contractId: id, workspaceId: wsId, title: "اصلاحی", bodyText: "متن اصلاح‌شده‌ی پیشنهاد قبلی.", actorId: owner.id });
    expect(again).toMatchObject({ ok: true, seq: 2 });
    // حساب کاربری امضاکننده هم می‌تواند با amendmentId تصمیم بگیرد (مسیر حساب)
    const am2 = (await db.select().from(contractAmendments).where(eq(contractAmendments.contractId, id))).find((a) => a.seq === 2)!;
    await asUser(signers[1].userId);
    await clearOtps(signers[1].id);
    const s2 = await amendSendOtpAction({ amendmentId: am2.id });
    expect(s2.ok).toBe(true);
    expect((await amendDecideAction({ amendmentId: am2.id }, { accept: true, code: s2.devCode!, agree: true })).ok).toBe(true);
    // کاربر غیرمرتبط به الحاقیه دسترسی ندارد
    const stranger = await newClient(wsId, "ثالث", "09121110055");
    await asUser(stranger.userId);
    expect((await amendSendOtpAction({ amendmentId: am2.id })).ok).toBe(false);
    expect((await amendSendOtpAction({ token: "y".repeat(43) })).ok).toBe(false);
  });
});

describe("نمونه‌ی امضای مهمان با فیلد (کمکی)", () => {
  it("guestSignWith کار می‌کند", async () => {
    const { id, signers } = await newContract(wsId, owner.id);
    const r = await guestSignWith(signers[0].id);
    expect(r.result.ok).toBe(true);
    expect((await resolveSigningToken(r.token)).status).toBe("done");
    void id;
  });
});
