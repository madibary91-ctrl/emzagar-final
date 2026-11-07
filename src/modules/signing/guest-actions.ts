"use server";

import { rateLimit } from "@/lib/rate-limit";
import { getRequestInfo } from "@/lib/request";
import { logAudit } from "@/modules/audit/service";
import { prepareFieldValues } from "@/modules/fields/service";
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
  if (!rateLimit(`gsend:signer:${signer.id}`, 6, 60 * 60_000).ok || !rateLimit(`gsend:ip:${ip}`, 20, 60 * 60_000).ok) {
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
  if (!rateLimit(`gverify:link:${link.id}`, 10, 15 * 60_000).ok || !rateLimit(`gverify:ip:${ip}`, 40, 15 * 60_000).ok) {
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

export async function guestSignAction(token: string, input: { signature: string; method: "draw" | "upload"; agree: boolean; fields?: Record<string, string> }): Promise<ActionResult> {
  const r = await loadLink(token);
  if ("error" in r) return { ok: false, error: r.error };
  const { link, signer, contract, user } = r.ctx;
  if (!(await hasGuestSession(link.id, signer.id))) return { ok: false, error: "نشست تأیید هویت منقضی شده؛ دوباره کد پیامکی دریافت کنید" };
  if (!input.agree) return { ok: false, error: "تایید مطالعه‌ی قرارداد الزامی است" };
  const parsed = parseSignatureDataUrl(input.signature);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const allSigners = await getSigners(contract.id);
  const prepared = prepareFieldValues(contract.bodyHtml, allSigners, signer, input.fields);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const { ip } = await getRequestInfo();
  if (!rateLimit(`gsign:link:${link.id}`, 10, 15 * 60_000).ok || !rateLimit(`gsign:ip:${ip}`, 40, 15 * 60_000).ok) {
    return { ok: false, error: "تلاش‌های زیاد؛ چند دقیقه بعد دوباره امتحان کنید" };
  }
  return applySignature({ contract, signer, user, buffer: parsed.buffer, method: input.method === "upload" ? "upload" : "draw", via: "link", fieldValues: prepared.rows });
}

export async function guestRejectAction(token: string, reason: string): Promise<ActionResult> {
  const r = await loadLink(token);
  if ("error" in r) return { ok: false, error: r.error };
  const { link, signer, contract, user } = r.ctx;
  if (!(await hasGuestSession(link.id, signer.id))) return { ok: false, error: "نشست تأیید هویت منقضی شده؛ دوباره کد پیامکی دریافت کنید" };
  return applyRejection({ contract, signer, user, reason: String(reason || "") });
}
