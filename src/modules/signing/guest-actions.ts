"use server";

import { rateLimitDb } from "@/lib/rate-limit-db";
import { getRequestInfo } from "@/lib/request";
import { logAudit } from "@/modules/audit/service";
import { prepareSigningFields } from "@/modules/docs/service";
import { getSigners } from "@/modules/contracts/service";
import { applyRejection, applySignature } from "./finalize";
import { hasGuestSession, resolveSigningToken, startGuestSession, type LinkContext } from "./links";
import { verifyOtp } from "./otp";
import { deliverSigningOtp } from "./otp-delivery";
import { parseSignatureDataUrl, type ActionResult } from "./types";

/**
 * عملیات «امضا بدون ثبت‌نام». احراز هویت دو عاملی است:
 *  ۱) در اختیار داشتن لینک اختصاصی (توکن ۲۵۶ بیتی)
 *  ۲) OTP پیامکی روی شماره‌ی ثبت‌شده‌ی امضاکننده (مشتری شماره را عوض نمی‌کند)
 */
async function loadLink(token: string): Promise<{ ctx: LinkContext } | { error: string }> {
  const st = await resolveSigningToken(String(token || ""));
  if (st.status === "ok") return { ctx: st.ctx };
  if (st.status === "expired") return { error: "مهلت این لینک تمام شده است؛ از فرستنده لینک جدید بخواهید" };
  if (st.status === "done") return { error: "شما این قرارداد را قبلاً امضا کرده‌اید" };
  if (st.status === "closed") return { error: "این قرارداد دیگر قابل امضا نیست" };
  return { error: "لینک نامعتبر است" };
}

export async function guestSendOtpAction(token: string): Promise<ActionResult> {
  const r = await loadLink(token);
  if ("error" in r) return { ok: false, error: r.error };
  const { link, signer, contract, user } = r.ctx;
  const { ip } = await getRequestInfo();
  if (!(await rateLimitDb(`gsend:signer:${signer.id}`, 6, 60 * 60_000)).ok || !(await rateLimitDb(`gsend:ip:${ip}`, 20, 60 * 60_000)).ok) {
    return { ok: false, error: "درخواست‌های ارسال کد زیاد بود؛ کمی بعد دوباره تلاش کنید" };
  }
  void link;
  return deliverSigningOtp({ contractId: contract.id, workspaceId: contract.workspaceId, signer, user });
}

/** تأیید OTP و شروع نشست کوتاه‌مدت مهمان (۳۰ دقیقه) */
export async function guestVerifyOtpAction(token: string, code: string): Promise<ActionResult> {
  const r = await loadLink(token);
  if ("error" in r) return { ok: false, error: r.error };
  const { link, signer, contract, user } = r.ctx;
  const { ip } = await getRequestInfo();
  if (!(await rateLimitDb(`gverify:link:${link.id}`, 10, 15 * 60_000)).ok || !(await rateLimitDb(`gverify:ip:${ip}`, 40, 15 * 60_000)).ok) {
    return { ok: false, error: "تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید" };
  }
  const otp = await verifyOtp(signer.id, String(code || ""));
  if (!otp.ok) {
    await logAudit({ action: "otp.failed", contractId: contract.id, userId: user.id, detail: `${otp.error} (لینک امن)` });
    return { ok: false, error: otp.error };
  }
  await logAudit({ action: "otp.verified", contractId: contract.id, userId: user.id, detail: "هویت با OTP پیامکی روی لینک امن تأیید شد" });
  await startGuestSession(link.id, signer.id);
  return { ok: true };
}

export async function guestSignAction(token: string, input: { signature: string; method: "draw" | "upload"; agree: boolean; fields?: Record<string, string>; seal?: string | null; initials?: string | null }): Promise<ActionResult> {
  const r = await loadLink(token);
  if ("error" in r) return { ok: false, error: r.error };
  const { link, signer, contract, user } = r.ctx;
  if (!(await hasGuestSession(link.id, signer.id))) return { ok: false, error: "نشست تأیید هویت منقضی شده؛ دوباره کد پیامکی دریافت کنید" };
  if (!input.agree) return { ok: false, error: "تایید مطالعه‌ی قرارداد الزامی است" };
  const parsed = parseSignatureDataUrl(input.signature);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const allSigners = await getSigners(contract.id);
  const prepared = await prepareSigningFields(contract, allSigners, { position: signer.position, userName: user.name }, input.fields);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const { ip } = await getRequestInfo();
  if (!(await rateLimitDb(`gsign:link:${link.id}`, 10, 15 * 60_000)).ok || !(await rateLimitDb(`gsign:ip:${ip}`, 40, 15 * 60_000)).ok) {
    return { ok: false, error: "تلاش‌های زیاد؛ چند دقیقه بعد دوباره امتحان کنید" };
  }
  return applySignature({ contract, signer, user, buffer: parsed.buffer, method: input.method === "upload" ? "upload" : "draw", via: "link", fieldValues: prepared.rows, evidence: { seal: input.seal, initials: input.initials } });
}

export async function guestRejectAction(token: string, reason: string): Promise<ActionResult> {
  const r = await loadLink(token);
  if ("error" in r) return { ok: false, error: r.error };
  const { link, signer, contract, user } = r.ctx;
  if (!(await hasGuestSession(link.id, signer.id))) return { ok: false, error: "نشست تأیید هویت منقضی شده؛ دوباره کد پیامکی دریافت کنید" };
  return applyRejection({ contract, signer, user, reason: String(reason || "") });
}

/**
 * دریافت نسخه‌ی نهایی توسط مهمان پس از امضا: چون مهمان حساب/ایمیل ندارد، هر زمان که لینک خود را دوباره باز کند
 * با یک OTP تازه می‌تواند PDF رسمی را بگیرد (نشست ۳۰ دقیقه‌ای). فقط برای امضاکننده‌ای که امضا کرده و قرارداد نهایی شده است.
 */
async function loadSignedLink(token: string): Promise<{ ctx: LinkContext } | { error: string }> {
  const st = await resolveSigningToken(String(token || ""));
  if (st.status !== "done") return { error: "لینک نامعتبر است" };
  if (st.ctx.contract.status !== "signed") return { error: "قرارداد هنوز توسط همه‌ی طرف‌ها امضا نشده است" };
  return { ctx: st.ctx };
}

export async function guestSendReceiptOtpAction(token: string): Promise<ActionResult> {
  const r = await loadSignedLink(token);
  if ("error" in r) return { ok: false, error: r.error };
  const { signer, contract, user } = r.ctx;
  const { ip } = await getRequestInfo();
  if (!(await rateLimitDb(`grsend:signer:${signer.id}`, 6, 60 * 60_000)).ok || !(await rateLimitDb(`grsend:ip:${ip}`, 20, 60 * 60_000)).ok) {
    return { ok: false, error: "درخواست‌های ارسال کد زیاد بود؛ کمی بعد دوباره تلاش کنید" };
  }
  return deliverSigningOtp({ contractId: contract.id, workspaceId: contract.workspaceId, signer, user });
}

export async function guestVerifyReceiptOtpAction(token: string, code: string): Promise<ActionResult> {
  const r = await loadSignedLink(token);
  if ("error" in r) return { ok: false, error: r.error };
  const { link, signer, contract, user } = r.ctx;
  const { ip } = await getRequestInfo();
  if (!(await rateLimitDb(`grverify:link:${link.id}`, 10, 15 * 60_000)).ok || !(await rateLimitDb(`grverify:ip:${ip}`, 40, 15 * 60_000)).ok) {
    return { ok: false, error: "تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید" };
  }
  const otp = await verifyOtp(signer.id, String(code || ""));
  if (!otp.ok) {
    await logAudit({ action: "otp.failed", contractId: contract.id, userId: user.id, detail: `${otp.error} (دریافت نسخه‌ی نهایی)` });
    return { ok: false, error: otp.error };
  }
  await logAudit({ action: "otp.verified", contractId: contract.id, userId: user.id, detail: "هویت با OTP پیامکی برای دریافت نسخه‌ی نهایی تأیید شد" });
  await startGuestSession(link.id, signer.id);
  return { ok: true };
}
