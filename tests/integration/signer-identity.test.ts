import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, contractSigners, signerIdentities, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { issueContract, getSigners } from "@/modules/contracts/service";
import { createWorkspace } from "@/modules/tenancy/service";
import { ensureGuestSigner } from "@/modules/guests/service";
import { getOrCreateSigningLink } from "@/modules/signing/links";
import { guestSendOtpAction, guestSignAction, guestVerifyOtpAction } from "@/modules/signing/guest-actions";
import { guestVerifyShahkarAction } from "@/modules/identity/actions";
import { guestActor } from "@/modules/identity/actor";
import { assuranceForContract, getGateView, identityGate, readDocument, resetAttempts, reviewDocuments, setRequirement, submitDocuments } from "@/modules/identity/service";
import { MAX_SHAHKAR_ATTEMPTS, assuranceText, suggestIdentity } from "@/modules/identity/rules";
import { freshBrowser, makeNationalCode, makePng, setIp, uniq } from "../helpers";

let owner: { id: number };
let wsId: number;
let otherWs: number;
let mobileSeq = 100;

/** کد ملی معتبری که رقم آخرش d است (حالت آزمایشی: تطبیق ⇔ رقم آخر موبایل = رقم آخر کد ملی) */
function ncEndingWith(d: number): string {
  for (let i = 0; i < 2000; i++) {
    const nc = makeNationalCode(String(100000000 + i * 7919).slice(0, 9));
    if (Number(nc[9]) === d) return nc;
  }
  throw new Error("no nc");
}
const newMobile = (lastDigit: number) => `0912${String(++mobileSeq).padStart(6, "0").slice(0, 6)}${lastDigit}`.slice(0, 11);

async function issue(opts: { lastDigit: number; req: "none" | "shahkar" | "document" | "both"; expectedNc?: string; title?: string }) {
  const g = await ensureGuestSigner(wsId, { name: "امضاکننده نمونه", mobile: newMobile(opts.lastDigit) });
  const id = await issueContract({
    workspaceId: wsId,
    title: opts.title ?? "قرارداد حساس",
    bodyHtml: "<p>این قرارداد برای آزمون تأیید هویت امضاکننده تنظیم شده و متن آن به‌اندازه‌ی کافی بلند است.</p>",
    customerId: g.userId,
    createdBy: owner.id,
    identity: opts.req === "none" ? undefined : { req: opts.req, expectedNc: opts.expectedNc },
  });
  const [signer] = await getSigners(id);
  return { id, signer, userId: g.userId };
}

async function otpSession(signerId: number) {
  freshBrowser();
  const link = (await getOrCreateSigningLink(signerId))!;
  const sent = await guestSendOtpAction(link.token);
  expect(sent.ok).toBe(true);
  expect((await guestVerifyOtpAction(link.token, sent.devCode!)).ok).toBe(true);
  return link.token;
}
const sign = (token: string) => guestSignAction(token, { signature: makePng(), method: "draw", agree: true });
const png = () => Buffer.from(makePng().split(",")[1], "base64");

beforeAll(async () => {
  const [u] = await db.insert(users).values({ name: "مالک هویت", email: `${uniq("idn")}@example.com`, mobile: "09120000077", passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() }).returning();
  owner = u;
  wsId = await createWorkspace(u.id, "فضای هویت");
  otherWs = await createWorkspace(u.id, "فضای دیگر هویت");
});
let ipSeq = 0;
beforeEach(() => {
  freshBrowser();
  setIp(`10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`); // سقف نرخ هر IP بین آزمون‌ها مستقل بماند
});

describe("قواعد خالص و پیشنهاد هوشمند", () => {
  it("اسناد روزمره پیشنهادی نمی‌گیرند؛ معاملات حساس و پرمبلغ می‌گیرند", () => {
    expect(suggestIdentity({ title: "رضایت‌نامه‌ی عکاسی", bodyHtml: "<p>متن ساده</p>", value: 0 })).toBeNull();
    expect(suggestIdentity({ title: "قرارداد فروش خودرو", bodyHtml: "", value: 0 })?.req).toBe("shahkar");
    expect(suggestIdentity({ title: "تعهد", bodyHtml: "", value: 2_000_000_000 })?.req).toBe("both");
    expect(suggestIdentity({ title: "اجاره‌نامه", bodyHtml: "", value: 300_000_000 })?.req).toBe("both");
    expect(assuranceText("none")).toBe("");
    expect(assuranceText("shahkar", { sandbox: true })).toContain("آزمایشی");
  });
});

describe("مسیر عادی دست‌نخورده است", () => {
  it("سطح none: بدون هیچ مرحله‌ی اضافه امضا می‌شود و شواهدی ساخته نمی‌شود", async () => {
    const c = await issue({ lastDigit: 1, req: "none" });
    expect(c.signer.identityReq).toBe("none");
    expect(await getGateView(c.signer.id, "09120000001")).toBeNull();
    const token = await otpSession(c.signer.id);
    expect((await sign(token)).ok).toBe(true);
    const [row] = await db.select().from(contractSigners).where(eq(contractSigners.id, c.signer.id));
    expect(row.identityAssurance).toBe("none");
    expect(await db.select().from(signerIdentities).where(eq(signerIdentities.signerId, c.signer.id))).toHaveLength(0);
  });
});

describe("سطح «شاهکار»", () => {
  it("بدون تأیید هویت امضا ممنوع است (سد سمت سرور)؛ پس از تطبیق موبایل ↔ کد ملی مجاز و به امضا گره می‌خورد", async () => {
    const nc = ncEndingWith(3);
    const c = await issue({ lastDigit: 3, req: "shahkar", expectedNc: nc });
    const token = await otpSession(c.signer.id);

    const blocked = await sign(token);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/تأیید هویت/);

    // کد ملی معتبر ولی غیر از کد ملی اعلام‌شده‌ی صادرکننده
    const other = ncEndingWith(5);
    const wrong = await guestVerifyShahkarAction(token, other);
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toMatch(/مطابقت ندارد/);
    // کد ملی با رقم کنترل نادرست: تلاش مصرف نمی‌کند
    expect((await guestVerifyShahkarAction(token, "1234567890")).ok).toBe(false);

    const ok = await guestVerifyShahkarAction(token, nc);
    expect(ok.ok, ok.error).toBe(true);
    const view = await getGateView(c.signer.id, (await db.select().from(users).where(eq(users.id, c.userId)))[0].mobile);
    expect(view?.met).toBe(true);

    const signed = await sign(token);
    expect(signed.ok, signed.error).toBe(true);
    const [row] = await db.select().from(contractSigners).where(eq(contractSigners.id, c.signer.id));
    expect(row.identityAssurance).toBe("shahkar");
    const [idRow] = await db.select().from(signerIdentities).where(eq(signerIdentities.signerId, c.signer.id));
    expect(idRow.sealHash).toMatch(/^[0-9a-f]{64}$/);
    expect(idRow.ncEnc).not.toContain(nc); // رمزنگاری‌شده
    expect((await assuranceForContract(c.id)).get(c.signer.id)?.assurance).toBe("shahkar");
    const actions = (await db.select().from(auditLogs).where(eq(auditLogs.contractId, c.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["identity.required", "identity.mismatch", "identity.shahkar_matched", "identity.bound"]));
  });

  it("عدم تطابق سیم‌کارت با کد ملی: امضا باز نمی‌شود، سقف تلاش اتمیک است و صادرکننده می‌تواند بازنشانی کند", async () => {
    const nc = ncEndingWith(4);
    const c = await issue({ lastDigit: 9, req: "shahkar" }); // بدون کد ملی مورد انتظار؛ رقم آخر موبایل ≠ رقم آخر کد ملی
    const token = await otpSession(c.signer.id);
    for (let i = 0; i < MAX_SHAHKAR_ATTEMPTS; i++) {
      const r = await guestVerifyShahkarAction(token, nc);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/به نام این کد ملی ثبت نشده/);
    }
    const locked = await guestVerifyShahkarAction(token, nc);
    expect(locked.error).toMatch(/تعداد تلاش/);
    expect((await sign(token)).ok).toBe(false);
    const [row] = await db.select().from(signerIdentities).where(eq(signerIdentities.signerId, c.signer.id));
    expect(row.shahkarStatus).toBe("mismatch");
    expect(row.attempts).toBe(MAX_SHAHKAR_ATTEMPTS);

    expect((await resetAttempts({ signerId: c.signer.id, contractId: c.id, workspaceId: otherWs, actorId: owner.id })).ok).toBe(false);
    expect((await resetAttempts({ signerId: c.signer.id, contractId: c.id, workspaceId: wsId, actorId: owner.id })).ok).toBe(true);
    const [after] = await db.select().from(signerIdentities).where(eq(signerIdentities.signerId, c.signer.id));
    expect(after.attempts).toBe(0);
  });

  it("تغییر شماره‌ی موبایل پس از تأیید، تأیید را باطل می‌کند", async () => {
    const nc = ncEndingWith(6);
    const c = await issue({ lastDigit: 6, req: "shahkar" });
    const token = await otpSession(c.signer.id);
    expect((await guestVerifyShahkarAction(token, nc)).ok).toBe(true);
    const [u] = await db.select().from(users).where(eq(users.id, c.userId));
    expect((await identityGate(c.signer.id, u.mobile)).error).toBeNull();
    expect((await identityGate(c.signer.id, "09129999999")).error).toMatch(/تأیید هویت/);
  });

  it("ایمنی: امضاکننده‌ی دیگری یا لینک بدون OTP نمی‌تواند استعلام بزند", async () => {
    const c = await issue({ lastDigit: 2, req: "shahkar" });
    freshBrowser();
    const link = (await getOrCreateSigningLink(c.signer.id))!;
    expect((await guestVerifyShahkarAction(link.token, ncEndingWith(2))).ok).toBe(false); // بدون نشست OTP
    expect((await guestActor("x".repeat(43))).ok).toBe(false);
  });
});

describe("سطح «مدارک هویتی» و «حداکثر امنیت»", () => {
  it("مدارک ← در انتظار ← رد با دلیل ← ارسال دوباره ← تأیید ← امضا؛ تصویر فقط برای تیم همان فضا", async () => {
    const nc = ncEndingWith(7);
    const c = await issue({ lastDigit: 7, req: "document", expectedNc: nc });
    const token = await otpSession(c.signer.id);
    const actor = await guestActor(token);
    expect(actor.ok).toBe(true);
    if (!actor.ok) return;

    // فایل غیرتصویری (PDF) و کد ملی نامطابق رد می‌شود
    expect((await submitDocuments(actor.ctx, { nationalCode: nc, idCard: { name: "a.pdf", buffer: Buffer.from("%PDF-1.4 fake") }, selfie: { name: "s.png", buffer: png() } })).ok).toBe(false);
    expect((await submitDocuments(actor.ctx, { nationalCode: ncEndingWith(1), idCard: { name: "a.png", buffer: png() }, selfie: { name: "s.png", buffer: png() } })).ok).toBe(false);

    expect((await submitDocuments(actor.ctx, { nationalCode: nc, idCard: { name: "a.png", buffer: png() }, selfie: { name: "s.png", buffer: png() } })).ok).toBe(true);
    expect((await sign(token)).ok).toBe(false); // هنوز تأیید نشده
    expect((await submitDocuments(actor.ctx, { nationalCode: nc, idCard: { name: "a.png", buffer: png() }, selfie: { name: "s.png", buffer: png() } })).ok).toBe(false); // دوباره در حال بررسی

    expect((await readDocument(c.signer.id, wsId, "id"))?.mime).toBe("image/png");
    expect(await readDocument(c.signer.id, otherWs, "id")).toBeNull();
    const [raw] = await db.select().from(signerIdentities).where(eq(signerIdentities.signerId, c.signer.id));
    expect(raw.idFile).toMatch(/\.enc$/);

    // رد بدون دلیل ممنوع؛ رد با دلیل ← ارسال مجدد
    const base = { signerId: c.signer.id, contractId: c.id, workspaceId: wsId, reviewerId: owner.id };
    expect((await reviewDocuments({ ...base, decision: "reject" })).ok).toBe(false);
    expect((await reviewDocuments({ ...base, workspaceId: otherWs, decision: "approve" })).ok).toBe(false);
    expect((await reviewDocuments({ ...base, decision: "reject", reason: "عکس ناخوانا است" })).ok).toBe(true);
    const [u] = await db.select().from(users).where(eq(users.id, c.userId));
    expect((await getGateView(c.signer.id, u.mobile))?.docRejectReason).toBe("عکس ناخوانا است");
    expect((await submitDocuments(actor.ctx, { nationalCode: nc, idCard: { name: "a.png", buffer: png() }, selfie: { name: "s.png", buffer: png() } })).ok).toBe(true);
    expect((await reviewDocuments({ ...base, decision: "approve" })).ok).toBe(true);

    const signed = await sign(token);
    expect(signed.ok, signed.error).toBe(true);
    const [row] = await db.select().from(contractSigners).where(eq(contractSigners.id, c.signer.id));
    expect(row.identityAssurance).toBe("document");
  });

  it("both: هر دو شرط لازم است", async () => {
    const nc = ncEndingWith(8);
    const c = await issue({ lastDigit: 8, req: "both", expectedNc: nc });
    const token = await otpSession(c.signer.id);
    const actor = await guestActor(token);
    if (!actor.ok) throw new Error("actor");
    expect((await guestVerifyShahkarAction(token, nc)).ok).toBe(true);
    expect((await sign(token)).ok).toBe(false); // مدارک هنوز نیست
    // کد ملی خالی با شاهکارِ تأییدشده: همان کد قبلی استفاده می‌شود
    expect((await submitDocuments(actor.ctx, { nationalCode: "", idCard: { name: "a.png", buffer: png() }, selfie: { name: "s.png", buffer: png() } })).ok).toBe(true);
    expect((await reviewDocuments({ signerId: c.signer.id, contractId: c.id, workspaceId: wsId, reviewerId: owner.id, decision: "approve" })).ok).toBe(true);
    expect((await sign(token)).ok).toBe(true);
    expect((await assuranceForContract(c.id)).get(c.signer.id)?.assurance).toBe("both");
  });
});

describe("تعیین سطح توسط صادرکننده", () => {
  it("فقط تا پیش از امضای همان نفر، فقط در فضای کاری خودش؛ کد ملی نامعتبر رد می‌شود؛ تغییر کد ملی شواهد را بازنشانی می‌کند", async () => {
    const c = await issue({ lastDigit: 0, req: "none" });
    const base = { contractId: c.id, signerId: c.signer.id, actorId: owner.id };
    expect((await setRequirement({ ...base, workspaceId: otherWs, req: "document" })).ok).toBe(false);
    expect((await setRequirement({ ...base, workspaceId: wsId, req: "document", expectedNc: "1234567890" })).ok).toBe(false);
    expect((await setRequirement({ ...base, workspaceId: wsId, req: "document", expectedNc: ncEndingWith(2) })).ok).toBe(true);
    const [row] = await db.select().from(contractSigners).where(eq(contractSigners.id, c.signer.id));
    expect(row.identityReq).toBe("document");

    // ارتقا به none مجاز است (تصمیم صادرکننده) و ثبت ممیزی می‌شود
    expect((await setRequirement({ ...base, workspaceId: wsId, req: "none" })).ok).toBe(true);
    const token = await otpSession(c.signer.id);
    expect((await sign(token)).ok).toBe(true);
    // پس از امضا تغییرناپذیر
    expect((await setRequirement({ ...base, workspaceId: wsId, req: "both" })).ok).toBe(false);
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.contractId, c.id), eq(auditLogs.action, "identity.required")));
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it("صدور با کد ملی نامعتبر کل صدور را برمی‌گرداند (اتمی)", async () => {
    const g = await ensureGuestSigner(wsId, { name: "امضاکننده خراب", mobile: newMobile(1) });
    await expect(
      issueContract({ workspaceId: wsId, title: "ناموفق", bodyHtml: "<p>متن آزمایشی بلند برای قرارداد ناموفق در آزمون هویت</p>", customerId: g.userId, createdBy: owner.id, identity: { req: "shahkar", expectedNc: "1111111112" } }),
    ).rejects.toThrow(/کد ملی/);
  });
});
