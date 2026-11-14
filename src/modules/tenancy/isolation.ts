import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { workspaceMembers, workspaces } from "@/db/schema";
import { getSetting, saveSettings } from "@/modules/settings/service";

/**
 * ── فضای کاری «ایزوله» (Isolated Workspace) ─────────────────────────────────────
 *
 * قراردادهای «ارسال سریع» متعلق به کاربرانِ بدون حساب‌اند. نگهداری آن‌ها در یک فضای کاری سیستمی
 * نباید به معنای «دیده‌شدن توسط هیچ مدیری» باشد؛ بنابراین این فضا با یک پرچم صریح در دیتابیس (`workspaces.kind = 'quick'`)
 * علامت می‌خورد و در «همه‌ی» نقاطی که ممکن بود محتوا یا فراداده‌ی آن را به یک انسان برسانند، کنار گذاشته می‌شود:
 *
 *   • عضویت/پنل/فهرست تعویض فضا  → getMemberships (هیچ نقش تیمی‌ای از این فضا وجود ندارد)
 *   • دسترسی مستقیم به قرارداد    → getContractForUser (نقش تیمی نادیده گرفته می‌شود)
 *   • آمار و فهرست مدیر کل        → /platform (فقط عدد تجمیعی، بدون نام و بدون محتوا)
 *   • پروفایل عمومی اعتماد        → trustProfile
 *   • ایمیل/اعلان مدیریتی         → نسخه‌ی نهایی، انقضا، تمدید (هرگز به admin_email نمی‌رود)
 *   • دعوت/افزودن عضو             → createInvite / findInvite
 *
 * پیش‌تر ایزولاسیون فقط «ضمنی» بود (مالک مهمان و بدون رمز)؛ اکنون صریح، قابل آزمون و خودترمیم‌شونده است.
 */
export const WS_KIND_TEAM = "team";
export const WS_KIND_QUICK = "quick";

/** شرط SQL: فقط فضاهای کاری عادی (برای هر فهرست/آماری که انسان می‌بیند) */
export const visibleWorkspace = () => ne(workspaces.kind, WS_KIND_QUICK);

export async function isIsolatedWorkspace(workspaceId: number | null | undefined): Promise<boolean> {
  if (!workspaceId) return false;
  const [w] = await db.select({ kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return !!w && w.kind !== WS_KIND_TEAM;
}

const TEAM_ROLES = ["owner", "admin", "member", "viewer"];
const sealed = new Set<string>();

/**
 * (ایدمپوتنت) فضای ارسال سریع را مُهر می‌کند:
 *   ۱) kind = quick (برای دیتابیس‌هایی که پیش از این اصلاح ساخته شده‌اند)
 *   ۲) admin_email خالی (پیش‌فرض «admin@example.com» نباید نسخه‌ی نهایی سند خصوصی را دریافت کند)
 *   ۳) هر عضو تیمیِ غیر از مالک سیستمی حذف می‌شود
 */
export async function sealIsolatedWorkspace(workspaceId: number, systemOwnerId: number, opts: { force?: boolean } = {}): Promise<void> {
  const key = `${workspaceId}:${systemOwnerId}`;
  if (!opts.force && sealed.has(key)) return;
  await db.update(workspaces).set({ kind: WS_KIND_QUICK }).where(and(eq(workspaces.id, workspaceId), ne(workspaces.kind, WS_KIND_QUICK)));
  if ((await getSetting("admin_email", workspaceId)) !== "") await saveSettings({ admin_email: "" }, workspaceId);
  await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.role, TEAM_ROLES), ne(workspaceMembers.userId, systemOwnerId)));
  sealed.add(key);
}
