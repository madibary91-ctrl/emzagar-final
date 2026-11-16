import { getCurrentUser } from "@/modules/auth/session";
import { getContractForUser, signerTurnForUser } from "@/modules/contracts/service";
import { hasGuestSession, resolveSigningToken } from "@/modules/signing/links";
import type { SignerCtx } from "./service";

export type ActorResult = { ok: true; ctx: SignerCtx; via: "guest" | "account" } | { ok: false; error: string; status: number };

/**
 * هویتِ فراخواننده در مراحل تأیید هویت امضاکننده.
 *  - مهمان: لینک اختصاصی معتبر + نشست OTP (مرحله‌ی هویت «بعد از» OTP است؛ بدون تصاحب موبایل هیچ استعلامی اجرا نمی‌شود)
 *  - کاربر حساب‌دار: باید «امضاکننده‌ی نوبتِ فعلی» همان قرارداد باشد
 */
export async function guestActor(token: string): Promise<ActorResult> {
  const st = await resolveSigningToken(String(token || ""));
  if (st.status !== "ok") return { ok: false, error: "لینک امضا نامعتبر یا بسته شده است", status: 400 };
  const { link, signer, contract, user } = st.ctx;
  if (!(await hasGuestSession(link.id, signer.id))) return { ok: false, error: "ابتدا کد پیامکی را تأیید کنید", status: 401 };
  return { ok: true, via: "guest", ctx: { signerId: signer.id, contractId: contract.id, workspaceId: contract.workspaceId, contractNumber: contract.number, signerLabel: signer.label, mobile: user.mobile, userId: user.id } };
}

export async function accountActor(contractId: number): Promise<ActorResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "ابتدا وارد حساب شوید", status: 401 };
  const data = await getContractForUser(user, Number(contractId));
  if (!data) return { ok: false, error: "قرارداد یافت نشد یا دسترسی ندارید", status: 404 };
  if (data.contract.status !== "sent") return { ok: false, error: "این قرارداد دیگر قابل امضا نیست", status: 400 };
  const signer = signerTurnForUser(data.signers, user.id);
  if (!signer) return { ok: false, error: "نوبت امضای شما نیست", status: 403 };
  return { ok: true, via: "account", ctx: { signerId: signer.id, contractId: data.contract.id, workspaceId: data.contract.workspaceId, contractNumber: data.contract.number, signerLabel: signer.label, mobile: user.mobile, userId: user.id } };
}
