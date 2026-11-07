import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contractDocuments, contracts, signingLinks, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { cancelContract, getSigners, issueContract } from "@/modules/contracts/service";
import { createWorkspace, ensureClient } from "@/modules/tenancy/service";
import { getOrCreateSigningLink, resolveSigningToken } from "@/modules/signing/links";
import { guestRejectAction, guestSendOtpAction, guestSignAction, guestVerifyOtpAction } from "@/modules/signing/guest-actions";
import { createSession } from "@/modules/auth/session";
import { sendOtpAction, signContractAction } from "@/modules/signing/actions";
import { getContractPdf, PdfTamperedError } from "@/modules/pdf/service";
import { documentsDir } from "@/lib/storage-paths";
import { GET as guestPdf } from "@/app/api/sign/[token]/pdf/route";
import { env, freshBrowser, makePng, run, uniq } from "../helpers";

let owner: { id: number };
let wsId: number;

async function newContract(title = "قرارداد آزمون") {
  const seller = await ensureClient(wsId, { name: "فروشنده", email: `${uniq("s")}@example.com`, mobile: "09121110001" });
  const buyer = await ensureClient(wsId, { name: "خریدار", email: `${uniq("b")}@example.com`, mobile: "09121110002" });
  const id = await issueContract({
    workspaceId: wsId,
    title,
    bodyHtml: "<h2>موضوع قرارداد</h2><p>این یک <strong>قرارداد</strong> آزمایشی با شماره AMZ-1 و مبلغ ۱۲۰۰۰ تومان است.</p><ul><li>بند اول</li><li>بند دوم</li></ul>",
    customerId: buyer.userId,
    extraSigners: [{ label: "فروشنده", userId: seller.userId }],
    createdBy: owner.id,
  });
  const signers = await getSigners(id);
  return { id, signers };
}

/** مشتری از لینک: OTP می‌گیرد، تأیید می‌کند و امضا می‌کند */
async function guestSign(token: string) {
  const sent = await guestSendOtpAction(token);
  expect(sent.ok).toBe(true);
  expect(sent.devCode).toMatch(/^\d{5}$/);
  const v = await guestVerifyOtpAction(token, sent.devCode!);
  expect(v.ok).toBe(true);
  return guestSignAction(token, { signature: makePng(), method: "draw", agree: true });
}

beforeAll(async () => {
  const [u] = await db.insert(users).values({ name: "مالک", email: `${uniq("o")}@example.com`, mobile: "09120000009", passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() }).returning();
  owner = u;
  wsId = await createWorkspace(u.id, "فضای آزمون");
});
beforeEach(() => freshBrowser());

describe("امضای بدون ثبت‌نام با لینک امن + OTP", () => {
  it("جریان کامل دو امضاکننده تا PDF نهایی با هش", async () => {
    const { id, signers } = await newContract();
    const [first, second] = signers;
    const l1 = (await getOrCreateSigningLink(first.id))!;
    const l2 = (await getOrCreateSigningLink(second.id))!;

    // نوبت: لینک نفر دوم تا امضای نفر اول کار نمی‌کند
    expect((await resolveSigningToken(l2.token)).status).toBe("invalid");
    expect((await resolveSigningToken(l1.token)).status).toBe("ok");

    // بدون OTP امضا ممکن نیست
    const noSession = await guestSignAction(l1.token, { signature: makePng(), method: "draw", agree: true });
    expect(noSession.ok).toBe(false);
    expect(noSession.error).toMatch(/نشست|هویت/);

    // کد غلط رد می‌شود
    const sent = await guestSendOtpAction(l1.token);
    const wrong = sent.devCode === "10000" ? "10001" : "10000";
    expect((await guestVerifyOtpAction(l1.token, wrong)).ok).toBe(false);
    expect((await guestSignAction(l1.token, { signature: makePng(), method: "draw", agree: true })).ok).toBe(false);

    // تأیید درست؛ سپس بدون تیک «مطالعه» رد، و با تیک امضا می‌شود
    expect((await guestVerifyOtpAction(l1.token, sent.devCode!)).ok).toBe(true);
    expect((await guestSignAction(l1.token, { signature: makePng(), method: "draw", agree: false })).ok).toBe(false);
    expect((await guestSignAction(l1.token, { signature: "data:image/png;base64,AAAA", method: "draw", agree: true })).ok).toBe(false);
    const r1 = await guestSignAction(l1.token, { signature: makePng(), method: "draw", agree: true });
    expect(r1).toMatchObject({ ok: true, completed: false });

    // لینک مصرف شد: امضای دوباره ممکن نیست
    expect((await resolveSigningToken(l1.token)).status).toBe("done");
    const again = await guestSignAction(l1.token, { signature: makePng(), method: "draw", agree: true });
    expect(again.ok).toBe(false);

    // نوبت نفر دوم باز شد
    expect((await resolveSigningToken(l2.token)).status).toBe("ok");
    freshBrowser();
    const r2 = await guestSign(l2.token);
    expect(r2).toMatchObject({ ok: true, completed: true });

    // قرارداد نهایی + اثر انگشت + PDF سمت سرور
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c.status).toBe("signed");
    expect(c.docHash).toMatch(/^[a-f0-9]{64}$/);
    const [doc] = await db.select().from(contractDocuments).where(eq(contractDocuments.contractId, id));
    expect(doc).toBeTruthy();
    const file = path.join(documentsDir(), doc.file);
    const buf = fs.readFileSync(file);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(8_000);
    expect(crypto.createHash("sha256").update(buf).digest("hex")).toBe(doc.sha256);
    expect(fs.statSync(file).mode & 0o077).toBe(0); // فقط مالک دسترسی دارد

    // دانلود PDF توسط مشتری بدون حساب (همان مرورگر)
    const res = await guestPdf(new Request("http://x/api"), { params: Promise.resolve({ token: l2.token }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-document-sha256")).toBe(doc.sha256);
    // مرورگر دیگر (بدون نشست OTP) نمی‌تواند PDF بگیرد
    env.cookies.clear();
    expect((await guestPdf(new Request("http://x/api"), { params: Promise.resolve({ token: l2.token }) })).status).toBe(403);

    // دستکاری فایل شناسایی می‌شود
    fs.appendFileSync(file, "tamper");
    await expect(getContractPdf(id)).rejects.toBeInstanceOf(PdfTamperedError);
  });

  it("توکن دستکاری‌شده/ناشناخته نامعتبر است", async () => {
    const { signers } = await newContract();
    const { token } = (await getOrCreateSigningLink(signers[0].id))!;
    expect((await resolveSigningToken(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).status).toBe("invalid");
    expect((await resolveSigningToken("short")).status).toBe("invalid");
    expect((await resolveSigningToken("A".repeat(43))).status).toBe("invalid");
    expect((await guestSendOtpAction("A".repeat(43))).ok).toBe(false);
  });

  it("توکن‌ها فقط به‌صورت هش در دیتابیس هستند", async () => {
    const { signers } = await newContract();
    const { token } = (await getOrCreateSigningLink(signers[0].id))!;
    const rows = await db.select().from(signingLinks).where(eq(signingLinks.signerId, signers[0].id));
    expect(rows.every((r) => r.tokenHash !== token && !r.tokenEnc.includes(token))).toBe(true);
    expect(rows[0].tokenHash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
  });

  it("لینک منقضی‌شده و قرارداد لغوشده امضا نمی‌پذیرد", async () => {
    const a = await newContract();
    const la = (await getOrCreateSigningLink(a.signers[0].id))!;
    await db.update(signingLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(signingLinks.id, la.linkId));
    expect((await resolveSigningToken(la.token)).status).toBe("expired");

    const b = await newContract();
    const lb = (await getOrCreateSigningLink(b.signers[0].id))!;
    await cancelContract(b.id, owner.id, "تست", wsId);
    const st = await resolveSigningToken(lb.token);
    expect(st.status).toBe("closed");
    expect((await guestSendOtpAction(lb.token)).ok).toBe(false);
  });

  it("چرخش لینک: لینک جدید لینک قبلی را باطل می‌کند و لینک فعال دوباره‌استفاده می‌شود", async () => {
    const { signers } = await newContract();
    const a = (await getOrCreateSigningLink(signers[0].id))!;
    const b = (await getOrCreateSigningLink(signers[0].id))!;
    expect(b.token).toBe(a.token); // همان لینک فعال (برای یادآوری‌ها)
    await db.update(signingLinks).set({ expiresAt: new Date(Date.now() + 1000) }).where(eq(signingLinks.id, a.linkId));
    const c = (await getOrCreateSigningLink(signers[0].id))!;
    expect(c.token).not.toBe(a.token);
    expect((await resolveSigningToken(a.token)).status).toBe("invalid");
    expect((await resolveSigningToken(c.token)).status).toBe("ok");
  });

  it("رد قرارداد با لینک: قرارداد رد و لینک باطل می‌شود", async () => {
    const { id, signers } = await newContract();
    const { token } = (await getOrCreateSigningLink(signers[0].id))!;
    const sent = await guestSendOtpAction(token);
    await guestVerifyOtpAction(token, sent.devCode!);
    expect((await guestRejectAction(token, "شرایط قبول نیست")).ok).toBe(true);
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c.status).toBe("rejected");
    expect((await resolveSigningToken(token)).status).toBe("closed");
  });

  it("OTP: ارسال مجدد فوری ممنوع و محدودیت نرخ برقرار است", async () => {
    const { signers } = await newContract();
    const { token } = (await getOrCreateSigningLink(signers[0].id))!;
    expect((await guestSendOtpAction(token)).ok).toBe(true);
    const second = await guestSendOtpAction(token);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/ثانیه/);
  });
});

describe("امضا از طریق حساب کاربری (مسیر قدیمی) هم سالم است", () => {
  it("فقط امضاکننده‌ی نوبت‌دار با OTP می‌تواند امضا کند", async () => {
    const { id, signers } = await newContract();
    // ورود به‌عنوان امضاکننده‌ی دوم (نوبت او نیست)
    const [u2] = await db.select().from(users).where(eq(users.id, signers[1].userId));
    await createSession(u2.id, u2.passwordHash);
    const notTurn = await run(() => sendOtpAction(id));
    expect(notTurn.result?.ok).toBe(false);
    expect(notTurn.result?.error).toMatch(/نوبت/);

    freshBrowser();
    const [u1] = await db.select().from(users).where(eq(users.id, signers[0].userId));
    await createSession(u1.id, u1.passwordHash);
    const sent = await sendOtpAction(id);
    expect(sent.ok).toBe(true);
    const bad = await signContractAction(id, { signature: makePng(), method: "draw", agree: true, code: sent.devCode === "10000" ? "10001" : "10000" });
    expect(bad.ok).toBe(false);
    const good = await signContractAction(id, { signature: makePng(), method: "draw", agree: true, code: sent.devCode! });
    expect(good.ok).toBe(true);
  });
});
