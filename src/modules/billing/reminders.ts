import { and, eq, gt, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { subscriptionNotices, subscriptions, users, workspaceMembers } from "@/db/schema";
import { escapeHtml } from "@/lib/html";
import { fa } from "@/lib/jalali";
import { logAudit } from "@/modules/audit/service";
import { notifyTeam } from "@/modules/inbox/service";
import { sendMail } from "@/modules/mail";
import { getAllSettings } from "@/modules/settings/service";
import { isIsolatedWorkspace } from "@/modules/tenancy/isolation";
import { getPlanById, listAllPlans, pickDefault } from "./catalog";
import { DAY_MS } from "./proration";

/**
 * یادآوری انقضای اشتراک: ۷ روز، ۳ روز و ۱ روز مانده + «منقضی شد» (تا ۳ روز پس از انقضا).
 * هر مرحله برای هر «پایان دوره» دقیقاً یک‌بار (claim اتمیک با ایندکس یکتای subscription_notices)؛ تمدید، پایان دوره را عوض می‌کند و یادآوری‌های دوره‌ی بعد را تازه می‌کند.
 * اگر سرور چند روز خاموش بوده، فقط «فوری‌ترین» مرحله‌ی فعلی فرستاده می‌شود (نه سه پیام پشت‌سرهم).
 */
export type NoticeStage = "d7" | "d3" | "d1" | "expired";
const GRACE_AFTER_EXPIRY_MS = 3 * DAY_MS;

export function noticeStageFor(periodEnd: Date, now = new Date()): NoticeStage | null {
  const left = periodEnd.getTime() - now.getTime();
  if (left <= 0) return -left <= GRACE_AFTER_EXPIRY_MS ? "expired" : null;
  if (left <= DAY_MS) return "d1";
  if (left <= 3 * DAY_MS) return "d3";
  if (left <= 7 * DAY_MS) return "d7";
  return null;
}

function copy(stage: NoticeStage, planName: string, end: Date): { title: string; body: string; kind: "action" | "warning" } {
  const when = fa(end);
  switch (stage) {
    case "d7":
      return { kind: "action", title: `۷ روز تا پایان اشتراک «${planName}»`, body: `اشتراک شما تا ${when} معتبر است. برای جلوگیری از قطع امکانات، از همین حالا تمدید کنید.` };
    case "d3":
      return { kind: "action", title: `۳ روز تا پایان اشتراک «${planName}»`, body: `اشتراک شما در ${when} منقضی می‌شود و فضای کاری به طرح پایه برمی‌گردد. تمدید کنید.` };
    case "d1":
      return { kind: "warning", title: `کمتر از ۱ روز تا پایان اشتراک «${planName}»`, body: `اشتراک شما در ${when} منقضی می‌شود. همین امروز تمدید کنید.` };
    default:
      return { kind: "warning", title: `اشتراک «${planName}» منقضی شد`, body: `اشتراک شما در ${when} پایان یافت و فضای کاری به طرح پایه بازگشت. برای بازگشت امکانات، اشتراک را تمدید کنید.` };
  }
}

async function ownerEmails(workspaceId: number): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), sql`${workspaceMembers.role} in ('owner','admin')`, sql`${users.isGuest} = false`));
  return [...new Set(rows.map((r) => r.email).filter(Boolean))];
}

/** ارسال یادآوری‌های سررسیده؛ خروجی: تعداد فضاهای کاری که اعلان گرفتند */
export async function runSubscriptionReminders(now = new Date()): Promise<number> {
  const plans = await listAllPlans();
  const def = pickDefault(plans);
  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(ne(subscriptions.plan, def.id), gt(subscriptions.currentPeriodEnd, new Date(now.getTime() - GRACE_AFTER_EXPIRY_MS)), lte(subscriptions.currentPeriodEnd, new Date(now.getTime() + 7 * DAY_MS))))
    .limit(500);
  let sent = 0;
  for (const s of rows) {
    if (!s.currentPeriodEnd) continue;
    const stage = noticeStageFor(s.currentPeriodEnd, now);
    if (!stage) continue;
    const claimed = await db.insert(subscriptionNotices).values({ workspaceId: s.workspaceId, periodEnd: s.currentPeriodEnd, stage }).onConflictDoNothing().returning({ id: subscriptionNotices.id });
    if (claimed.length === 0) continue;
    try {
      const planName = (await getPlanById(s.plan).catch(() => null))?.name ?? s.plan;
      const c = copy(stage, planName, s.currentPeriodEnd);
      await notifyTeam(s.workspaceId, { kind: c.kind, title: c.title, body: c.body, href: "/admin/billing", dedupeKey: `sub-notice:${s.workspaceId}:${s.currentPeriodEnd.getTime()}:${stage}` }, [], ["owner", "admin"]);
      if (!(await isIsolatedWorkspace(s.workspaceId))) {
        const base = (await getAllSettings(s.workspaceId)).app_url.replace(/\/+$/, "");
        const html = `<div dir="rtl" style="font-family:Tahoma,sans-serif;line-height:2"><p>${escapeHtml(c.body)}</p>${base ? `<p><a href="${escapeHtml(base)}/admin/billing">تمدید یا ارتقای اشتراک</a></p>` : ""}</div>`;
        for (const to of await ownerEmails(s.workspaceId)) await sendMail({ to, subject: c.title, html, workspaceId: s.workspaceId }).catch((e) => console.error("[sub-notice:mail]", e instanceof Error ? e.message : e));
      }
      await logAudit({ action: "billing.expiry_notice", workspaceId: s.workspaceId, actor: "system", detail: `${stage} — ${planName}` }).catch(() => undefined);
      sent++;
    } catch (e) {
      // اعلان شکست خورد: claim را برمی‌گردانیم تا در دور بعد دوباره تلاش شود
      await db.delete(subscriptionNotices).where(eq(subscriptionNotices.id, claimed[0].id)).catch(() => undefined);
      console.error("[sub-notice]", s.workspaceId, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}
