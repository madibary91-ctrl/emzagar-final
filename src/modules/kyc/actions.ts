"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { rateLimit } from "@/lib/rate-limit";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { reviewKyc, saveKycThreshold } from "./service";
import { toLatinDigits } from "./rules";

/** تصمیم مدیر کل پلتفرم: تایید یا رد (با دلیل الزامی) */
export async function reviewKycAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const id = Number(formData.get("id"));
  const decision = formData.get("decision") === "approve" ? "approve" : "reject";
  if (!Number.isInteger(id)) redirect("/platform/kyc");
  if (!rateLimit(`kyc:review:${admin.id}`, 60, 60_000).ok) redirect(`/platform/kyc/${id}?error=${encodeURIComponent("درخواست‌ها زیاد است")}`);
  const r = await reviewKyc(id, admin.id, decision, String(formData.get("reason") || ""));
  revalidatePath("/platform/kyc");
  if (!r.ok) redirect(`/platform/kyc/${id}?error=${encodeURIComponent(r.error || "خطا")}`);
  redirect(`/platform/kyc?done=${decision}`);
}

/** تنظیم آستانه‌ی ارزش قرارداد برای الزام احراز هویت (0 = غیرفعال) */
export async function saveKycThresholdAction(formData: FormData) {
  await requirePlatformAdmin();
  const n = Number(toLatinDigits(String(formData.get("threshold") || "")).replace(/[,٬\s]/g, ""));
  if (Number.isFinite(n)) await saveKycThreshold(n);
  revalidatePath("/platform/commerce");
  redirect("/platform/commerce?saved=kyc");
}
