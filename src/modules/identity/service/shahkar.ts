import { MAX_SHAHKAR_ATTEMPTS, SHAHKAR_MISMATCH_TEXT, isValidNationalCode, maskNc, needsShahkar, normalizeNationalCode, parseIdentityReq } from "../rules";
import { type Result, getIdentity, ncHash, validMobile } from "./core";
import { and, eq, lt, sql } from "drizzle-orm";
import { applyWalletOps, creditToman } from "@/modules/wallet/service";
import { contractSigners, signerIdentities } from "@/db/schema";
import { db } from "@/db";
import { encryptSecret } from "@/lib/crypto";
import { getIdentityConfig, inquireShahkar, shahkarAvailable } from "../provider";
import { logAudit } from "@/modules/audit/service";
import { notifyTeam } from "@/modules/inbox/service";
import { refreshVerified } from "./config";

/* ───────── استعلام شاهکار ───────── */

export type SignerCtx = { signerId: number; contractId: number; workspaceId: number; contractNumber: string; signerLabel: string; mobile: string; userId: number };
async function releaseAttempt(signerId: number) {
  await db.update(signerIdentities).set({ attempts: sql`greatest(${signerIdentities.attempts} - 1, 0)` }).where(eq(signerIdentities.signerId, signerId));
}
export async function verifyShahkar(ctx: SignerCtx, rawNc: string): Promise<Result<{ attemptsLeft: number }>> {
  const [s] = await db.select({ req: contractSigners.identityReq }).from(contractSigners).where(eq(contractSigners.id, ctx.signerId));
  const req = parseIdentityReq(s?.req);
  if (!needsShahkar(req)) return { ok: false, error: "برای این قرارداد استعلام شاهکار لازم نیست" };
  const row = await getIdentity(ctx.signerId);
  if (!row) return { ok: false, error: "تنظیمات هویت این امضاکننده کامل نیست؛ با صادرکننده تماس بگیرید" };
  if (row.shahkarStatus === "matched" && row.checkedMobile === ctx.mobile) return { ok: true, attemptsLeft: Math.max(0, MAX_SHAHKAR_ATTEMPTS - row.attempts) };
  if (!validMobile(ctx.mobile)) return { ok: false, error: "شماره موبایل معتبری برای این امضاکننده ثبت نشده است" };
  const nc = normalizeNationalCode(rawNc);
  if (!isValidNationalCode(nc)) return { ok: false, error: "کد ملی معتبر نیست (۱۰ رقم)" };
  if (!(await shahkarAvailable())) return { ok: false, error: "استعلام خودکار فعلاً در دسترس نیست؛ از صادرکننده بخواهید روش «مدارک هویتی» را فعال کند" };

  // ۱) مصرف اتمیِ یک تلاش (درخواست‌های موازی نمی‌توانند از سقف عبور کنند)
  const claimed = await db
    .update(signerIdentities)
    .set({ attempts: sql`${signerIdentities.attempts} + 1`, lastAttemptAt: new Date() })
    .where(and(eq(signerIdentities.signerId, ctx.signerId), lt(signerIdentities.attempts, MAX_SHAHKAR_ATTEMPTS)))
    .returning({ attempts: signerIdentities.attempts });
  if (claimed.length === 0) {
    await logAudit({ action: "identity.locked", contractId: ctx.contractId, workspaceId: ctx.workspaceId, userId: ctx.userId, detail: `${ctx.signerLabel}: سقف تلاش استعلام پر شد` });
    return { ok: false, error: "تعداد تلاش‌های مجاز تمام شد. برای ادامه، از صادرکننده بخواهید دسترسی را بازنشانی کند" };
  }
  const left = Math.max(0, MAX_SHAHKAR_ATTEMPTS - claimed[0].attempts);

  // ۲) کد ملیِ مورد انتظار (اگر صادرکننده اعلام کرده): بدون هزینه‌ی استعلام رد می‌شود
  if (row.expectedNcHash && row.expectedNcHash !== ncHash(nc)) {
    await logAudit({ action: "identity.mismatch", contractId: ctx.contractId, workspaceId: ctx.workspaceId, userId: ctx.userId, detail: `${ctx.signerLabel}: کد ملی واردشده (${maskNc(nc)}) با کد ملی مورد انتظار قرارداد نمی‌خواند` });
    await notifyTeam(ctx.workspaceId, { kind: "security", title: `هشدار هویت — ${ctx.contractNumber}`, body: `${ctx.signerLabel}: کد ملی واردشده با کد ملی اعلام‌شده‌ی شما نمی‌خواند`, href: `/contracts/${ctx.contractId}` }).catch(() => 0);
    return { ok: false, error: `کد ملی با اطلاعات این قرارداد مطابقت ندارد. ${left > 0 ? `${left.toLocaleString("fa-IR")} تلاش دیگر باقی است.` : "تلاش‌ها تمام شد."}` };
  }

  // ۳) هزینه‌ی استعلام از کیف پول صادرکننده (اگر مدیر پلتفرم قیمت گذاشته باشد)؛ ref یکتا = ضد کسر مضاعف
  const cfg = await getIdentityConfig();
  const chargeRef = `identity:q:${ctx.signerId}:${claimed[0].attempts}`;
  const charge = cfg.price > 0 && cfg.mode !== "sandbox";
  if (charge) {
    const w = await applyWalletOps(ctx.workspaceId, [{ asset: "toman", delta: -cfg.price, kind: "identity", ref: chargeRef, description: `استعلام هویت — ${ctx.contractNumber}` }]);
    if (!w.ok) {
      await releaseAttempt(ctx.signerId);
      await notifyTeam(ctx.workspaceId, { kind: "warning", title: "اعتبار کیف پول برای استعلام هویت کافی نیست", body: `${ctx.contractNumber}: امضاکننده نمی‌تواند هویتش را تأیید کند؛ کیف پول را شارژ کنید`, href: "/admin/wallet" }).catch(() => 0);
      return { ok: false, error: "اعتبار کیف پول صادرکننده برای استعلام کافی نیست؛ به او اطلاع داده شد. کمی بعد دوباره تلاش کنید" };
    }
  }

  // ۴) استعلام
  const inq = await inquireShahkar(ctx.mobile, nc);
  if (!inq.ok) {
    await releaseAttempt(ctx.signerId); // خطای سرویس، تقصیر امضاکننده نیست
    if (charge) await creditToman(ctx.workspaceId, cfg.price, { kind: "identity_refund", ref: `${chargeRef}:refund`, description: `بازگشت هزینه‌ی استعلام ناموفق — ${ctx.contractNumber}` }).catch(() => undefined);
    await db.update(signerIdentities).set({ shahkarStatus: "error", updatedAt: new Date() }).where(eq(signerIdentities.signerId, ctx.signerId));
    await logAudit({ action: "identity.error", contractId: ctx.contractId, workspaceId: ctx.workspaceId, userId: ctx.userId, detail: `${ctx.signerLabel}: ${inq.error}` });
    return { ok: false, error: inq.error };
  }

  const sandbox = inq.provider === "sandbox";
  if (!inq.matched) {
    await db
      .update(signerIdentities)
      .set({ shahkarStatus: "mismatch", shahkarProvider: inq.provider, shahkarRef: inq.ref, shahkarAt: new Date(), ncEnc: encryptSecret(nc), ncHash: ncHash(nc), checkedMobile: ctx.mobile, updatedAt: new Date() })
      .where(eq(signerIdentities.signerId, ctx.signerId));
    await logAudit({ action: "identity.shahkar_mismatch", contractId: ctx.contractId, workspaceId: ctx.workspaceId, userId: ctx.userId, detail: `${ctx.signerLabel}: موبایل ${ctx.mobile.slice(0, 4)}***${ctx.mobile.slice(-2)} به نام کد ملی ${maskNc(nc)} نیست${sandbox ? " (آزمایشی)" : ""}` });
    await notifyTeam(ctx.workspaceId, { kind: "security", title: `عدم تطابق موبایل و کد ملی — ${ctx.contractNumber}`, body: `${ctx.signerLabel}: سیم‌کارت به نام کد ملی اعلام‌شده نیست (احتمال جعل هویت یا شماره‌ی اشتباه)`, href: `/contracts/${ctx.contractId}` }).catch(() => 0);
    return { ok: false, error: `${SHAHKAR_MISMATCH_TEXT} ${left > 0 ? `${left.toLocaleString("fa-IR")} تلاش دیگر باقی است.` : ""}`.trim() };
  }

  await db
    .update(signerIdentities)
    .set({ shahkarStatus: "matched", shahkarProvider: inq.provider, shahkarRef: inq.ref, shahkarAt: new Date(), ncEnc: encryptSecret(nc), ncHash: ncHash(nc), checkedMobile: ctx.mobile, updatedAt: new Date() })
    .where(eq(signerIdentities.signerId, ctx.signerId));
  await refreshVerified(ctx.signerId);
  await logAudit({ action: "identity.shahkar_matched", contractId: ctx.contractId, workspaceId: ctx.workspaceId, userId: ctx.userId, detail: `${ctx.signerLabel}: موبایل ${ctx.mobile.slice(0, 4)}***${ctx.mobile.slice(-2)} ↔ کد ملی ${maskNc(nc)} تأیید شد (${inq.provider}${inq.ref ? " #" + inq.ref : ""})` });
  return { ok: true, attemptsLeft: left };
}
