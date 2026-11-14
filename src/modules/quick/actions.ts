"use server";

import { revalidatePath } from "next/cache";
import { rateLimitDb } from "@/lib/rate-limit-db";
import { getRequestInfo } from "@/lib/request";
import { normalizeMobile } from "@/modules/guests/service";
import { sendMobileCode, verifyMobileCode } from "@/modules/mobile/otp";
import { cancelQuick, createQuickSend, isQuickEnabled, QuickError, remindQuickRecipient, type QuickInput } from "./service";

export type QuickResult = { ok: boolean; error?: string; seconds?: number; devCode?: string; proof?: string; manageToken?: string };

export async function quickSendCodeAction(mobile: string): Promise<QuickResult> {
  if (!(await isQuickEnabled())) return { ok: false, error: "ارسال سریع غیرفعال است" };
  const { ip } = await getRequestInfo();
  if (!(await rateLimitDb(`quickcode:ip:${ip}`, 12, 60 * 60_000)).ok) return { ok: false, error: "درخواست‌های زیاد؛ کمی بعد دوباره تلاش کنید" };
  const m = normalizeMobile(mobile);
  if (!m) return { ok: false, error: "شماره‌ی موبایل معتبر نیست؛ به‌صورت 09123456789 وارد کنید" };
  return sendMobileCode({ purpose: "quick", scope: "sender", mobile: m, ip, siteName: "ارسال سریع" });
}

export async function quickVerifyCodeAction(mobile: string, code: string): Promise<QuickResult> {
  const { ip } = await getRequestInfo();
  const m = normalizeMobile(mobile);
  if (!m) return { ok: false, error: "شماره‌ی موبایل معتبر نیست" };
  if (!(await rateLimitDb(`quickverify:ip:${ip}`, 40, 15 * 60_000)).ok || !(await rateLimitDb(`quickverify:m:${m}`, 15, 15 * 60_000)).ok) return { ok: false, error: "تلاش‌های ناموفق زیاد بود؛ چند دقیقه بعد دوباره امتحان کنید" };
  const r = await verifyMobileCode({ purpose: "quick", scope: "sender", mobile: m, code });
  return r.ok ? { ok: true, proof: r.proof } : { ok: false, error: r.error };
}

export async function quickCreateAction(input: Omit<QuickInput, "ip">): Promise<QuickResult> {
  const { ip } = await getRequestInfo();
  if (!(await rateLimitDb(`quickcreate:ip:${ip}`, 10, 60 * 60_000)).ok) return { ok: false, error: "تعداد ارسال از این شبکه زیاد بود؛ کمی بعد دوباره تلاش کنید" };
  try {
    const r = await createQuickSend({
      title: String(input?.title ?? ""),
      bodyHtml: typeof input?.bodyHtml === "string" ? input.bodyHtml : undefined,
      draftCode: typeof input?.draftCode === "string" ? input.draftCode : undefined,
      placements: input?.placements,
      sender: { name: String(input?.sender?.name ?? ""), mobile: String(input?.sender?.mobile ?? "") },
      recipient: { name: String(input?.recipient?.name ?? ""), mobile: String(input?.recipient?.mobile ?? "") },
      proof: String(input?.proof ?? ""),
      signature: String(input?.signature ?? ""),
      method: input?.method === "upload" ? "upload" : "draw",
      agree: input?.agree === true,
      fields: input?.fields && typeof input.fields === "object" ? (input.fields as Record<string, string>) : undefined,
      ip,
    });
    return { ok: true, manageToken: r.manageToken };
  } catch (e) {
    if (e instanceof QuickError) return { ok: false, error: e.message };
    console.error("[quick:create]", e);
    return { ok: false, error: "ارسال انجام نشد؛ دوباره تلاش کنید" };
  }
}

export async function quickRemindAction(token: string): Promise<QuickResult> {
  const { ip } = await getRequestInfo();
  if (!(await rateLimitDb(`quickremind:${String(token).slice(0, 16)}`, 3, 24 * 3600_000)).ok || !(await rateLimitDb(`quickremind:ip:${ip}`, 20, 3600_000)).ok) return { ok: false, error: "یادآوری‌های امروز تکمیل شد" };
  return remindQuickRecipient(String(token || ""));
}

export async function quickCancelAction(token: string): Promise<QuickResult> {
  const { ip } = await getRequestInfo();
  if (!(await rateLimitDb(`quickcancel:ip:${ip}`, 20, 3600_000)).ok) return { ok: false, error: "تلاش‌های زیاد" };
  const r = await cancelQuick(String(token || ""));
  revalidatePath("/q");
  return r;
}
