"use server";

import { revalidatePath } from "next/cache";
import { getOrigin } from "@/lib/request";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { activateLicense, refreshLicense, removeLicense } from "./client";
import { checkForUpdate, installUpdate, rollbackUpdate } from "./updater";
import { issueLicense, licenseServerEnabled, releaseActivation, setLicenseStatus, setReleaseYanked, type LicensePlan } from "./server";

export type LicenseActionState = { ok?: string; error?: string; key?: string };

const done = () => revalidatePath("/platform/license");

/* ───────── خریدار ───────── */

export async function activateLicenseAction(_p: LicenseActionState, fd: FormData): Promise<LicenseActionState> {
  const admin = await requirePlatformAdmin();
  const origin = await getOrigin();
  let host: string | undefined;
  try {
    host = origin ? new URL(origin).host : undefined;
  } catch {
    host = undefined;
  }
  const r = await activateLicense(String(fd.get("key") || ""), host, admin.id);
  done();
  return r.ok ? { ok: "لایسنس با موفقیت فعال شد." } : { error: r.error };
}

export async function refreshLicenseAction(): Promise<LicenseActionState> {
  await requirePlatformAdmin();
  const info = await refreshLicense();
  done();
  return info.lastError ? { error: info.lastError } : { ok: "وضعیت لایسنس به‌روز شد." };
}

export async function removeLicenseAction(): Promise<LicenseActionState> {
  const admin = await requirePlatformAdmin();
  await removeLicense(admin.id);
  done();
  return { ok: "لایسنس از این نصب حذف شد." };
}

export async function checkUpdateAction(): Promise<LicenseActionState> {
  await requirePlatformAdmin();
  const info = await checkForUpdate();
  done();
  if (info.error) return { error: info.error };
  return { ok: info.updateAvailable && info.latest ? `نسخه‌ی ${info.latest.version} در دسترس است.` : "شما از آخرین نسخه استفاده می‌کنید." };
}

export async function installUpdateAction(): Promise<LicenseActionState> {
  const admin = await requirePlatformAdmin();
  const r = await installUpdate(admin.id);
  done();
  return r.ok ? { ok: r.message } : { error: r.error };
}

export async function rollbackUpdateAction(): Promise<LicenseActionState> {
  const admin = await requirePlatformAdmin();
  const r = await rollbackUpdate(admin.id);
  done();
  return r.ok ? { ok: r.message } : { error: r.error };
}

/* ───────── فروشنده (سرور لایسنس) ───────── */

async function vendorGuard() {
  const admin = await requirePlatformAdmin();
  if (!licenseServerEnabled()) throw new Error("سرور لایسنس روی این نصب فعال نیست (LICENSE_SERVER_ENABLED=1)");
  return admin;
}

const int = (v: FormDataEntryValue | null, min: number, max: number, def: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

export async function issueLicenseAction(_p: LicenseActionState, fd: FormData): Promise<LicenseActionState> {
  try {
    await vendorGuard();
    const name = String(fd.get("customerName") || "").trim();
    if (name.length < 2) return { error: "نام خریدار را وارد کنید" };
    const plan = (["standard", "extended", "enterprise"].includes(String(fd.get("plan"))) ? String(fd.get("plan")) : "standard") as LicensePlan;
    const days = int(fd.get("expiresInDays"), 0, 36500, 0);
    const upd = int(fd.get("updatesInDays"), 0, 36500, 365);
    const row = await issueLicense({
      customerName: name,
      customerEmail: String(fd.get("customerEmail") || "").trim(),
      plan,
      maxDomains: int(fd.get("maxDomains"), 1, 500, 1),
      expiresInDays: days || null,
      updatesInDays: upd || null,
      notes: String(fd.get("notes") || "").trim(),
    });
    revalidatePath("/platform/vendor");
    return { ok: "لایسنس صادر شد. کلید را برای خریدار بفرستید:", key: row.key };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "خطا" };
  }
}

export async function setLicenseStatusAction(fd: FormData): Promise<void> {
  await vendorGuard();
  const status = String(fd.get("status"));
  if (!["active", "suspended", "revoked"].includes(status)) return;
  await setLicenseStatus(Number(fd.get("id")), status as "active" | "suspended" | "revoked");
  revalidatePath("/platform/vendor");
}

export async function releaseActivationAction(fd: FormData): Promise<void> {
  await vendorGuard();
  await releaseActivation(Number(fd.get("id")));
  revalidatePath("/platform/vendor");
}

export async function yankReleaseAction(fd: FormData): Promise<void> {
  await vendorGuard();
  await setReleaseYanked(Number(fd.get("id")), fd.get("yanked") === "1");
  revalidatePath("/platform/vendor");
}
