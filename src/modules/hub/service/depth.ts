import { type Features, parseFeatures } from "./features";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { wpConnections } from "@/db/schema";

export type DepthStep = { key: string; label: string; hint: string; weight: number; done: boolean; applies: boolean; where: string };
export type Depth = { score: number; level: string; levelIndex: number; steps: DepthStep[]; next: DepthStep | null };
export const DEPTH_LEVELS = ["شروع", "فعال", "یکپارچه", "هسته‌ی کسب‌وکار"];
export function computeDepth(f: Features, conn: { verified: boolean; syncEnabled: boolean }): Depth {
  const wc = f.wcActive;
  const steps: DepthStep[] = [
    { key: "connected", label: "اتصال تاییدشده‌ی دامنه", hint: "مالکیت دامنه‌ی شما تایید شده و سایت به فضای کاری وصل است.", weight: 10, done: conn.verified, applies: true, where: "emzagar" },
    { key: "sync", label: "همگام‌سازی دوطرفه‌ی لحظه‌ای", hint: "وضعیت امضا لحظه‌ای به وردپرس می‌رسد و سفارش‌ها در ابر دیده می‌شوند.", weight: 10, done: conn.syncEnabled, applies: true, where: "emzagar" },
    { key: "products", label: "قرارداد خودکار روی محصولات", hint: "در ویرایش هر محصول، قالب قرارداد را انتخاب کنید تا پس از خرید خودکار صادر شود.", weight: 15, done: f.productContracts > 0, applies: wc, where: "product" },
    { key: "orders", label: "اتوماسیون وضعیت سفارش", hint: "سفارش تا امضا نگه داشته شود و پس از امضا خودکار تکمیل گردد.", weight: 10, done: f.orderAutomation, applies: wc, where: "emzagar" },
    { key: "gates", label: "دروازه‌ی قرارداد روی محتوا و محصول", hint: "صفحه، نوشته یا محصولی را فقط برای کسانی که قرارداد امضا کرده‌اند باز کنید.", weight: 15, done: f.gates > 0, applies: true, where: "post" },
    { key: "roles", label: "نقش خودکار پس از امضا", hint: "با امضای قرارداد، نقش کاربری (مثلاً «مشتری تاییدشده») خودکار داده شود.", weight: 10, done: f.roles, applies: true, where: "emzagar-hub" },
    { key: "badge", label: "نشان اعتماد روی سایت", hint: "نشان «قراردادهای این کسب‌وکار با امضاگیر مستند می‌شود» اعتبار شما را به مشتری نشان می‌دهد.", weight: 10, done: f.badge, applies: true, where: "emzagar-hub" },
    { key: "digest", label: "گزارش هفتگی کسب‌وکار", hint: "هر هفته خلاصه‌ی امضاها، سفارش‌های معطل و ارزش آزاد‌شده به ایمیل شما می‌رسد.", weight: 5, done: f.digest, applies: true, where: "emzagar-hub" },
    { key: "portal", label: "پورتال قراردادهای مشتری", hint: "مشتری قراردادهایش را در «حساب کاربری» یا صفحه‌ی «قراردادهای من» می‌بیند.", weight: 5, done: f.portal, applies: true, where: "emzagar" },
    { key: "cockpit", label: "کابین فرماندهی در پیشخوان", hint: "نوار مدیریت و ویجت پیشخوان وضعیت لحظه‌ای را همیشه جلوی چشم شما می‌گذارد.", weight: 5, done: f.adminBar || f.widget, applies: true, where: "emzagar-hub" },
    { key: "workspace", label: "مدیریت قراردادها بدون خروج از وردپرس", hint: "از «میز کار قراردادها» قرارداد صادر، پیگیری، لغو و دانلود کنید؛ کانبان و پالت فرمان (Ctrl+K) همان‌جاست.", weight: 10, done: f.workspaceUsed, applies: true, where: "emzagar-workspace" },
    { key: "automations", label: "اتوماسیون «اگر ... آنگاه»", hint: "با یک کلیک دستورهای آماده را روشن کنید: پس از امضا نقش بدهید، وضعیت سفارش را عوض کنید، وب‌هوک بزنید یا وظیفه بسازید.", weight: 10, done: f.automations > 0, applies: true, where: "emzagar-automations" },
    { key: "forms", label: "فرم‌های سایت ← قرارداد خودکار", hint: "فرم تماس/ثبت‌نام (CF7، WPForms، Gravity، المنتور) را وصل کنید تا با ارسال فرم، قرارداد برای مشتری صادر شود.", weight: 5, done: f.forms > 0, applies: true, where: "emzagar-automations" },
    { key: "live", label: "اعلان زنده و پالت فرمان", hint: "امضای مشتری لحظه‌ای در همه‌ی صفحه‌های پیشخوان اعلام می‌شود و با Ctrl+K همه‌چیز جستجو می‌شود.", weight: 5, done: f.live, applies: true, where: "emzagar-hub" },
    { key: "usage", label: "دسترسی مشتریان بر پایه‌ی امضا", hint: "حداقل یک بار دسترسی یک مشتری بر پایه‌ی قرارداد امضاشده باز شده است.", weight: 5, done: f.gateAllowed > 0, applies: true, where: "emzagar-hub" },
  ];
  const applicable = steps.filter((s) => s.applies);
  const total = applicable.reduce((a, s) => a + s.weight, 0) || 1;
  const got = applicable.filter((s) => s.done).reduce((a, s) => a + s.weight, 0);
  const score = Math.round((got / total) * 100);
  const levelIndex = score >= 80 ? 3 : score >= 55 ? 2 : score >= 25 ? 1 : 0;
  const next = applicable.filter((s) => !s.done).sort((a, b) => b.weight - a.weight)[0] ?? null;
  return { score, level: DEPTH_LEVELS[levelIndex], levelIndex, steps: applicable, next };
}
/** نمای کوتاه برای صفحه‌ی مدیریت (همه‌ی اتصال‌های فضای کاری با عمق یکپارچگی) */
export async function depthForWorkspace(workspaceId: number) {
  const conns = await db.select().from(wpConnections).where(and(eq(wpConnections.workspaceId, workspaceId), eq(wpConnections.status, "active"))).orderBy(desc(wpConnections.createdAt));
  return conns.map((c) => {
    const f = parseFeatures(c.integrationJson);
    return { conn: c, features: f, depth: computeDepth(f, c), reportedAt: c.integrationAt };
  });
}
