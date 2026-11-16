import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts, otpCodes, users, workspaceMembers } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { issueContract, getSigners } from "@/modules/contracts/service";
import { createWorkspace } from "@/modules/tenancy/service";
import { ensureGuestSigner, GuestError, isGuestEmail, normalizeMobile } from "@/modules/guests/service";
import { getOrCreateSigningLink, resolveSigningToken } from "@/modules/signing/links";
import { guestSendOtpAction, guestSendReceiptOtpAction, guestSignAction, guestVerifyOtpAction, guestVerifyReceiptOtpAction } from "@/modules/signing/guest-actions";
import { loginAction, forgotPasswordAction } from "@/modules/auth/actions";
import { GET as guestPdf } from "@/app/api/sign/[token]/pdf/route";
import { freshBrowser, form, makePng, run, uniq } from "../helpers";

let owner: { id: number };
let wsId: number;
let otherWs: number;

beforeAll(async () => {
  const [u] = await db.insert(users).values({ name: "مالک", email: `${uniq("o")}@example.com`, mobile: "09120000019", passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() }).returning();
  owner = u;
  wsId = await createWorkspace(u.id, "فضای مهمان");
  otherWs = await createWorkspace(u.id, "فضای دیگر");
});
beforeEach(() => freshBrowser());

describe("امضاکننده‌ی مهمان (بدون حساب کاربری)", () => {
  it("نرمال‌سازی موبایل و اعتبارسنجی", async () => {
    expect(normalizeMobile("۰۹۱۲۳۴۵۶۷۸۹")).toBe("09123456789");
    expect(normalizeMobile("+98 912 345 6789")).toBe("09123456789");
    expect(normalizeMobile("9123456789")).toBe("09123456789");
    expect(normalizeMobile("12345")).toBeNull();
    await expect(ensureGuestSigner(wsId, { name: "ع", mobile: "09123456789" })).rejects.toBeInstanceOf(GuestError);
    await expect(ensureGuestSigner(wsId, { name: "علی رضایی", mobile: "123" })).rejects.toBeInstanceOf(GuestError);
  });

  it("هویت سبک: بدون ایمیل واقعی، با تکرارپذیری در همان فضای کاری و جدا بین فضاها", async () => {
    const a = await ensureGuestSigner(wsId, { name: "علی رضایی", mobile: "۰۹۱۲۱۱۱۲۲۳۳" });
    const again = await ensureGuestSigner(wsId, { name: "علی  رضایی", mobile: "09121112233" });
    expect(a.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.userId).toBe(a.userId);
    const other = await ensureGuestSigner(otherWs, { name: "علی رضایی", mobile: "09121112233" });
    expect(other.userId).not.toBe(a.userId);

    const [row] = await db.select().from(users).where(eq(users.id, a.userId));
    expect(row.isGuest).toBe(true);
    expect(isGuestEmail(row.email)).toBe(true);
    const [member] = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, a.userId));
    expect(member.role).toBe("client");
    expect(member.workspaceId).toBe(wsId);
  });

  it("مهمان نمی‌تواند وارد شود یا رمز بازیابی کند", async () => {
    const g = await ensureGuestSigner(wsId, { name: "مهمان ورود", mobile: "09121110099" });
    const [row] = await db.select().from(users).where(eq(users.id, g.userId));
    const login = await run(() => loginAction({}, form({ email: row.email, password: "Anything123x" })));
    expect(login.result?.error).toBeTruthy();
    const forgot = await run(() => forgotPasswordAction({}, form({ email: row.email })));
    expect((forgot.result as { devLink?: string }).devLink).toBeUndefined();
  });

  it("جریان کامل: دو مهمان ← OTP ← امضا ← PDF نهایی ← دریافت دوباره با OTP", async () => {
    const guarantor = await ensureGuestSigner(wsId, { name: "ضامن نمونه", mobile: "09121110011" });
    const buyer = await ensureGuestSigner(wsId, { name: "خریدار نمونه", mobile: "09121110022" });
    const id = await issueContract({
      workspaceId: wsId,
      title: "قرارداد مهمان",
      bodyHtml: "<h2>قرارداد</h2><p>این قرارداد میان [USER_NAME] و ضامن منعقد شد و برای هر دو طرف الزام‌آور است.</p>",
      customerId: buyer.userId,
      extraSigners: [{ label: "ضامن", userId: guarantor.userId }],
      createdBy: owner.id,
    });
    const [first, second] = await getSigners(id);
    const l1 = (await getOrCreateSigningLink(first.id))!;
    const l2 = (await getOrCreateSigningLink(second.id))!;

    // نوبت: مشتری نمی‌تواند پیش از ضامن امضا کند
    expect((await resolveSigningToken(l2.token)).status).toBe("invalid");

    for (const t of [l1.token, l2.token]) {
      const sent = await guestSendOtpAction(t);
      expect(sent.ok).toBe(true);
      expect((await guestVerifyOtpAction(t, "00000")).ok).toBe(false);
      const ok = await guestVerifyOtpAction(t, sent.devCode!);
      expect(ok.ok).toBe(true);
      const signed = await guestSignAction(t, { signature: makePng(), method: "draw", agree: true });
      expect(signed.ok).toBe(true);
    }
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    expect(c.status).toBe("signed");

    // مرورگر تازه: بدون OTP دانلود ممنوع
    freshBrowser();
    const req = new Request(`http://localhost/api/sign/${l2.token}/pdf`);
    expect((await guestPdf(req, { params: Promise.resolve({ token: l2.token }) })).status).toBe(403);

    // دریافت نسخه‌ی نهایی با OTP تازه
    await db.delete(otpCodes).where(eq(otpCodes.signerId, second.id));
    const sent = await guestSendReceiptOtpAction(l2.token);
    expect(sent.ok).toBe(true);
    expect((await guestVerifyReceiptOtpAction(l2.token, sent.devCode!)).ok).toBe(true);
    const res = await guestPdf(req, { params: Promise.resolve({ token: l2.token }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("دریافت نسخه‌ی نهایی برای قراردادی که هنوز نهایی نشده یا لینک نامعتبر، رد می‌شود", async () => {
    expect((await guestSendReceiptOtpAction("x".repeat(43))).ok).toBe(false);
    const g = await ensureGuestSigner(wsId, { name: "مهمان معلق", mobile: "09121110033" });
    const id = await issueContract({ workspaceId: wsId, title: "معلق", bodyHtml: "<p>متن آزمایشی قرارداد معلق برای طرف مقابل</p>", customerId: g.userId, createdBy: owner.id });
    const [s] = await getSigners(id);
    const l = (await getOrCreateSigningLink(s.id))!;
    expect((await guestSendReceiptOtpAction(l.token)).ok).toBe(false);
  });
});
