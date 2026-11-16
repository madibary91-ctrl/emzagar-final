import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, contracts, contractSigners, otpCodes, users, workspaceMembers } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { issueContract, getSigners } from "@/modules/contracts/service";
import { createWorkspace, listWorkspaceUsers } from "@/modules/tenancy/service";
import { getMemberships, requireTeam } from "@/modules/tenancy/context";
import { isTeamRole } from "@/modules/tenancy/roles";
import { createInvite, acceptInvite } from "@/modules/tenancy/invites";
import { changeRoleAction, inviteMemberAction } from "@/modules/tenancy/actions";
import { getUsage } from "@/modules/billing/service";
import { ensureGuestSigner, GuestUpgradeError, upgradeGuestToUser } from "@/modules/guests/service";
import { getOrCreateSigningLink, resolveSigningToken } from "@/modules/signing/links";
import { guestSendOtpAction, guestSendReceiptOtpAction, guestSignAction, guestVerifyOtpAction, guestVerifyReceiptOtpAction } from "@/modules/signing/guest-actions";
import { deliverSigningOtp } from "@/modules/signing/otp-delivery";
import { OTP_MAX_SENDS_PER_HOUR } from "@/modules/signing/otp";
import { createSession, getCurrentUser, GuestLoginForbiddenError } from "@/modules/auth/session";
import { GET as guestPdf } from "@/app/api/sign/[token]/pdf/route";
import { env, form, freshBrowser, makePng, run, setIp, uniq } from "../helpers";

const BODY = "<h2>قرارداد</h2><p>این قرارداد میان [USER_NAME] و طرف دیگر منعقد شد و برای همه‌ی طرفین الزام‌آور است.</p>";

let owner: typeof users.$inferSelect;
let wsId: number;
let seq = 0;

async function realUser(name: string, mobile: string, ws?: number) {
  const [u] = await db.insert(users).values({ name, email: `${uniq("r")}@example.com`, mobile, passwordHash: hashPassword("Real123xyz"), role: "user", emailVerifiedAt: new Date() }).returning();
  if (ws) await db.insert(workspaceMembers).values({ workspaceId: ws, userId: u.id, role: "client" });
  return u;
}
const mobileN = () => `0912${String(5550000 + seq++).padStart(7, "0")}`;
const pdfReq = (token: string, headers: Record<string, string> = {}) => guestPdf(new Request(`http://localhost/api/sign/${token}/pdf`, { headers }), { params: Promise.resolve({ token }) });

async function signViaLink(token: string) {
  const sent = await guestSendOtpAction(token);
  expect(sent.ok, JSON.stringify(sent)).toBe(true);
  const v = await guestVerifyOtpAction(token, sent.devCode!);
  expect(v.ok, JSON.stringify(v)).toBe(true);
  const s = await guestSignAction(token, { signature: makePng(), method: "draw", agree: true });
  expect(s.ok, JSON.stringify(s)).toBe(true);
}

beforeAll(async () => {
  const [o] = await db.insert(users).values({ name: "مالک سخت‌سازی", email: `${uniq("own")}@example.com`, mobile: "09120000077", passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() }).returning();
  owner = o;
  wsId = await createWorkspace(o.id, "فضای سخت‌سازی مهمان");
});
beforeEach(() => freshBrowser());

describe("Q3 — عضویت مهمان در workspace_members، شمارش تیم و RBAC", () => {
  it("مهمان فقط نقش client دارد: در تیم، سقف اعضای طرح و فهرست اعضا شمرده نمی‌شود", async () => {
    const before = await getUsage(wsId);
    const g = await ensureGuestSigner(wsId, { name: "مهمان شمارش", mobile: mobileN() });
    await ensureGuestSigner(wsId, { name: "مهمان شمارش دوم", mobile: mobileN() });
    const [m] = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, g.userId));
    expect(m.role).toBe("client");
    expect((await getUsage(wsId)).members).toBe(before.members);
    const all = await listWorkspaceUsers(wsId);
    expect(all.filter((u) => isTeamRole(u.role)).some((u) => u.isGuest)).toBe(false);
    expect(all.filter((u) => u.isGuest).length).toBeGreaterThanOrEqual(2);
    expect((await getMemberships(g.userId)).filter((x) => isTeamRole(x.role))).toEqual([]);
  });

  it("مهمان هیچ نشست پنلی نمی‌گیرد؛ حتی کوکی معتبرِ حسابی که بعداً «مهمان» شد بی‌اثر است", async () => {
    const g = await ensureGuestSigner(wsId, { name: "مهمان نشست", mobile: mobileN() });
    const [row] = await db.select().from(users).where(eq(users.id, g.userId));
    await expect(createSession(row.id, row.passwordHash)).rejects.toBeInstanceOf(GuestLoginForbiddenError);

    const u = await realUser("کاربر عادی", mobileN(), wsId);
    await createSession(u.id, u.passwordHash);
    expect((await getCurrentUser())?.id).toBe(u.id);
    await db.update(users).set({ isGuest: true }).where(eq(users.id, u.id)); // کوکی معتبر + حساب مهمان
    expect(await getCurrentUser()).toBeNull();
    const r = await run(() => requireTeam("view"));
    expect(r.redirect).toBe("/login");
  });

  it("مهمان را نمی‌توان با فرم دست‌ساز به نقش تیمی ارتقا داد، دعوت کرد یا دعوتش را پذیرفت؛ کاربر عادی همچنان قابل ارتقاست", async () => {
    // مالکِ فقط همین فضا، تا فضای تیمی فعال نشست او همین باشد
    const [fresh] = await db.insert(users).values({ name: "مالک RBAC", email: `${uniq("rb")}@example.com`, mobile: "09120000078", passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() }).returning();
    const w2 = await createWorkspace(fresh.id, "RBAC خصوصی");
    await createSession(fresh.id, fresh.passwordHash);

    const g = await ensureGuestSigner(w2, { name: "مهمان RBAC", mobile: mobileN() });
    const real = await realUser("مشتری واقعی", mobileN(), w2);
    const [gm] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.userId, g.userId), eq(workspaceMembers.workspaceId, w2)));
    const [rm] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.userId, real.id), eq(workspaceMembers.workspaceId, w2)));

    await run(() => changeRoleAction(form({ memberId: String(gm.id), role: "admin" })));
    expect((await db.select().from(workspaceMembers).where(eq(workspaceMembers.id, gm.id)))[0].role).toBe("client");
    await run(() => changeRoleAction(form({ memberId: String(rm.id), role: "member" })));
    expect((await db.select().from(workspaceMembers).where(eq(workspaceMembers.id, rm.id)))[0].role).toBe("member");

    const [grow] = await db.select().from(users).where(eq(users.id, g.userId));
    const inv = await run(() => inviteMemberAction({}, form({ email: grow.email, role: "member" })));
    expect((inv.result as { error?: string }).error).toBeTruthy();
    const token = await createInvite(w2, grow.email.toLowerCase(), "member", fresh.id);
    expect(await acceptInvite(token, g.userId)).toBeNull();
    expect((await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.userId, g.userId), eq(workspaceMembers.workspaceId, w2)))).map((m) => m.role)).toEqual(["client"]);
  });
});

describe("Q7 — ایزولاسیون بین فضاهای کاری", () => {
  it("مهمان یک فضا را نمی‌توان طرف قرارداد فضای دیگر کرد", async () => {
    const wsB = await createWorkspace(owner.id, "فضای B");
    const gA = await ensureGuestSigner(wsId, { name: "مهمان فضای الف", mobile: mobileN() });
    await expect(issueContract({ workspaceId: wsB, title: "نشت", bodyHtml: BODY, customerId: gA.userId, createdBy: owner.id })).rejects.toThrow(/فضای کاری/);
  });

  it("نشست OTP و لینک یک مهمان برای مهمان/قرارداد دیگر (حتی فضای دیگر) کاربرد ندارد", async () => {
    const wsB = await createWorkspace(owner.id, "فضای B۲");
    const gA = await ensureGuestSigner(wsId, { name: "مهمان الف", mobile: mobileN() });
    const gB = await ensureGuestSigner(wsB, { name: "مهمان ب", mobile: mobileN() });
    const cA = await issueContract({ workspaceId: wsId, title: "الف", bodyHtml: BODY, customerId: gA.userId, createdBy: owner.id });
    const cB = await issueContract({ workspaceId: wsB, title: "ب", bodyHtml: BODY, customerId: gB.userId, createdBy: owner.id });
    const lA = (await getOrCreateSigningLink((await getSigners(cA))[0].id))!;
    const lB = (await getOrCreateSigningLink((await getSigners(cB))[0].id))!;

    const sent = await guestSendOtpAction(lA.token);
    expect((await guestVerifyOtpAction(lA.token, sent.devCode!)).ok).toBe(true);
    // رونوشت کوکی نشست الف زیر نام کوکی لینک ب
    env.cookies.set(`amz_gs_${lB.linkId}`, env.cookies.get(`amz_gs_${lA.linkId}`)!);
    const stolen = await guestSignAction(lB.token, { signature: makePng(), method: "draw", agree: true });
    expect(stolen.ok).toBe(false);
    expect((await db.select().from(contractSigners).where(eq(contractSigners.contractId, cB)))[0].status).toBe("pending");
    // کد OTP مهمان الف روی لینک ب هم کار نمی‌کند (کد به شناسه‌ی امضاکننده گره خورده)
    const sentB = await guestSendOtpAction(lB.token);
    expect(sentB.ok).toBe(true);
    expect((await guestVerifyOtpAction(lB.token, sent.devCode!)).ok).toBe(false);
    // ولی مهمان الف همچنان می‌تواند قرارداد خودش را امضا کند
    expect((await guestSignAction(lA.token, { signature: makePng(), method: "draw", agree: true })).ok).toBe(true);
  });
});

describe("Q7 — امضای مهمان در «وسط» زنجیره‌ی چندامضاکننده", () => {
  it("فروشنده(حساب) ← ضامن(مهمان) ← خریدار(حساب): رعایت نوبت، بدون PDF/دریافت قبل از پایان، سپس نهایی‌شدن", async () => {
    const r1 = await realUser("فروشنده زنجیره", mobileN(), wsId);
    const r2 = await realUser("خریدار زنجیره", mobileN(), wsId);
    const g = await ensureGuestSigner(wsId, { name: "ضامن میانی", mobile: mobileN() });
    const id = await issueContract({
      workspaceId: wsId,
      title: "زنجیره‌ی سه‌نفره",
      bodyHtml: BODY,
      customerId: r2.id,
      extraSigners: [
        { label: "فروشنده", userId: r1.id },
        { label: "ضامن", userId: g.userId },
      ],
      createdBy: owner.id,
    });
    const [s1, s2, s3] = await getSigners(id);
    expect([s1.userId, s2.userId, s3.userId]).toEqual([r1.id, g.userId, r2.id]);
    const l1 = (await getOrCreateSigningLink(s1.id))!;
    const l2 = (await getOrCreateSigningLink(s2.id))!;
    const l3 = (await getOrCreateSigningLink(s3.id))!;

    // هنوز نوبت مهمان نیست: لینک نامعتبر است و هیچ OTP/امضایی پذیرفته نمی‌شود
    expect((await resolveSigningToken(l2.token)).status).toBe("invalid");
    expect((await guestSendOtpAction(l2.token)).ok).toBe(false);
    expect((await guestSignAction(l2.token, { signature: makePng(), method: "draw", agree: true })).ok).toBe(false);
    expect((await db.select().from(otpCodes).where(eq(otpCodes.signerId, s2.id))).length).toBe(0);

    await signViaLink(l1.token);
    expect((await resolveSigningToken(l2.token)).status).toBe("ok");
    expect((await resolveSigningToken(l3.token)).status).toBe("invalid"); // خریدار هنوز منتظر ضامن است

    // مهمان بدون OTP نمی‌تواند امضا کند، حتی وقتی نوبتش رسیده
    expect((await guestSignAction(l2.token, { signature: makePng(), method: "draw", agree: true })).ok).toBe(false);
    await signViaLink(l2.token);
    expect((await db.select().from(contracts).where(eq(contracts.id, id)))[0].status).toBe("sent");

    // وسط زنجیره: «دریافت نسخه‌ی نهایی» و PDF برای ضامن ممنوع است
    expect((await resolveSigningToken(l2.token)).status).toBe("done");
    expect((await guestSendReceiptOtpAction(l2.token)).ok).toBe(false);
    expect((await pdfReq(l2.token)).status).toBe(403);
    expect((await resolveSigningToken(l3.token)).status).toBe("ok");

    await signViaLink(l3.token);
    expect((await db.select().from(contracts).where(eq(contracts.id, id)))[0].status).toBe("signed");
    expect((await db.select().from(contractSigners).where(eq(contractSigners.contractId, id))).every((s) => s.status === "signed")).toBe(true);
  });
});

describe("Q7 — دریافت مجدد PDF، OTP نامعتبر و ادامه‌ی دانلود", () => {
  let token = "";
  let signerId = 0;
  let contractId = 0;

  const backdateOtps = () => db.execute(sql`update otp_codes set created_at = now() - interval '10 minutes' where signer_id = ${signerId}`);

  it("آماده‌سازی: مهمان قرارداد را امضا می‌کند و قرارداد نهایی می‌شود", async () => {
    const g = await ensureGuestSigner(wsId, { name: "مهمان دریافت", mobile: mobileN() });
    contractId = await issueContract({ workspaceId: wsId, title: "دریافت مجدد", bodyHtml: BODY, customerId: g.userId, createdBy: owner.id });
    const [s] = await getSigners(contractId);
    signerId = s.id;
    token = (await getOrCreateSigningLink(s.id))!.token;
    await signViaLink(token);
    expect((await db.select().from(contracts).where(eq(contracts.id, contractId)))[0].status).toBe("signed");
  });

  it("OTP نامعتبر: بدون درخواست قبلی، فاصله‌ی ارسال مجدد، کد غلط، منقضی، سقف تلاش، استفاده‌ی دوباره", async () => {
    freshBrowser();
    expect((await pdfReq(token)).status).toBe(403); // نشست ندارد
    // کد قبلی (امضا) مصرف شده؛ کدی فعال نیست
    expect((await guestVerifyReceiptOtpAction(token, "12345")).ok).toBe(false);
    // ارسال بلافاصله پس از کد قبلی: فاصله‌ی ارسال مجدد
    const tooSoon = await guestSendReceiptOtpAction(token);
    expect(tooSoon.ok).toBe(false);
    expect(tooSoon.seconds).toBeGreaterThan(0);

    await backdateOtps();
    const s1 = await guestSendReceiptOtpAction(token);
    expect(s1.ok).toBe(true);
    // منقضی
    await db.execute(sql`update otp_codes set expires_at = now() - interval '1 minute' where signer_id = ${signerId} and used_at is null`);
    const exp = await guestVerifyReceiptOtpAction(token, s1.devCode!);
    expect(exp.ok).toBe(false);
    expect(exp.error).toContain("منقضی");

    await backdateOtps();
    const s2 = await guestSendReceiptOtpAction(token);
    expect(s2.ok).toBe(true);
    const wrong = s2.devCode === "11111" ? "22222" : "11111";
    for (let i = 0; i < 5; i++) expect((await guestVerifyReceiptOtpAction(token, wrong)).ok).toBe(false);
    // پس از ۵ تلاش غلط، حتی کد درست همان OTP رد می‌شود
    const locked = await guestVerifyReceiptOtpAction(token, s2.devCode!);
    expect(locked.ok).toBe(false);
    expect(locked.error).toContain("تلاش");
    expect((await pdfReq(token)).status).toBe(403);
  });

  it("از سرگیری: OTP تازه ← نشست ← PDF؛ دانلود نیمه‌کاره با Range ادامه می‌یابد؛ کد مصرف‌شده دوباره کار نمی‌کند", async () => {
    freshBrowser();
    await backdateOtps();
    const s = await guestSendReceiptOtpAction(token);
    expect(s.ok).toBe(true);
    expect((await guestVerifyReceiptOtpAction(token, s.devCode!)).ok).toBe(true);
    expect((await guestVerifyReceiptOtpAction(token, s.devCode!)).ok).toBe(false); // یک‌بارمصرف

    const full = await pdfReq(token);
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    const etag = full.headers.get("etag")!;
    const all = Buffer.from(await full.arrayBuffer());
    expect(all.subarray(0, 5).toString()).toBe("%PDF-");
    expect(all.length).toBeGreaterThan(1000);

    // قطع شدن اتصال بعد از ۵۰۰ بایت ← ادامه از همان بایت
    const first = await pdfReq(token, { range: "bytes=0-499" });
    expect(first.status).toBe(206);
    expect(first.headers.get("content-range")).toBe(`bytes 0-499/${all.length}`);
    const rest = await pdfReq(token, { range: "bytes=500-", "if-range": etag });
    expect(rest.status).toBe(206);
    expect(Buffer.concat([Buffer.from(await first.arrayBuffer()), Buffer.from(await rest.arrayBuffer())]).equals(all)).toBe(true);

    expect((await pdfReq(token, { range: `bytes=${all.length + 10}-` })).status).toBe(416);
    // If-Range ناهمخوان (فایل عوض شده) ← فایل کامل
    const changed = await pdfReq(token, { range: "bytes=0-9", "if-range": '"other"' });
    expect(changed.status).toBe(200);
    expect(Buffer.from(await changed.arrayBuffer()).length).toBe(all.length);

    // نشست پاک شد (مرورگر تازه) ← دوباره ۴۰۳ تا OTP جدید
    env.cookies.clear();
    expect((await pdfReq(token, { range: "bytes=0-9" })).status).toBe(403);
  });
});

describe("Q5 — محدودیت نرخ OTP و ردپای IP/User-Agent", () => {
  it("سقف پایدار ارسال در ساعت (در دیتابیس، مستقل از حافظه‌ی فرایند) + فاصله‌ی ارسال مجدد", async () => {
    const g = await ensureGuestSigner(wsId, { name: "مهمان سقف", mobile: mobileN() });
    const id = await issueContract({ workspaceId: wsId, title: "سقف OTP", bodyHtml: BODY, customerId: g.userId, createdBy: owner.id });
    const [s] = await getSigners(id);
    const [user] = await db.select().from(users).where(eq(users.id, g.userId));
    const call = () => deliverSigningOtp({ contractId: id, workspaceId: wsId, signer: { id: s.id }, user });

    for (let i = 0; i < OTP_MAX_SENDS_PER_HOUR; i++) {
      const r = await call();
      expect(r.ok, `ارسال ${i + 1}`).toBe(true);
      const again = await call(); // بلافاصله: فاصله‌ی ارسال مجدد
      expect(again.ok).toBe(false);
      expect(again.seconds).toBeGreaterThan(0);
      await db.execute(sql`update otp_codes set created_at = now() - interval '5 minutes' where signer_id = ${s.id}`);
    }
    const blocked = await call();
    expect(blocked.ok).toBe(false);
    expect(blocked.seconds).toBeUndefined();
    expect(blocked.error).toContain("ساعت");
    expect((await db.select().from(otpCodes).where(eq(otpCodes.signerId, s.id))).length).toBe(OTP_MAX_SENDS_PER_HOUR);
    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.contractId, id), eq(auditLogs.action, "otp.failed")));
    expect(logs.some((l) => l.detail.includes("سقف ارسال"))).toBe(true);

    // یک ساعت بعد دوباره آزاد می‌شود
    await db.execute(sql`update otp_codes set created_at = now() - interval '61 minutes' where signer_id = ${s.id}`);
    expect((await call()).ok).toBe(true);
  });

  it("IP و User-Agent مهمان در همه‌ی رویدادهای OTP و امضا (ممیزی + ردیف امضاکننده) ثبت می‌شود", async () => {
    setIp("203.0.113.77");
    env.headers.set("user-agent", "EmzagarTest/9.9 (GuestPhone)");
    const g = await ensureGuestSigner(wsId, { name: "مهمان ردپا", mobile: mobileN() });
    const id = await issueContract({ workspaceId: wsId, title: "ردپا", bodyHtml: BODY, customerId: g.userId, createdBy: owner.id });
    const [s] = await getSigners(id);
    const t = (await getOrCreateSigningLink(s.id))!.token;
    const sent = await guestSendOtpAction(t);
    expect((await guestVerifyOtpAction(t, sent.devCode === "11111" ? "22222" : "11111")).ok).toBe(false);
    expect((await guestVerifyOtpAction(t, sent.devCode!)).ok).toBe(true);
    expect((await guestSignAction(t, { signature: makePng(), method: "draw", agree: true })).ok).toBe(true);

    const logs = await db.select().from(auditLogs).where(eq(auditLogs.contractId, id));
    for (const action of ["otp.sent", "otp.failed", "otp.verified", "contract.signed"]) {
      const rows = logs.filter((l) => l.action === action);
      expect(rows.length, action).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.ip, action).toBe("203.0.113.77");
        expect(r.userAgent, action).toBe("EmzagarTest/9.9 (GuestPhone)");
      }
    }
    const [row] = await db.select().from(contractSigners).where(eq(contractSigners.id, s.id));
    expect(row.ip).toBe("203.0.113.77");
    expect(row.userAgent).toBe("EmzagarTest/9.9 (GuestPhone)");
    expect(row.otpVerifiedAt).not.toBeNull();
    expect(row.mobile).toBe((await db.select().from(users).where(eq(users.id, g.userId)))[0].mobile);
    env.headers.set("user-agent", "vitest");
  });
});

describe("Q4 — ارتقای مهمان به کاربر واقعی با حفظ همان رکورد", () => {
  it("همان users.id، تاریخچه‌ی امضا/ممیزی/عضویت حفظ و از آن پس می‌تواند نشست بگیرد", async () => {
    const mobile = mobileN();
    const g = await ensureGuestSigner(wsId, { name: "مهمان ارتقا", mobile });
    const id = await issueContract({ workspaceId: wsId, title: "پیش از ارتقا", bodyHtml: BODY, customerId: g.userId, createdBy: owner.id });
    const [s] = await getSigners(id);
    await signViaLink((await getOrCreateSigningLink(s.id))!.token);
    const auditBefore = (await db.select().from(auditLogs).where(eq(auditLogs.userId, g.userId))).length;
    expect(auditBefore).toBeGreaterThan(0);

    const email = `${uniq("up")}@Example.com`;
    const hash = hashPassword("Upgraded123");
    const r = await upgradeGuestToUser(g.userId, { email, passwordHash: hash, verifiedMobile: mobile });
    expect(r.userId).toBe(g.userId);

    const [u] = await db.select().from(users).where(eq(users.id, g.userId));
    expect(u.isGuest).toBe(false);
    expect(u.email).toBe(email.toLowerCase());
    expect(u.mobile).toBe(mobile);
    expect(u.emailVerifiedAt).toBeNull(); // تأیید ایمیل هنوز لازم است
    // تاریخچه
    const [signer] = await db.select().from(contractSigners).where(eq(contractSigners.id, s.id));
    expect(signer.userId).toBe(g.userId);
    expect(signer.status).toBe("signed");
    expect((await db.select().from(auditLogs).where(eq(auditLogs.userId, g.userId))).length).toBeGreaterThanOrEqual(auditBefore);
    const [m] = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, g.userId));
    expect([m.workspaceId, m.role]).toEqual([wsId, "client"]);
    expect((await db.select().from(auditLogs).where(and(eq(auditLogs.userId, g.userId), eq(auditLogs.action, "guest.upgraded")))).length).toBe(1);
    // دیگر مهمان نیست ← مانعِ نشست برداشته می‌شود
    await expect(createSession(u.id, u.passwordHash)).resolves.toBeUndefined();
  });

  it("محافظ‌ها: دوباره‌ارتقا، حساب واقعی، موبایل نامطابق، ایمیل تکراری/نامعتبر؛ و ارتقای هم‌زمان فقط یک‌بار موفق است", async () => {
    const mobile = mobileN();
    const g = await ensureGuestSigner(wsId, { name: "مهمان محافظ", mobile });
    const ok = { passwordHash: hashPassword("Upgraded123") };
    const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as GuestUpgradeError | null)?.code ?? "ok";

    expect(await code(upgradeGuestToUser(g.userId, { ...ok, email: `${uniq("a")}@example.com`, verifiedMobile: "09129999999" }))).toBe("mobile_mismatch");
    expect(await code(upgradeGuestToUser(g.userId, { ...ok, email: owner.email, verifiedMobile: mobile }))).toBe("email_taken");
    expect(await code(upgradeGuestToUser(g.userId, { ...ok, email: "not-an-email", verifiedMobile: mobile }))).toBe("invalid_email");
    expect(await code(upgradeGuestToUser(g.userId, { ...ok, email: "x@guest.emzagar.invalid", verifiedMobile: mobile }))).toBe("invalid_email");
    expect(await code(upgradeGuestToUser(owner.id, { ...ok, email: `${uniq("b")}@example.com`, verifiedMobile: owner.mobile }))).toBe("not_guest");
    expect((await db.select().from(users).where(eq(users.id, g.userId)))[0].isGuest).toBe(true); // خطاها چیزی را تغییر ندادند

    const results = await Promise.all([
      code(upgradeGuestToUser(g.userId, { ...ok, email: `${uniq("c")}@example.com`, verifiedMobile: mobile })),
      code(upgradeGuestToUser(g.userId, { ...ok, email: `${uniq("d")}@example.com`, verifiedMobile: mobile })),
    ]);
    expect(results.sort()).toEqual(["not_guest", "ok"]);
    expect(await code(upgradeGuestToUser(g.userId, { ...ok, email: `${uniq("e")}@example.com`, verifiedMobile: mobile }))).toBe("not_guest");
  });
});
