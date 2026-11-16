import { APP_VERSION } from "@/lib/version";
import { ROLLBACK_DIR, ROOT, STAGING_DIR, g } from "./paths";
import { applyStaged, download, extract } from "./package";
import { checkForUpdate, saveUpdateState, updateSupport } from "./info";
import { parseManifest } from "./manifest";
import fs from "node:fs";
import { getLicenseInfo } from "../client";
import { logAudit } from "@/modules/audit/service";
import path from "node:path";
import { pushHistory, rollbackAvailable } from "./history";
import { runBackup } from "@/modules/backup/service";

export function scheduleRestart(delayMs = 2000) {
  // Passenger / cPanel: لمس tmp/restart.txt؛ سایر مدیرهای پردازه (Docker, systemd, pm2): خروج و راه‌اندازی دوباره
  try {
    const tmp = path.join(ROOT, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, "restart.txt"), String(Date.now()));
  } catch {
    /* ناچیز */
  }
  if (process.env.NODE_ENV === "production") setTimeout(() => process.exit(0), delayMs).unref?.();
}
export type UpdateResult = { ok: true; version: string; message: string } | { ok: false; error: string };
/** نصب نسخه‌ی جدید (کل فرایند ۱ تا ۶) */
export async function installUpdate(actorId: number): Promise<UpdateResult> {
  const support = updateSupport();
  if (!support.supported) return { ok: false, error: support.reason };
  if (g.__emzUpdating) return { ok: false, error: "یک به‌روزرسانی در حال انجام است" };
  g.__emzUpdating = true;
  try {
    const lic = await getLicenseInfo();
    if (!lic.licensed) return { ok: false, error: "برای به‌روزرسانی، لایسنس باید فعال و معتبر باشد." };
    const info = await checkForUpdate(); // مانیفست تازه و امضاشده
    // C-01: نصب فقط با مانیفستی که «همین الان» از سرور گرفته و امضایش راستی‌آزمایی شده است؛ در خطای بررسی،
    // وضعیت ذخیره‌شده‌ی قبلی هرگز برای نصب استفاده نمی‌شود.
    if (info.error) return { ok: false, error: info.error };
    const manifest = parseManifest(info.latest);
    if (!info.updateAvailable || !manifest) return { ok: false, error: "نسخه‌ی جدیدتری موجود نیست." };
    const { version, sha256, size } = manifest;

    const zip = await download(version, sha256, size);
    const backup = await runBackup("manual");
    if (!backup.ok) throw new Error(`پشتیبان‌گیری پیش از به‌روزرسانی ناموفق بود؛ نصب انجام نشد (${backup.error})`);

    await extract(zip, STAGING_DIR);
    const rollbackTo = path.join(ROLLBACK_DIR, `${APP_VERSION}-${Date.now()}`);
    applyStaged(STAGING_DIR, rollbackTo);
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
    // نگه‌داشتن فقط ۲ نسخه‌ی بازگشت
    const olds = fs.readdirSync(ROLLBACK_DIR).sort();
    for (const d of olds.slice(0, Math.max(0, olds.length - 2))) fs.rmSync(path.join(ROLLBACK_DIR, d), { recursive: true, force: true });

    await pushHistory({ at: new Date().toISOString(), from: APP_VERSION, to: version, kind: "update" });
    await saveUpdateState({ checkedAt: new Date().toISOString(), updateAvailable: false, latest: info.latest, error: null });
    await logAudit({ workspaceId: 0, userId: actorId, action: "update.installed", detail: `${APP_VERSION} ← ${version}` }).catch(() => undefined);
    scheduleRestart();
    return { ok: true, version, message: `نسخه‌ی ${version} نصب شد. برنامه تا چند ثانیه‌ی دیگر دوباره راه‌اندازی می‌شود؛ سپس صفحه را تازه کنید.` };
  } catch (e) {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    return { ok: false, error: e instanceof Error ? e.message : "به‌روزرسانی ناموفق بود" };
  } finally {
    g.__emzUpdating = false;
  }
}
/** بازگشت به نسخه‌ی پیش از آخرین به‌روزرسانی */
export async function rollbackUpdate(actorId: number): Promise<UpdateResult> {
  const support = updateSupport();
  if (!support.supported) return { ok: false, error: support.reason };
  const name = rollbackAvailable();
  if (!name) return { ok: false, error: "نسخه‌ای برای بازگشت وجود ندارد." };
  if (g.__emzUpdating) return { ok: false, error: "یک عملیات در حال انجام است" };
  g.__emzUpdating = true;
  try {
    const dir = path.join(ROLLBACK_DIR, name);
    const swap = path.join(ROLLBACK_DIR, `.swap-${Date.now()}`);
    applyStaged(dir, swap);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(swap, { recursive: true, force: true });
    const version = name.split("-")[0];
    await pushHistory({ at: new Date().toISOString(), from: APP_VERSION, to: version, kind: "rollback" });
    await logAudit({ workspaceId: 0, userId: actorId, action: "update.rolled_back", detail: `${APP_VERSION} ← ${version}` }).catch(() => undefined);
    scheduleRestart();
    return { ok: true, version, message: `به نسخه‌ی ${version} بازگشت داده شد؛ برنامه دوباره راه‌اندازی می‌شود.` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "بازگشت ناموفق بود" };
  } finally {
    g.__emzUpdating = false;
  }
}
