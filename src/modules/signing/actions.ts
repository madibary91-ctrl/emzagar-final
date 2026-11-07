"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts, contractSigners } from "@/db/schema";
import { requireUser } from "@/modules/auth/session";
import { currentSigner, getContractForUser } from "@/modules/contracts/service";
import { logAudit } from "@/modules/audit/service";
import { getRequestInfo } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { verifyOtp } from "./otp";
import { deliverSigningOtp } from "./otp-delivery";
import { applyRejection, applySignature } from "./finalize";
import { parseSignatureDataUrl, type ActionResult } from "./types";
import { emitEvent } from "@/modules/webhooks/service";
import { prepareFieldValues } from "@/modules/fields/service";

export type { ActionResult } from "./types";

/** بررسی سطح دسترسی قبل از هر درخواست: کاربر باید امضاکننده‌ی فعلی همین قرارداد باشد */
async function loadTurn(contractId: number) {
  const user = await requireUser();
  const data = await getContractForUser(user, contractId);
  if (!data) return { error: "قرارداد یافت نشد یا دسترسی ندارید" as const };
  if (data.contract.status !== "sent") return { error: "این قرارداد دیگر قابل امضا نیست" as const };
  const signer = currentSigner(data.signers);
  if (!signer || signer.userId !== user.id) return { error: "نوبت امضای شما نیست" as const };
  return { user, data, signer };
}

export async function sendOtpAction(contractId: number): Promise<ActionResult> {
  const turn = await loadTurn(contractId);
  if ("error" in turn) return { ok: false, error: turn.error };
  const { user, signer, data } = turn;
  const { ip } = await getRequestInfo();
  if (!rateLimit(`otp:user:${user.id}`, 8, 60 * 60_000).ok || !rateLimit(`otp:ip:${ip}`, 30, 60 * 60_000).ok) {
    return { ok: false, error: "درخواست‌های ارسال کد زیاد بود؛ کمی بعد دوباره تلاش کنید" };
  }
  return deliverSigningOtp({ contractId, workspaceId: data.contract.workspaceId, signer, user });
}

export async function signContractAction(
  contractId: number,
  input: { signature: string; method: "draw" | "upload"; agree: boolean; code: string; fields?: Record<string, string> },
): Promise<ActionResult> {
  const turn = await loadTurn(contractId);
  if ("error" in turn) return { ok: false, error: turn.error };
  const { user, data, signer } = turn;

  if (!input.agree) return { ok: false, error: "تایید مطالعه‌ی قرارداد الزامی است" };
  const parsed = parseSignatureDataUrl(input.signature);
  if ("error" in parsed) return { ok: false, error: parsed.error };

  // فیلدهای قرارداد پیش از مصرف OTP اعتبارسنجی می‌شوند تا خطای فرم کد را نسوزاند
  const prepared = prepareFieldValues(data.contract.bodyHtml, data.signers, signer, input.fields);
  if (!prepared.ok) return { ok: false, error: prepared.error };

  const { ip } = await getRequestInfo();
  if (!rateLimit(`sign:user:${user.id}`, 20, 15 * 60_000).ok || !rateLimit(`sign:ip:${ip}`, 60, 15 * 60_000).ok) {
    return { ok: false, error: "تلاش‌های زیاد؛ چند دقیقه بعد دوباره امتحان کنید" };
  }
  const otp = await verifyOtp(signer.id, input.code || "");
  if (!otp.ok) {
    await logAudit({ action: "otp.failed", contractId, userId: user.id, detail: otp.error });
    return { ok: false, error: otp.error };
  }
  await logAudit({ action: "otp.verified", contractId, userId: user.id });

  return applySignature({ contract: data.contract, signer, user, buffer: parsed.buffer, method: input.method === "upload" ? "upload" : "draw", via: "account", fieldValues: prepared.rows });
}

export async function rejectContractAction(contractId: number, reason: string): Promise<ActionResult> {
  const turn = await loadTurn(contractId);
  if ("error" in turn) return { ok: false, error: turn.error };
  return applyRejection({ contract: turn.data.contract, signer: turn.signer, user: turn.user, reason: String(reason || "") });
}
