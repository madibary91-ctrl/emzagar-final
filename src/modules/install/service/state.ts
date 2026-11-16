import { db } from "@/db";
import { discardInstallKey } from "./key";
import { getConfig, hasInstallLock, writeInstallLock } from "@/lib/config";
import { sql } from "drizzle-orm";
import { users } from "@/db/schema";

/* ───────── وضعیت نصب ───────── */
let installedMemo = false;
/**
 * وضعیت سه‌حالته (CR-03):
 *  - installed: قفل نصب هست یا دست‌کم یک کاربر در دیتابیس است.
 *  - fresh:     «به‌اثبات رسیده» که هنوز نصب نشده (آدرس دیتابیسی نیست، یا دیتابیس وصل است و جدول/کاربری ندارد).
 *  - unknown:   دیتابیس پیکربندی شده ولی نمی‌توان وضعیتش را خواند (قطعی، خطای دسترسی، …).
 *
 * قبلاً «unknown» هم مثل «fresh» رفتار می‌شد؛ یعنی با قطع موقت دیتابیس (و نبود lock-file) هر بازدیدکننده می‌توانست
 * نصب‌کننده را باز کند و حتی آدرس دیتابیس را بازنویسی کند. اکنون «نمی‌دانم» = «بسته» (fail-closed).
 */
export type InstallState = "installed" | "fresh" | "unknown";
/** خطای «جدول وجود ندارد» (42P01) یعنی دیتابیس وصل است ولی هنوز نصب نشده؛ drizzle خطای pg را در cause می‌پیچد */
function isUndefinedTable(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    if ((cur as { code?: string }).code === "42P01") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
export async function getInstallState(): Promise<InstallState> {
  if (installedMemo) return "installed";
  if (hasInstallLock()) {
    installedMemo = true;
    discardInstallKey();
    return "installed";
  }
  if (!getConfig().databaseUrl) return "fresh";
  try {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    if (row && row.n > 0) {
      try {
        writeInstallLock();
      } catch {
        /* حتی اگر قفل نوشته نشد، نصب‌شده است */
      }
      installedMemo = true;
      discardInstallKey();
      return "installed";
    }
    return "fresh";
  } catch (e) {
    return isUndefinedTable(e) ? "fresh" : "unknown";
  }
}
/** نصب‌شده = قفل نصب وجود دارد، یا دست‌کم یک کاربر در دیتابیس هست (سازگار با نصب‌های قدیمی) */
export async function isInstalled(): Promise<boolean> {
  return (await getInstallState()) === "installed";
}
export function finalizeInstall(): void {
  writeInstallLock();
  installedMemo = true;
  discardInstallKey();
}
