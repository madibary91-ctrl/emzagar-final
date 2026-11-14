"use server";

import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { rateLimit } from "@/lib/rate-limit";
import { provisionRecoveryKey, runBackup, verifyLatestBackup } from "./service";

/** بک‌آپ فوری (فقط مدیر کل پلتفرم) */
export async function runBackupNowAction() {
  const admin = await requirePlatformAdmin();
  if (!rateLimit(`backup:${admin.id}`, 5, 60 * 60_000).ok) redirect("/platform?backup=limited");
  const r = await runBackup("manual");
  redirect(`/platform?backup=${r.ok ? "ok" : "failed"}`);
}

export async function verifyBackupAction() {
  await requirePlatformAdmin();
  const v = await verifyLatestBackup();
  redirect(`/platform?backup=${!v ? "none" : v.ok ? "verified" : "corrupt"}`);
}

export type RecoveryKeyResult = { ok: true; privateKey: string; fingerprint: string; backupOk: boolean } | { ok: false; error: string };

/**
 * ساخت (یا چرخش) کلید بازیابی بک‌آپ — فقط مدیر کل. کلید خصوصی «فقط همین یک بار» برگردانده می‌شود و ذخیره نمی‌شود؛
 * بلافاصله یک بک‌آپ جدید با رازِ مهر‌شده گرفته می‌شود تا پوشش کامل از همین لحظه شروع شود.
 */
export async function generateRecoveryKeyAction(): Promise<RecoveryKeyResult> {
  const admin = await requirePlatformAdmin();
  if (!rateLimit(`backup-key:${admin.id}`, 5, 60 * 60_000).ok) return { ok: false, error: "تعداد درخواست‌ها زیاد است؛ بعداً تلاش کنید." };
  try {
    const k = provisionRecoveryKey();
    const r = await runBackup("manual");
    return { ok: true, privateKey: k.privateKey, fingerprint: k.fingerprint, backupOk: r.ok };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "ساخت کلید ناموفق بود" };
  }
}
