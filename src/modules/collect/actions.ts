"use server";

import { revalidatePath } from "next/cache";
import { rateLimitDb } from "@/lib/rate-limit-db";
import { getRequestInfo } from "@/lib/request";
import { normalizeMobile } from "@/modules/guests/service";
import { sendMobileCode, verifyMobileCode } from "@/modules/mobile/otp";
import { getAllSettings } from "@/modules/settings/service";
import { requireTeam } from "@/modules/tenancy/context";
import { acceptingState, CollectError, createCampaign, deleteCampaign, getCampaignByCode, submitCollect, updateCampaignSettings, voidSubmission, type CampaignInput } from "./service";

export type CollectResult = {
  ok: boolean;
  error?: string;
  seconds?: number;
  devCode?: string;
  proof?: string;
  receipt?: string;
  key?: string;
  message?: string;
  id?: number;
  code?: string;
};

/* ───────── عمومی (بدون ورود) ───────── */

export async function collectSendCodeAction(code: string, mobile: string): Promise<CollectResult> {
  const { ip } = await getRequestInfo();
  if (!(await rateLimitDb(`colcode:ip:${ip}`, 15, 60 * 60_000)).ok) return { ok: false, error: "درخواست‌های زیاد؛ کمی بعد دوباره تلاش کنید" };
  const c = await getCampaignByCode(String(code || ""));
  if (!c || !(await acceptingState(c)).open) return { ok: false, error: "این فرم در حال حاضر امضا نمی‌پذیرد" };
  const m = normalizeMobile(mobile);
  if (!m) return { ok: false, error: "شماره‌ی موبایل معتبر نیست؛ به‌صورت 09123456789 وارد کنید" };
  const cfg = await getAllSettings(c.workspaceId);
  return sendMobileCode({ purpose: "collect", scope: c.code, mobile: m, ip, workspaceId: c.workspaceId, siteName: cfg.site_name });
}

export async function collectVerifyCodeAction(code: string, mobile: string, otp: string): Promise<CollectResult> {
  const { ip } = await getRequestInfo();
  const m = normalizeMobile(mobile);
  if (!m) return { ok: false, error: "شماره‌ی موبایل معتبر نیست" };
  if (!(await rateLimitDb(`colverify:ip:${ip}`, 40, 15 * 60_000)).ok || !(await rateLimitDb(`colverify:m:${m}`, 15, 15 * 60_000)).ok) return { ok: false, error: "تلاش‌های ناموفق زیاد بود؛ چند دقیقه بعد دوباره امتحان کنید" };
  const r = await verifyMobileCode({ purpose: "collect", scope: String(code || ""), mobile: m, code: otp });
  return r.ok ? { ok: true, proof: r.proof } : { ok: false, error: r.error };
}

export async function collectSubmitAction(code: string, payload: { fullName: string; mobile: string; values?: Record<string, string>; proof?: string; signature?: string; agree: boolean }): Promise<CollectResult> {
  const { ip, userAgent } = await getRequestInfo();
  if (!(await rateLimitDb(`colsubmit:ip:${ip}`, 30, 60 * 60_000)).ok) return { ok: false, error: "تعداد ثبت از این شبکه زیاد بود؛ کمی بعد دوباره تلاش کنید" };
  try {
    const r = await submitCollect({
      code: String(code || ""),
      fullName: String(payload?.fullName ?? ""),
      mobile: String(payload?.mobile ?? ""),
      values: payload?.values && typeof payload.values === "object" ? payload.values : undefined,
      proof: String(payload?.proof ?? ""),
      signature: typeof payload?.signature === "string" ? payload.signature : undefined,
      agree: payload?.agree === true,
      ip,
      userAgent,
    });
    return { ok: true, receipt: r.receipt, key: r.key, message: r.message };
  } catch (e) {
    if (e instanceof CollectError) return { ok: false, error: e.message };
    console.error("[collect:submit]", e);
    return { ok: false, error: "ثبت انجام نشد؛ دوباره تلاش کنید" };
  }
}

/* ───────── مدیر (تیم) ───────── */

export async function createCampaignAction(input: CampaignInput & { closesAtIso?: string }): Promise<CollectResult> {
  const admin = await requireTeam("write");
  try {
    const closesAt = input.closesAtIso ? new Date(input.closesAtIso) : null;
    const r = await createCampaign(admin.workspaceId, admin.id, { ...input, closesAt: closesAt && !Number.isNaN(closesAt.getTime()) ? closesAt : null });
    revalidatePath("/admin/collect");
    return { ok: true, id: r.id, code: r.code };
  } catch (e) {
    if (e instanceof CollectError) return { ok: false, error: e.message };
    console.error("[collect:create]", e);
    return { ok: false, error: "ساخت انجام نشد؛ دوباره تلاش کنید" };
  }
}

export async function updateCampaignAction(id: number, patch: { status?: string; title?: string; maxSubmissions?: number | null; closesAtIso?: string | null; successMessage?: string; description?: string }): Promise<CollectResult> {
  const admin = await requireTeam("write");
  try {
    const closesAt = patch.closesAtIso === undefined ? undefined : patch.closesAtIso ? new Date(patch.closesAtIso) : null;
    await updateCampaignSettings(Number(id), admin.workspaceId, admin.id, { ...patch, closesAt: closesAt && Number.isNaN(closesAt.getTime()) ? null : closesAt });
    revalidatePath(`/admin/collect/${id}`);
    revalidatePath("/admin/collect");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof CollectError ? e.message : "ذخیره انجام نشد" };
  }
}

export async function voidSubmissionAction(id: number, reason: string): Promise<CollectResult> {
  const admin = await requireTeam("write");
  const ok = await voidSubmission(Number(id), admin.workspaceId, admin.id, String(reason || ""));
  revalidatePath("/admin/collect");
  return ok ? { ok: true } : { ok: false, error: "این امضا پیدا نشد یا قبلاً باطل شده است" };
}

export async function deleteCampaignAction(id: number): Promise<CollectResult> {
  const admin = await requireTeam("delete");
  await deleteCampaign(Number(id), admin.workspaceId, admin.id);
  revalidatePath("/admin/collect");
  return { ok: true };
}
