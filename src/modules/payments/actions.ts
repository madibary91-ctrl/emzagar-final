"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { logAudit } from "@/modules/audit/service";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { saveReferralConfig } from "@/modules/referral/service";
import { sanitizeReferralConfig } from "@/modules/referral/config";
import { resetGatewayHealth, saveCredential, savePrefs } from "./registry";
import { REAL_GATEWAY_IDS } from "./types";

const back = (q: string) => redirect(`/platform/commerce?${q}`);

/** ذخیره‌ی اولویت، فعال/غیرفعال و اعتبارنامه‌ی هر درگاه (فقط مدیر کل). اعتبارنامه‌ی خالی = بدون تغییر. */
export async function saveGatewaysAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  // اولویت: هر درگاه یک عدد (۱ = اول)
  const ranked = REAL_GATEWAY_IDS.map((id) => ({ id, p: Number(formData.get(`priority_${id}`)) || 99 })).sort((a, b) => a.p - b.p).map((x) => x.id);
  const disabled = REAL_GATEWAY_IDS.filter((id) => formData.get(`enabled_${id}`) !== "on");
  await savePrefs({ order: ranked, disabled });
  for (const id of REAL_GATEWAY_IDS) {
    const val = String(formData.get(`cred_${id}`) || "").trim();
    const clear = formData.get(`clear_${id}`) === "on";
    if (clear) await saveCredential(id, "");
    else if (val) {
      const r = await saveCredential(id, val);
      if (!r.ok) back(`error=${encodeURIComponent(r.error || "اعتبارنامه نامعتبر")}`);
    }
  }
  resetGatewayHealth();
  await logAudit({ action: "settings.updated", userId: admin.id, detail: "تنظیم درگاه‌های پرداخت" });
  revalidatePath("/platform/commerce");
  back("saved=gateways");
}

/** پاداش‌های دعوت از دوستان */
export async function saveReferralConfigAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const raw: Record<string, unknown> = {};
  for (const k of ["referrerWallet", "referrerCredits", "referredWallet", "referredCredits", "milestoneEvery", "milestoneDays", "maxRewarded"]) raw[k] = formData.get(k);
  raw.enabled = formData.get("enabled") === "on";
  await saveReferralConfig(sanitizeReferralConfig(raw));
  await logAudit({ action: "settings.updated", userId: admin.id, detail: "تنظیم پاداش دعوت از دوستان" });
  revalidatePath("/platform/commerce");
  back("saved=referral");
}
