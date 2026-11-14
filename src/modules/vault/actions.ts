"use server";

import { redirect } from "next/navigation";
import { hashPasswordAsync } from "@/lib/password";
import { rateLimitDb } from "@/lib/rate-limit-db";
import { getOrigin, getRequestInfo } from "@/lib/request";
import { emailRejection } from "@/lib/email-check";
import { createPendingVerify, createSession } from "@/modules/auth/session";
import { sendVerificationEmail, showDevSecrets } from "@/modules/auth/email-verify";
import { passwordProblem } from "@/modules/auth/validation";
import { getBranding } from "@/modules/branding/service";
import { normalizeMobile } from "@/modules/guests/service";
import { sendMobileCode, verifyMobileCode } from "@/modules/mobile/otp";
import { hasGuestSession, resolveSigningToken } from "@/modules/signing/links";
import { homeFor, setActiveWorkspaceCookie } from "@/modules/tenancy/context";
import { EMAIL_RE } from "@/modules/tenancy/service";
import { upgradeVaultToAccount, VaultUpgradeError } from "./growth";
import { endVaultSession, readVaultSession, startVaultSession } from "./session";
import { hasVaultDocs, isVaultEnabled, setVaultPref, touchVaultProfile } from "./service";

export type VaultResult = { ok: boolean; error?: string; seconds?: number; devCode?: string };
export type VaultFormState = { error?: string };

const DISABLED: VaultResult = { ok: false, error: "کیف اسناد در این سامانه فعلاً غیرفعال است" };

async function sendCode(mobile: string): Promise<VaultResult> {
  const { ip } = await getRequestInfo();
  if (!(await rateLimitDb(`vaultcode:ip:${ip}`, 12, 60 * 60_000)).ok) return { ok: false, error: "درخواست‌های زیاد؛ کمی بعد دوباره تلاش کنید" };
  const brand = await getBranding(0);
  const r = await sendMobileCode({ purpose: "vault", scope: "", mobile, ip, siteName: brand.name });
  return { ok: r.ok, error: r.error, seconds: r.seconds, devCode: r.devCode };
}

async function verifyCode(mobile: string, code: string): Promise<VaultResult> {
  const { ip } = await getRequestInfo();
  if (!(await rateLimitDb(`vaultverify:ip:${ip}`, 40, 15 * 60_000)).ok || !(await rateLimitDb(`vaultverify:mobile:${mobile}`, 12, 15 * 60_000)).ok) {
    return { ok: false, error: "تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید" };
  }
  const r = await verifyMobileCode({ purpose: "vault", scope: "", mobile, code });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/* ───────── ورود مستقیم به کیف (موبایل + OTP) ───────── */

export async function vaultSendCodeAction(mobileRaw: string): Promise<VaultResult> {
  if (!(await isVaultEnabled())) return DISABLED;
  const mobile = normalizeMobile(mobileRaw);
  if (!mobile) return { ok: false, error: "شماره‌ی موبایل معتبر نیست؛ به‌صورت 09123456789 وارد کنید" };
  // پیامک فقط برای شماره‌ای که سند دارد ارسال می‌شود (بدون هزینه‌ی پیامک‌بمبارانی)؛ پاسخ در هر دو حالت یکسان است تا وجود سند لو نرود
  if (!(await hasVaultDocs(mobile))) {
    if (!(await rateLimitDb(`vaultcode:ghost:${mobile}`, 5, 60 * 60_000)).ok) return { ok: false, error: "درخواست‌های زیاد؛ کمی بعد دوباره تلاش کنید" };
    return { ok: true, seconds: 60 };
  }
  return sendCode(mobile);
}

export async function vaultVerifyCodeAction(mobileRaw: string, code: string): Promise<VaultResult> {
  if (!(await isVaultEnabled())) return DISABLED;
  const mobile = normalizeMobile(mobileRaw);
  if (!mobile) return { ok: false, error: "شماره‌ی موبایل معتبر نیست" };
  const r = await verifyCode(mobile, code);
  if (!r.ok) return r;
  await startVaultSession(mobile);
  await touchVaultProfile(mobile, "direct");
  return { ok: true };
}

/* ───────── ورود یک‌لمسی از صفحه‌ی «امضای شما ثبت شد» ───────── */

async function signedMobile(token: string): Promise<{ mobile: string; linkId: number; signerId: number } | null> {
  const st = await resolveSigningToken(String(token || ""));
  if (st.status !== "done") return null;
  const mobile = normalizeMobile(st.ctx.user.mobile || st.ctx.signer.mobile);
  return mobile ? { mobile, linkId: st.ctx.link.id, signerId: st.ctx.signer.id } : null;
}

/** اگر نشست OTP امضا هنوز معتبر است، بدون کد دوباره وارد کیف می‌شود (هویت همین الان با OTP ثابت شده) */
export async function vaultEnterFromTokenAction(token: string): Promise<VaultResult> {
  if (!(await isVaultEnabled())) return DISABLED;
  const s = await signedMobile(token);
  if (!s) return { ok: false, error: "لینک نامعتبر است" };
  if (!(await hasGuestSession(s.linkId, s.signerId))) return { ok: false, error: "برای ورود، کد پیامکی دریافت کنید" };
  await startVaultSession(s.mobile);
  await touchVaultProfile(s.mobile, "sign");
  return { ok: true };
}

export async function vaultTokenSendCodeAction(token: string): Promise<VaultResult> {
  if (!(await isVaultEnabled())) return DISABLED;
  const s = await signedMobile(token);
  if (!s) return { ok: false, error: "لینک نامعتبر است" };
  return sendCode(s.mobile);
}

export async function vaultTokenVerifyCodeAction(token: string, code: string): Promise<VaultResult> {
  if (!(await isVaultEnabled())) return DISABLED;
  const s = await signedMobile(token);
  if (!s) return { ok: false, error: "لینک نامعتبر است" };
  const r = await verifyCode(s.mobile, code);
  if (!r.ok) return r;
  await startVaultSession(s.mobile);
  await touchVaultProfile(s.mobile, "sign");
  return { ok: true };
}

export async function vaultLogoutAction(): Promise<void> {
  await endVaultSession();
  redirect("/vault");
}

/* ───────── مدیریت اسناد ───────── */

export async function vaultPrefAction(contractId: number, patch: { pinned?: boolean; archived?: boolean; note?: string }): Promise<VaultResult> {
  const mobile = await readVaultSession();
  if (!mobile) return { ok: false, error: "نشست شما تمام شده؛ دوباره وارد شوید" };
  const { ip } = await getRequestInfo();
  if (!(await rateLimitDb(`vaultpref:${mobile}`, 120, 15 * 60_000)).ok || !(await rateLimitDb(`vaultpref:ip:${ip}`, 300, 15 * 60_000)).ok) return { ok: false, error: "درخواست‌های زیاد؛ کمی بعد دوباره تلاش کنید" };
  const done = await setVaultPref(mobile, Number(contractId), { pinned: patch.pinned, archived: patch.archived, note: patch.note });
  return done ? { ok: true } : { ok: false, error: "سند پیدا نشد" };
}

/* ───────── رشد: ساخت حساب فروشنده با یک فرم کوتاه ───────── */

function verifyRedirect(r: { ok: boolean; seconds?: number; devCode?: string }): never {
  const q = new URLSearchParams();
  if (r.devCode && showDevSecrets()) q.set("dev", r.devCode);
  if (!r.ok && !r.seconds) q.set("err", "1");
  redirect(`/verify-email${q.size ? `?${q}` : ""}`);
}

/** موبایل پیش‌تر در نشست کیف تأیید شده؛ فقط ایمیل + رمز لازم است. حساب با همان هویت و تاریخچه‌ی امضاها ساخته می‌شود. */
export async function vaultUpgradeAction(_prev: VaultFormState, formData: FormData): Promise<VaultFormState> {
  if (!(await isVaultEnabled())) return { error: DISABLED.error };
  const mobile = await readVaultSession();
  if (!mobile) return { error: "نشست شما تمام شده؛ دوباره وارد کیف شوید" };
  const { ip } = await getRequestInfo();
  if (!(await rateLimitDb(`vaultup:ip:${ip}`, 6, 60 * 60_000)).ok || !(await rateLimitDb(`vaultup:mobile:${mobile}`, 6, 60 * 60_000)).ok) return { error: "تعداد تلاش‌ها زیاد بود؛ بعداً دوباره امتحان کنید" };

  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  const name = String(formData.get("name") || "").trim().slice(0, 100);
  const bizRaw = String(formData.get("workspaceName") || "").trim().slice(0, 60);
  if (!EMAIL_RE.test(email)) return { error: "ایمیل معتبر نیست" };
  const bad = passwordProblem(password);
  if (bad) return { error: bad };
  const rejected = await emailRejection(email);
  if (rejected) return { error: rejected };

  const passwordHash = await hashPasswordAsync(password);
  let result: Awaited<ReturnType<typeof upgradeVaultToAccount>>;
  try {
    result = await upgradeVaultToAccount({ mobile, email, passwordHash, name, workspaceName: bizRaw || (name ? `کسب‌وکار ${name}` : "کسب‌وکار من"), ip });
  } catch (e) {
    if (e instanceof VaultUpgradeError) return { error: e.message };
    console.error("[vault:upgrade]", e);
    return { error: "ساخت حساب انجام نشد؛ دوباره تلاش کنید" };
  }

  const { user, workspaceId } = result;
  if (!user.emailVerifiedAt) {
    // مثل ثبت‌نام عادی: تا تأیید مالکیت ایمیل نشستی ساخته نمی‌شود
    await createPendingVerify(user.id, user.passwordHash);
    verifyRedirect(await sendVerificationEmail(user, await getOrigin()));
  }
  await createSession(user.id, user.passwordHash);
  await setActiveWorkspaceCookie(workspaceId);
  redirect(await homeFor(user.id));
}
