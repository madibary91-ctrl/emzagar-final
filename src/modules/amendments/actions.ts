"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { rateLimit } from "@/lib/rate-limit";
import { getRequestInfo } from "@/lib/request";
import { getCurrentUser } from "@/modules/auth/session";
import { requireTeam } from "@/modules/tenancy/context";
import { deliverSigningOtp } from "@/modules/signing/otp-delivery";
import type { ActionResult } from "@/modules/signing/types";
import { cancelAmendment, createAmendment, decideAmendment, resolveAmendForUser, resolveAmendToken, type AmendCtx } from "./service";

/** صدور الحاقیه توسط تیم (فرم صفحه‌ی قرارداد) */
export async function createAmendmentAction(formData: FormData) {
  const admin = await requireTeam("write");
  const contractId = Number(formData.get("contractId"));
  if (!Number.isInteger(contractId)) redirect("/admin");
  const r = await createAmendment({
    contractId,
    workspaceId: admin.workspaceId,
    title: String(formData.get("title") || ""),
    bodyText: String(formData.get("body") || ""),
    actorId: admin.id,
  });
  revalidatePath(`/contracts/${contractId}`);
  if (!r.ok) redirect(`/contracts/${contractId}?amend_error=${encodeURIComponent(r.error)}#amendments`);
  redirect(`/contracts/${contractId}?amended=1#amendments`);
}

export async function cancelAmendmentAction(formData: FormData) {
  const admin = await requireTeam("write");
  const contractId = Number(formData.get("contractId"));
  const amendmentId = Number(formData.get("amendmentId"));
  if (Number.isInteger(contractId) && Number.isInteger(amendmentId)) await cancelAmendment(contractId, admin.workspaceId, amendmentId, admin.id);
  revalidatePath(`/contracts/${contractId}`);
  redirect(`/contracts/${contractId}#amendments`);
}

/** هویت: یا لینک اختصاصی (token) یا کاربر واردشده (amendmentId) */
type Who = { token: string } | { amendmentId: number };

async function resolve(who: Who): Promise<AmendCtx | null> {
  if ("token" in who) return resolveAmendToken(String(who.token || ""));
  const user = await getCurrentUser();
  if (!user) return null;
  return resolveAmendForUser(Number(who.amendmentId), user.id);
}

export async function amendSendOtpAction(who: Who): Promise<ActionResult> {
  const ctx = await resolve(who);
  if (!ctx) return { ok: false, error: "الحاقیه یافت نشد یا دسترسی ندارید" };
  if (ctx.amendment.status !== "sent" || ctx.amSigner.status !== "pending") return { ok: false, error: "این الحاقیه دیگر در انتظار تصمیم شما نیست" };
  const { ip } = await getRequestInfo();
  if (!rateLimit(`asend:signer:${ctx.signer.id}`, 6, 60 * 60_000).ok || !rateLimit(`asend:ip:${ip}`, 20, 60 * 60_000).ok) {
    return { ok: false, error: "درخواست‌های ارسال کد زیاد بود؛ کمی بعد دوباره تلاش کنید" };
  }
  return deliverSigningOtp({ contractId: ctx.contract.id, workspaceId: ctx.contract.workspaceId, signer: ctx.signer, user: ctx.user });
}

export async function amendDecideAction(who: Who, input: { accept: boolean; code: string; agree?: boolean }): Promise<ActionResult> {
  const ctx = await resolve(who);
  if (!ctx) return { ok: false, error: "الحاقیه یافت نشد یا دسترسی ندارید" };
  if (input.accept && !input.agree) return { ok: false, error: "تأیید مطالعه‌ی الحاقیه الزامی است" };
  const meta = await getRequestInfo();
  if (!rateLimit(`adecide:signer:${ctx.signer.id}`, 10, 15 * 60_000).ok || !rateLimit(`adecide:ip:${meta.ip}`, 40, 15 * 60_000).ok) {
    return { ok: false, error: "تلاش‌های زیاد؛ چند دقیقه بعد دوباره امتحان کنید" };
  }
  const r = await decideAmendment(ctx, !!input.accept, input.code, meta);
  revalidatePath(`/contracts/${ctx.contract.id}`);
  return { ok: r.ok, error: r.error, completed: r.completed };
}
