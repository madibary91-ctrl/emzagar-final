import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { users, workspaceMembers } from "@/db/schema";
import { unusablePasswordHash } from "@/lib/password";
import { logAudit } from "@/modules/audit/service";

/**
 * ── امضاکننده‌ی مهمان (Guest Signer) ─────────────────────────────────────────────
 *
 * تصمیم معماری: مهمان یک «هویت سبک» است نه «حساب کاربری». برای اینکه کل خط لوله‌ی موجود (زنجیره‌ی امضا،
 * لینک ۲۵۶ بیتی، OTP، گواهی PDF، ممیزی، ایزولاسیون فضای کاری و کلیدهای خارجی) دست‌نخورده بماند، مهمان
 * یک ردیف `users` با `is_guest = true` است، ولی:
 *   • هیچ ایمیل واقعی ندارد (ایمیل ساختگیِ `g-…@guest.emzagar.invalid`؛ هیچ ایمیلی به آن ارسال نمی‌شود)
 *   • رمز عبور او تصادفی و ناشناخته است و ورود/بازیابی رمز/ثبت‌نام برای او مسدود است
 *   • فقط عضو «یک» فضای کاری (نقش client) است و هرگز بین فضاهای کاری به اشتراک گذاشته نمی‌شود
 *   • هویت او = (نام + شماره‌ی موبایل) در همان فضای کاری؛ تکرار قرارداد برای همان فرد، همان ردیف را استفاده می‌کند
 *   • اثبات هویت: در اختیار داشتن لینک اختصاصی + OTP پیامکی روی همان موبایل
 */
export const GUEST_EMAIL_DOMAIN = "guest.emzagar.invalid";

export const isGuestEmail = (email: string | null | undefined): boolean => !!email && email.toLowerCase().endsWith(`@${GUEST_EMAIL_DOMAIN}`);

const FA = "۰۱۲۳۴۵۶۷۸۹";
const AR = "٠١٢٣٤٥٦٧٨٩";

/** نرمال‌سازی شماره‌ی موبایل ایران به قالب 09xxxxxxxxx؛ در صورت نامعتبر بودن null */
export function normalizeMobile(raw: string | null | undefined): string | null {
  let s = String(raw ?? "")
    .replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)))
    .replace(/[\s\-().]/g, "");
  if (s.startsWith("+98")) s = "0" + s.slice(3);
  else if (s.startsWith("0098")) s = "0" + s.slice(4);
  else if (/^9\d{9}$/.test(s)) s = "0" + s;
  return /^09\d{9}$/.test(s) ? s : null;
}

/** نام مهمان را تمیز می‌کند (فاصله‌ها، نویسه‌های کنترلی/جهت‌دهی) */
export function cleanGuestName(raw: string | null | undefined): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

export type GuestInput = { name: string; mobile: string };

export class GuestError extends Error {}

export function validateGuestInput(input: GuestInput): { name: string; mobile: string } {
  const name = cleanGuestName(input.name);
  if (name.length < 3) throw new GuestError("نام و نام خانوادگی امضاکننده‌ی مهمان را وارد کنید");
  const mobile = normalizeMobile(input.mobile);
  if (!mobile) throw new GuestError(`شماره‌ی موبایل «${name}» معتبر نیست؛ به‌صورت 09123456789 وارد کنید (کد تأیید امضا به همین شماره می‌رود)`);
  return { name, mobile };
}

/**
 * مهمان‌ی این فضای کاری با همین نام و موبایل را برمی‌گرداند؛ اگر نبود می‌سازد.
 * ساخت ردیف و عضویت در یک تراکنش است تا «حساب یتیم» نماند.
 */
export async function ensureGuestSigner(workspaceId: number, input: GuestInput): Promise<{ userId: number; created: boolean }> {
  const { name, mobile } = validateGuestInput(input);
  return withTransaction(async () => {
    const [found] = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(users.isGuest, true), eq(users.mobile, mobile), sql`lower(${users.name}) = lower(${name})`))
      .limit(1);
    if (found) return { userId: found.id, created: false };

    const [fresh] = await db
      .insert(users)
      .values({
        name,
        mobile,
        email: `g-${crypto.randomBytes(10).toString("hex")}@${GUEST_EMAIL_DOMAIN}`,
        passwordHash: unusablePasswordHash(),
        role: "user",
        isGuest: true,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: users.id });
    await db.insert(workspaceMembers).values({ workspaceId, userId: fresh.id, role: "client" }).onConflictDoNothing();
    return { userId: fresh.id, created: true };
  });
}

/** نمایش ایمن ایمیل: ایمیل ساختگی مهمان هرگز نشان داده نمی‌شود */
export function displayEmail(email: string | null | undefined): string {
  return isGuestEmail(email) ? "" : String(email ?? "");
}

/* ───────── ارتقای مهمان به کاربر واقعی (آماده برای فاز ۲) ───────── */

export type GuestUpgradeErrorCode = "not_guest" | "mobile_mismatch" | "invalid_email" | "email_taken";

export class GuestUpgradeError extends Error {
  constructor(readonly code: GuestUpgradeErrorCode, message: string) {
    super(message);
    this.name = "GuestUpgradeError";
  }
}

const UPGRADE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * مهمان را «در همان ردیف users» به کاربر واقعی تبدیل می‌کند؛ پس شناسه‌ی کاربر ثابت می‌ماند و همه‌ی تاریخچه
 * (contract_signers، لینک‌ها، OTP، audit_logs، فیلدهای پرشده، عضویت client در فضای کاری) بدون هیچ مهاجرت داده‌ای حفظ می‌شود.
 *
 * پیش‌شرط (به‌عهده‌ی فراخواننده): مالکیت موبایل مهمان با OTP پیامکی «همین الان» اثبات شده و `verifiedMobile` همان شماره است.
 * اینجا دوباره تطبیق داده می‌شود تا اثبات یک هویت برای هویت دیگر به کار نرود.
 *  • ایمیلی که قبلاً حساب دارد پذیرفته نمی‌شود (ادغام دو حساب خودکار انجام نمی‌شود؛ تصمیم مالکیت با فراخواننده است).
 *  • ایمیل تأییدنشده می‌ماند (emailVerifiedAt = null) تا همان خط‌لوله‌ی تأیید ایمیل ثبت‌نام اعمال شود.
 *  • ارتقا اتمی و ضدمسابقه است (شرط is_guest در خود UPDATE)؛ ارتقای دوباره not_guest می‌دهد.
 */
export async function upgradeGuestToUser(userId: number, input: { email: string; passwordHash: string; verifiedMobile: string }): Promise<{ userId: number }> {
  const email = String(input.email || "").trim().toLowerCase();
  if (!UPGRADE_EMAIL_RE.test(email) || isGuestEmail(email)) throw new GuestUpgradeError("invalid_email", "ایمیل معتبر نیست");
  const mobile = normalizeMobile(input.verifiedMobile);
  try {
    return await withTransaction(async () => {
      const [guest] = await db.select().from(users).where(eq(users.id, userId)).for("update");
      if (!guest || !guest.isGuest) throw new GuestUpgradeError("not_guest", "این حساب مهمان نیست");
      if (!mobile || mobile !== guest.mobile) throw new GuestUpgradeError("mobile_mismatch", "شماره‌ی تأییدشده با هویت مهمان یکی نیست");
      const [clash] = await db.select({ id: users.id }).from(users).where(and(eq(users.email, email), sql`${users.id} <> ${userId}`));
      if (clash) throw new GuestUpgradeError("email_taken", "این ایمیل قبلاً حساب دارد");
      const done = await db
        .update(users)
        .set({ email, passwordHash: input.passwordHash, isGuest: false, emailVerifiedAt: null })
        .where(and(eq(users.id, userId), eq(users.isGuest, true)))
        .returning({ id: users.id });
      if (done.length === 0) throw new GuestUpgradeError("not_guest", "این حساب مهمان نیست");
      const [member] = await db.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, userId)).limit(1);
      await logAudit({ action: "guest.upgraded", userId, workspaceId: member?.workspaceId ?? 0, detail: `#${userId}` });
      return { userId };
    });
  } catch (e) {
    if (e instanceof GuestUpgradeError) throw e;
    if ((e as { code?: string; cause?: { code?: string } }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505") {
      throw new GuestUpgradeError("email_taken", "این ایمیل قبلاً حساب دارد");
    }
    throw e;
  }
}
