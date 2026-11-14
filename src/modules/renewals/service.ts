import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { contracts, users } from "@/db/schema";
import { escapeHtml } from "@/lib/html";
import { fa } from "@/lib/jalali";
import { logAudit } from "@/modules/audit/service";
import { duplicateContract } from "@/modules/contracts/service";
import { notifyTeam } from "@/modules/inbox/service";
import { sendMail } from "@/modules/mail";
import { getAllSettings } from "@/modules/settings/service";
import { isIsolatedWorkspace } from "@/modules/tenancy/isolation";

const DAY = 86400000;

/** پایان مدت = تاریخ امضای نهایی + termDays (اگر هنگام صدور مدت تعیین شده باشد) */
export function termEndFor(signedAt: Date, termDays: number | null | undefined): Date | null {
  if (!termDays || termDays <= 0) return null;
  return new Date(signedAt.getTime() + Math.min(termDays, 36500) * DAY);
}

export type RenewalState = "none" | "ok" | "due" | "ended" | "renewed";

export function renewalState(c: { termEndsAt: Date | null; renewalNoticeDays: number; renewed: boolean }, now = Date.now()): RenewalState {
  if (c.renewed) return "renewed";
  if (!c.termEndsAt) return "none";
  const end = c.termEndsAt.getTime();
  if (end <= now) return "ended";
  if (end - c.renewalNoticeDays * DAY <= now) return "due";
  return "ok";
}

export const RENEWAL_LABELS: Record<RenewalState, string> = { none: "بدون زمان‌بندی", ok: "فعال", due: "نزدیک پایان", ended: "پایان یافته", renewed: "تمدید شده" };

/** تنظیم/حذف زمان پایان مدت یک قرارداد امضاشده. termEndsAt=null → حذف زمان‌بندی. */
export async function setContractTerm(p: { contractId: number; workspaceId: number; actorId: number; termEndsAt: Date | null; noticeDays: number }): Promise<{ ok: boolean; error?: string }> {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, p.contractId), eq(contracts.workspaceId, p.workspaceId)));
  if (!c) return { ok: false, error: "قرارداد یافت نشد" };
  if (c.status !== "signed") return { ok: false, error: "زمان‌بندی تمدید فقط برای قرارداد امضاشده ممکن است" };
  const notice = Math.max(1, Math.min(365, Math.round(p.noticeDays) || 30));
  if (p.termEndsAt) {
    if (Number.isNaN(p.termEndsAt.getTime())) return { ok: false, error: "تاریخ نامعتبر است" };
    if (c.signedAt && p.termEndsAt.getTime() <= c.signedAt.getTime()) return { ok: false, error: "پایان مدت باید بعد از تاریخ امضا باشد" };
    if (p.termEndsAt.getTime() > Date.now() + 36500 * DAY) return { ok: false, error: "تاریخ بیش از حد دور است" };
  }
  const days = p.termEndsAt && c.signedAt ? Math.max(1, Math.round((p.termEndsAt.getTime() - c.signedAt.getTime()) / DAY)) : null;
  await db
    .update(contracts)
    .set({ termEndsAt: p.termEndsAt, termDays: days, renewalNoticeDays: notice, renewalNotifiedAt: null, termEndedNotifiedAt: null })
    .where(eq(contracts.id, c.id));
  await logAudit({ action: "renewal.scheduled", contractId: c.id, userId: p.actorId, detail: p.termEndsAt ? `پایان مدت: ${fa(p.termEndsAt)} — یادآوری ${notice} روز قبل` : "زمان‌بندی تمدید حذف شد" });
  return { ok: true };
}

async function hasRenewal(id: number): Promise<number | null> {
  const [r] = await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.renewedFromId, id)).limit(1);
  return r?.id ?? null;
}

/** صدور مجدد (تمدید): پیش‌نویس جدید با همان مشتری/امضاکنندگان/متن و همان مدت. اگر قبلاً تمدید شده، همان را برمی‌گرداند. */
export async function renewContract(id: number, actorId: number, workspaceId: number): Promise<{ id: number; existing: boolean }> {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId)));
  if (!c) throw new Error("قرارداد یافت نشد");
  if (c.status !== "signed") throw new Error("فقط قرارداد امضاشده قابل تمدید است");
  const prev = await hasRenewal(id);
  if (prev) return { id: prev, existing: true };
  const newId = await duplicateContract(id, actorId, workspaceId);
  await db.update(contracts).set({ renewedFromId: id, termDays: c.termDays, renewalNoticeDays: c.renewalNoticeDays }).where(eq(contracts.id, newId));
  await logAudit({ action: "renewal.created", contractId: newId, userId: actorId, workspaceId, detail: `تمدید قرارداد ${c.number}` });
  return { id: newId, existing: false };
}

export async function listRenewals(workspaceId: number) {
  const rows = await db
    .select({
      id: contracts.id,
      number: contracts.number,
      title: contracts.title,
      termEndsAt: contracts.termEndsAt,
      renewalNoticeDays: contracts.renewalNoticeDays,
      signedAt: contracts.signedAt,
      customerName: users.name,
      renewedTo: sql<number | null>`(select r.id from contracts r where r.renewed_from_id = ${contracts.id} limit 1)`,
    })
    .from(contracts)
    .innerJoin(users, eq(users.id, contracts.customerId))
    .where(and(eq(contracts.workspaceId, workspaceId), eq(contracts.status, "signed"), isNotNull(contracts.termEndsAt)))
    .orderBy(asc(contracts.termEndsAt))
    .limit(500);
  return rows.map((r) => ({ ...r, state: renewalState({ termEndsAt: r.termEndsAt, renewalNoticeDays: r.renewalNoticeDays, renewed: !!r.renewedTo }) }));
}

/**
 * زمان‌بند: ۱) «به‌زودی تمام می‌شود» N روز پیش از پایان؛ ۲) «پایان یافت». هر مرحله دقیقاً یک‌بار (claim اتمیک).
 * قراردادی که قبلاً تمدید شده باشد یادآوری نمی‌گیرد. خروجی: تعداد یادآوری‌های ارسال‌شده.
 */
export async function runRenewalChecks(workspaceId?: number): Promise<number> {
  const now = new Date();
  let sent = 0;
  const scope = workspaceId ? eq(contracts.workspaceId, workspaceId) : undefined;

  const due = await db
    .select()
    .from(contracts)
    .where(and(scope, eq(contracts.status, "signed"), isNotNull(contracts.termEndsAt), isNull(contracts.renewalNotifiedAt), sql`${contracts.termEndsAt} - (${contracts.renewalNoticeDays} * interval '1 day') <= ${now}`))
    .limit(200);
  for (const c of due) {
    const claimed = await db.update(contracts).set({ renewalNotifiedAt: now }).where(and(eq(contracts.id, c.id), isNull(contracts.renewalNotifiedAt))).returning({ id: contracts.id });
    if (claimed.length === 0 || (await hasRenewal(c.id))) continue;
    const ended = c.termEndsAt!.getTime() <= now.getTime();
    await announce(c, ended ? "ended" : "due");
    if (ended) await db.update(contracts).set({ termEndedNotifiedAt: now }).where(eq(contracts.id, c.id));
    sent++;
  }

  const ended = await db
    .select()
    .from(contracts)
    .where(and(scope, eq(contracts.status, "signed"), isNotNull(contracts.termEndsAt), isNull(contracts.termEndedNotifiedAt), lte(contracts.termEndsAt, now)))
    .limit(200);
  for (const c of ended) {
    const claimed = await db.update(contracts).set({ termEndedNotifiedAt: now }).where(and(eq(contracts.id, c.id), isNull(contracts.termEndedNotifiedAt))).returning({ id: contracts.id });
    if (claimed.length === 0 || (await hasRenewal(c.id))) continue;
    await announce(c, "ended");
    sent++;
  }
  return sent;
}

async function announce(c: typeof contracts.$inferSelect, kind: "due" | "ended") {
  const when = fa(c.termEndsAt);
  const title = kind === "due" ? `مدت قرارداد ${c.number} رو به پایان است` : `مدت قرارداد ${c.number} به پایان رسید`;
  const body = kind === "due" ? `«${c.title}» تا ${when} معتبر است. برای تمدید، پیش‌نویس صدور مجدد بسازید.` : `«${c.title}» در ${when} پایان یافت. برای ادامه‌ی همکاری قرارداد را تمدید کنید.`;
  await notifyTeam(c.workspaceId, { kind: "warning", title, body, href: `/contracts/${c.id}#renewal`, dedupeKey: `renewal:${kind}:${c.id}` }, [c.createdBy]);
  await logAudit({ action: kind === "due" ? "renewal.due" : "renewal.ended", contractId: c.id, actor: "system", detail: `${c.number} — ${when}` });
  const cfg = await getAllSettings(c.workspaceId);
  if (cfg.admin_email && !(await isIsolatedWorkspace(c.workspaceId))) {
    await sendMail({
      to: cfg.admin_email,
      subject: title,
      html: `<div dir="rtl" style="font-family:Tahoma,sans-serif;line-height:2"><p>${escapeHtml(body)}</p>${cfg.app_url ? `<p><a href="${cfg.app_url.replace(/\/+$/, "")}/contracts/${c.id}">مشاهده‌ی قرارداد و تمدید</a></p>` : ""}</div>`,
      contractId: c.id,
    }).catch((e) => console.error("[renewal:mail]", e));
  }
}
