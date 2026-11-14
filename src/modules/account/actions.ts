"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contractSigners, users } from "@/db/schema";
import { redirect } from "next/navigation";
import { requireUser, createSession, destroySession, getCurrentSessionId, revokeSession, revokeSessions } from "@/modules/auth/session";
import { deleteAccount } from "@/modules/privacy/service";
import { DELETE_PHRASE_TEXT as DELETE_PHRASE } from "./constants";
import { MOBILE_RE, passwordProblem } from "@/modules/auth/validation";
import { beginTotpSetup, confirmTotpSetup, disableTotp, isTotpEnabled, regenerateRecoveryCodes, verifyLoginCode } from "@/modules/auth/twofactor";
import { hashPasswordAsync, verifyPasswordAsync } from "@/lib/password";
import { resetRateLimit } from "@/lib/rate-limit";
import { rateLimitDb } from "@/lib/rate-limit-db";
import { escapeHtml } from "@/lib/html";
import { logAudit } from "@/modules/audit/service";
import { sendMail } from "@/modules/mail";
import { getMemberships } from "@/modules/tenancy/context";

export type AccountState = { ok?: boolean; error?: string; message?: string; codes?: string[] };

/** سقف تلاش برای عملیات حساس حساب که رمز فعلی می‌خواهند (مقابله با حدس رمز از روی نشست دزدیده‌شده) */
async function passwordGate(userId: number, password: string, hash: string): Promise<string | null> {
  if (!(await rateLimitDb(`account:pw:${userId}`, 8, 15 * 60_000)).ok) return "تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید.";
  if (!password || !(await verifyPasswordAsync(password, hash))) return "رمز عبور فعلی نادرست است";
  resetRateLimit(`account:pw:${userId}`);
  return null;
}

const firstWorkspaceId = async (userId: number) => (await getMemberships(userId))[0]?.workspaceId ?? 0;

/** ویرایش نام و موبایل. موبایل مبنای کد تأیید امضاست؛ تغییر آن رمز فعلی می‌خواهد. */
export async function updateProfileAction(_prev: AccountState, formData: FormData): Promise<AccountState> {
  const user = await requireUser();
  const name = String(formData.get("name") || "").trim().slice(0, 100);
  const mobile = String(formData.get("mobile") || "").trim();
  if (!name) return { error: "نام را وارد کنید" };
  if (!MOBILE_RE.test(mobile)) return { error: "موبایل باید به‌صورت 09xxxxxxxxx باشد" };

  const mobileChanged = mobile !== user.mobile;
  if (mobileChanged) {
    const bad = await passwordGate(user.id, String(formData.get("currentPassword") || ""), user.passwordHash);
    if (bad) return { error: `برای تغییر موبایل، رمز فعلی لازم است. ${bad}` };
  }

  await db.update(users).set({ name, mobile }).where(eq(users.id, user.id));
  // قراردادهای در انتظار امضا هم شماره‌ی تازه را بگیرند
  if (mobileChanged) await db.update(contractSigners).set({ mobile }).where(and(eq(contractSigners.userId, user.id), eq(contractSigners.status, "pending")));
  await logAudit({ action: "account.profile_updated", userId: user.id, workspaceId: await firstWorkspaceId(user.id), detail: mobileChanged ? "نام و موبایل" : "نام" });
  revalidatePath("/account");
  return { ok: true, message: mobileChanged ? "مشخصات و شماره‌ی موبایل به‌روز شد." : "مشخصات به‌روز شد." };
}

/** تغییر رمز: همه‌ی نشست‌های دیگر باطل می‌شوند و نشست فعلی با رمز جدید ادامه می‌یابد */
export async function changePasswordAction(_prev: AccountState, formData: FormData): Promise<AccountState> {
  const user = await requireUser();
  const next = String(formData.get("newPassword") || "");
  if (next !== String(formData.get("confirm") || "")) return { error: "تکرار رمز جدید یکسان نیست" };
  const bad = await passwordGate(user.id, String(formData.get("currentPassword") || ""), user.passwordHash);
  if (bad) return { error: bad };
  const weak = passwordProblem(next);
  if (weak) return { error: weak };
  if (await verifyPasswordAsync(next, user.passwordHash)) return { error: "رمز جدید باید با رمز فعلی متفاوت باشد" };

  const passwordHash = await hashPasswordAsync(next);
  await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
  await revokeSessions(user.id, null);
  await createSession(user.id, passwordHash);
  const workspaceId = await firstWorkspaceId(user.id);
  await logAudit({ action: "account.password_changed", userId: user.id, workspaceId });
  await sendMail({
    to: user.email,
    subject: "رمز عبور حساب شما تغییر کرد",
    html: `<div dir="rtl"><p>${escapeHtml(user.name)} عزیز، رمز عبور حساب شما هم‌اکنون تغییر کرد و ورودهای قبلی از همه‌ی دستگاه‌ها خارج شدند.</p><p>اگر این کار را شما انجام نداده‌اید، بلافاصله از «فراموشی رمز» رمز تازه‌ای تعیین کنید و با پشتیبانی تماس بگیرید.</p></div>`,
    workspaceId,
  }).catch(() => undefined);
  return { ok: true, message: "رمز عبور تغییر کرد. ورودهای دیگر خارج شدند." };
}

/* ═════════════ ورود دومرحله‌ای ═════════════ */

/** شروع راه‌اندازی؛ QR و کلید در صفحه‌ی حساب (سمت سرور) نمایش داده می‌شود */
export async function startTotpSetupAction(): Promise<void> {
  const user = await requireUser();
  await beginTotpSetup(user.id);
  revalidatePath("/account");
}

/** تأیید کد اول اپ احراز هویت و فعال‌سازی؛ کدهای بازیابی فقط یک بار نمایش داده می‌شوند */
export async function confirmTotpAction(_prev: AccountState, formData: FormData): Promise<AccountState> {
  const user = await requireUser();
  if (!(await rateLimitDb(`account:2fa-setup:${user.id}`, 10, 15 * 60_000)).ok) return { error: "تلاش‌های زیاد؛ چند دقیقه بعد دوباره امتحان کنید." };
  const codes = await confirmTotpSetup(user.id, String(formData.get("code") || ""));
  if (!codes) return { error: "کد نادرست است. کد ۶ رقمی فعلی اپ را وارد کنید (ساعت گوشی باید درست باشد)." };
  await logAudit({ action: "auth.2fa_enabled", userId: user.id, workspaceId: await firstWorkspaceId(user.id) });
  // عمداً revalidate نمی‌شود تا فهرست کدها تا وقتی کاربر آن‌ها را ذخیره کند روی صفحه بماند
  return { ok: true, message: "ورود دومرحله‌ای فعال شد.", codes };
}

/** برای عملیات حساس: رمز فعلی + یک کد معتبر (اپ یا بازیابی) */
async function gateWithPasswordAndCode(user: Awaited<ReturnType<typeof requireUser>>, formData: FormData): Promise<string | null> {
  const bad = await passwordGate(user.id, String(formData.get("currentPassword") || ""), user.passwordHash);
  if (bad) return bad;
  if (!(await rateLimitDb(`account:2fa-gate:${user.id}`, 8, 15 * 60_000)).ok) return "تلاش‌های زیاد؛ چند دقیقه بعد دوباره امتحان کنید.";
  if (!(await verifyLoginCode(user.id, String(formData.get("code") || "")))) return "کد تأیید نادرست است";
  return null;
}

export async function disableTotpAction(_prev: AccountState, formData: FormData): Promise<AccountState> {
  const user = await requireUser();
  if (!(await isTotpEnabled(user.id))) return { error: "ورود دومرحله‌ای فعال نیست" };
  const bad = await gateWithPasswordAndCode(user, formData);
  if (bad) return { error: bad };
  await disableTotp(user.id);
  await logAudit({ action: "auth.2fa_disabled", userId: user.id, workspaceId: await firstWorkspaceId(user.id) });
  revalidatePath("/account");
  return { ok: true, message: "ورود دومرحله‌ای غیرفعال شد." };
}

export async function regenerateRecoveryAction(_prev: AccountState, formData: FormData): Promise<AccountState> {
  const user = await requireUser();
  const bad = await gateWithPasswordAndCode(user, formData);
  if (bad) return { error: bad };
  const codes = await regenerateRecoveryCodes(user.id);
  if (!codes) return { error: "ورود دومرحله‌ای فعال نیست" };
  await logAudit({ action: "auth.2fa_recovery_regenerated", userId: user.id, workspaceId: await firstWorkspaceId(user.id) });
  return { ok: true, message: "کدهای بازیابی جدید ساخته شد؛ کدهای قبلی دیگر کار نمی‌کنند.", codes };
}

/* ═════════════ نشست‌ها و دستگاه‌ها ═════════════ */

export async function revokeSessionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const sid = String(formData.get("sid") || "");
  const current = await getCurrentSessionId();
  if (sid && sid !== current && (await revokeSession(user.id, sid))) {
    await logAudit({ action: "account.session_revoked", userId: user.id, workspaceId: await firstWorkspaceId(user.id), detail: "یک دستگاه بسته شد" });
  }
  revalidatePath("/account");
}

export async function revokeOtherSessionsAction(): Promise<void> {
  const user = await requireUser();
  const n = await revokeSessions(user.id, await getCurrentSessionId());
  await logAudit({ action: "account.session_revoked", userId: user.id, workspaceId: await firstWorkspaceId(user.id), detail: `${n} دستگاه دیگر بسته شد` });
  revalidatePath("/account");
}

/* ═════════════ حذف حساب ═════════════ */


export async function deleteAccountAction(_prev: AccountState, formData: FormData): Promise<AccountState> {
  const user = await requireUser();
  if (String(formData.get("confirm") || "").trim() !== DELETE_PHRASE) return { error: `برای تأیید، عبارت «${DELETE_PHRASE}» را دقیقاً بنویسید` };
  const bad = await passwordGate(user.id, String(formData.get("currentPassword") || ""), user.passwordHash);
  if (bad) return { error: bad };
  const r = await deleteAccount(user.id);
  if (!r.ok) return { error: r.error };
  await destroySession();
  redirect("/login?deleted=1");
}
