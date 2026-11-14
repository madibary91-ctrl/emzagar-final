import { bool, num } from "./core";
import { db } from "@/db";
import { eq } from "drizzle-orm";
import { wpConnections } from "@/db/schema";

/* ───────────── عمق یکپارچگی ───────────── */

export type Features = {
  gates: number;
  productContracts: number;
  orderAutomation: boolean;
  roles: boolean;
  badge: boolean;
  digest: boolean;
  adminBar: boolean;
  widget: boolean;
  portal: boolean;
  syncOrders: boolean;
  wcActive: boolean;
  gateChecks: number;
  gateAllowed: number;
  /** قوانین اتوماسیون فعال در وردپرس */
  automations: number;
  /** تعداد اجرای موفق اتوماسیون‌ها (۳۰ روز اخیر) */
  automationRuns: number;
  /** فرم‌هایی که به صدور خودکار قرارداد وصل شده‌اند */
  forms: number;
  /** میز کار قراردادها داخل وردپرس حداقل یک بار استفاده شده */
  workspaceUsed: boolean;
  /** اعلان زنده و پالت فرمان فعال است */
  live: boolean;
  /** تعداد کنش‌هایی که مدیر بدون خروج از وردپرس انجام داده (یادآوری، لغو، صدور، دانلود) */
  actions: number;
};
/** فقط کلیدهای شناخته‌شده با نوع و سقف مشخص پذیرفته می‌شوند */
export function sanitizeFeatures(raw: unknown): Features {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    gates: num(r.gates),
    productContracts: num(r.productContracts),
    orderAutomation: bool(r.orderAutomation),
    roles: bool(r.roles),
    badge: bool(r.badge),
    digest: bool(r.digest),
    adminBar: bool(r.adminBar),
    widget: bool(r.widget),
    portal: bool(r.portal),
    syncOrders: bool(r.syncOrders),
    wcActive: bool(r.wcActive),
    gateChecks: num(r.gateChecks, 1e9),
    gateAllowed: num(r.gateAllowed, 1e9),
    automations: num(r.automations, 500),
    automationRuns: num(r.automationRuns, 1e9),
    forms: num(r.forms, 500),
    workspaceUsed: bool(r.workspaceUsed),
    live: bool(r.live),
    actions: num(r.actions, 1e9),
  };
}
export function parseFeatures(json: string): Features {
  try {
    return sanitizeFeatures(JSON.parse(json));
  } catch {
    return sanitizeFeatures({});
  }
}
export async function saveFeatures(connId: number, raw: unknown): Promise<Features> {
  const f = sanitizeFeatures(raw);
  await db.update(wpConnections).set({ integrationJson: JSON.stringify(f), integrationAt: new Date() }).where(eq(wpConnections.id, connId));
  return f;
}
