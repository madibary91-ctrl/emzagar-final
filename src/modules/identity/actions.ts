"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { rateLimit } from "@/lib/rate-limit";
import { getRequestInfo } from "@/lib/request";
import { requireTeam } from "@/modules/tenancy/context";
import { accountActor, guestActor, type ActorResult } from "./actor";
import { saveIdentityConfig } from "./provider";
import { parseIdentityReq, toLatinDigits } from "./rules";
import { resetAttempts, reviewDocuments, setRequirement, verifyShahkar } from "./service";

export type IdentityActionState = { ok?: boolean; error?: string; message?: string; attemptsLeft?: number };

async function limited(actor: Extract<ActorResult, { ok: true }>): Promise<boolean> {
  const { ip } = await getRequestInfo();
  return rateLimit(`idq:signer:${actor.ctx.signerId}`, 12, 60 * 60_000).ok && rateLimit(`idq:ip:${ip}`, 40, 60 * 60_000).ok;
}

/** امضاکننده‌ی مهمان: تطبیق موبایل ↔ کد ملی (پس از OTP) */
export async function guestVerifyShahkarAction(token: string, nationalCode: string): Promise<IdentityActionState> {
  const a = await guestActor(token);
  if (!a.ok) return { ok: false, error: a.error };
  if (!(await limited(a))) return { ok: false, error: "درخواست‌ها زیاد بود؛ کمی بعد دوباره تلاش کنید" };
  const r = await verifyShahkar(a.ctx, String(nationalCode || ""));
  if (r.ok) revalidatePath(`/contracts/${a.ctx.contractId}`);
  return r.ok ? { ok: true, attemptsLeft: r.attemptsLeft, message: "شماره‌ی موبایل شما با کد ملی تأیید شد" } : { ok: false, error: r.error };
}

/** امضاکننده‌ی دارای حساب (نوبت فعلی) */
export async function accountVerifyShahkarAction(contractId: number, nationalCode: string): Promise<IdentityActionState> {
  const a = await accountActor(contractId);
  if (!a.ok) return { ok: false, error: a.error };
  if (!(await limited(a))) return { ok: false, error: "درخواست‌ها زیاد بود؛ کمی بعد دوباره تلاش کنید" };
  const r = await verifyShahkar(a.ctx, String(nationalCode || ""));
  if (r.ok) revalidatePath(`/contracts/${a.ctx.contractId}`);
  return r.ok ? { ok: true, attemptsLeft: r.attemptsLeft, message: "شماره‌ی موبایل شما با کد ملی تأیید شد" } : { ok: false, error: r.error };
}

/** صادرکننده: تعیین/تغییر سطح هویت و کد ملی مورد انتظار یک امضاکننده */
export async function setIdentityRequirementAction(_prev: IdentityActionState, formData: FormData): Promise<IdentityActionState> {
  const admin = await requireTeam("write");
  const contractId = Number(formData.get("contractId"));
  const signerId = Number(formData.get("signerId"));
  if (!Number.isInteger(contractId) || !Number.isInteger(signerId)) return { ok: false, error: "درخواست نامعتبر است" };
  const r = await setRequirement({
    contractId,
    signerId,
    workspaceId: admin.workspaceId,
    actorId: admin.id,
    req: parseIdentityReq(formData.get("req")),
    expectedNc: String(formData.get("expectedNc") || ""),
  });
  revalidatePath(`/contracts/${contractId}`);
  return r.ok ? { ok: true, message: "سطح امنیت هویت ذخیره شد" } : { ok: false, error: r.error };
}

/** صادرکننده: تأیید یا رد مدارک هویتی */
export async function reviewIdentityDocsAction(_prev: IdentityActionState, formData: FormData): Promise<IdentityActionState> {
  const admin = await requireTeam("write");
  const contractId = Number(formData.get("contractId"));
  const signerId = Number(formData.get("signerId"));
  if (!Number.isInteger(contractId) || !Number.isInteger(signerId)) return { ok: false, error: "درخواست نامعتبر است" };
  if (!rateLimit(`idreview:${admin.id}`, 60, 60_000).ok) return { ok: false, error: "درخواست‌ها زیاد است" };
  const r = await reviewDocuments({
    contractId,
    signerId,
    workspaceId: admin.workspaceId,
    reviewerId: admin.id,
    decision: formData.get("decision") === "approve" ? "approve" : "reject",
    reason: String(formData.get("reason") || ""),
  });
  revalidatePath(`/contracts/${contractId}`);
  return r.ok ? { ok: true, message: formData.get("decision") === "approve" ? "مدارک تأیید شد؛ امضاکننده می‌تواند امضا کند" : "مدارک رد شد و دلیل برای امضاکننده نمایش داده می‌شود" } : { ok: false, error: r.error };
}

/** صادرکننده: بازنشانی سقف تلاش‌های استعلام */
export async function resetIdentityAttemptsAction(_prev: IdentityActionState, formData: FormData): Promise<IdentityActionState> {
  const admin = await requireTeam("write");
  const contractId = Number(formData.get("contractId"));
  const signerId = Number(formData.get("signerId"));
  if (!Number.isInteger(contractId) || !Number.isInteger(signerId)) return { ok: false, error: "درخواست نامعتبر است" };
  const r = await resetAttempts({ contractId, signerId, workspaceId: admin.workspaceId, actorId: admin.id });
  revalidatePath(`/contracts/${contractId}`);
  return r.ok ? { ok: true, message: "تلاش‌ها بازنشانی شد" } : { ok: false, error: r.error };
}

/** مدیر کل پلتفرم: پیکربندی سرویس استعلام شاهکار (حالت، توکن رمزنگاری‌شده، هزینه‌ی هر استعلام) */
export async function saveIdentityConfigAction(formData: FormData) {
  await requirePlatformAdmin();
  const price = Number(toLatinDigits(String(formData.get("price") || "0")).replace(/[,٬\s]/g, ""));
  await saveIdentityConfig({
    mode: String(formData.get("mode") || "off"),
    token: String(formData.get("token") || ""),
    clearToken: formData.get("clearToken") === "1",
    price: Number.isFinite(price) ? price : 0,
  });
  revalidatePath("/platform/identity");
  redirect("/platform/identity?saved=1");
}
