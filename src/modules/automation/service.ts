import crypto from "node:crypto";
import { escapeHtml } from "@/lib/html";
import { and, desc, eq, inArray, isNotNull, lt, lte } from "drizzle-orm";
import { db } from "@/db";
import { contracts, contractSigners, cronRuns, users, workspaces } from "@/db/schema";
import { getAllSettings, getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";
import { sendMail } from "@/modules/mail";
import { logAudit } from "@/modules/audit/service";
import { notifySigner, revokeSigningLinks } from "@/modules/signing/links";
import { emitEvent } from "@/modules/webhooks/service";
import { fa } from "@/lib/jalali";
import { runRenewalChecks } from "@/modules/renewals/service";
import { notifyTeam, purgeOldNotifications } from "@/modules/inbox/service";
import { userSessions } from "@/db/schema";

export type AutomationResult = { reminders: number; expired: number; renewals?: number };

const HOUR = 3600 * 1000;

/** ارسال یادآوری به امضاکننده‌ی فعلی از طریق ایمیل، پیامک (اختیاری) و پیام‌رسان */
async function sendReminder(contractId: number, opts: { sms: boolean; actor?: string; adminId?: number }): Promise<boolean> {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  if (!c || c.status !== "sent") return false;
  const signers = await db
    .select({ id: contractSigners.id, label: contractSigners.label, status: contractSigners.status, position: contractSigners.position, userId: contractSigners.userId })
    .from(contractSigners)
    .where(eq(contractSigners.contractId, contractId));
  const turn = signers.filter((s) => s.status === "pending").sort((a, b) => a.position - b.position)[0];
  if (!turn) return false;
  const [u] = await db.select().from(users).where(eq(users.id, turn.userId));
  if (!u) return false;

  // لینک امضای اختصاصی همان نوبت (ایمیل + پیامک اختیاری)
  const url = await notifySigner(contractId, turn.id, "reminder", { smsOverride: opts.sms });
  if (!url) return false;
  await logAudit({
    action: "contract.reminder",
    contractId,
    userId: opts.adminId ?? null,
    actor: opts.actor,
    detail: `برای ${turn.label} (${u.name})`,
  });
  emitEvent({
    event: "contract.reminder",
    contractId,
    text: `⏰ یادآوری: قرارداد ${c.number} هنوز منتظر امضای «${turn.label} — ${u.name}» است.`,
    data: { number: c.number, signer: turn.label },
  });
  return true;
}

/** یادآوری دستی توسط مدیر (بدون محدودیت‌های زمانی زمان‌بند) */
export async function remindContractNow(contractId: number, adminId: number, workspaceId: number) {
  const cfg = await getAllSettings(workspaceId);
  // ایزولاسیون: فقط قراردادهای همین فضای کاری
  const [own] = await db.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.workspaceId, workspaceId)));
  if (!own) return false;
  const ok = await sendReminder(contractId, { sms: cfg.reminder_sms === "1", adminId });
  if (ok) {
    await db
      .update(contracts)
      .set({ lastReminderAt: new Date() })
      .where(eq(contracts.id, contractId));
  }
  return ok;
}

/** منقضی کردن قراردادهایی که مهلت امضایشان گذشته است */
async function expireOverdue(workspaceId?: number): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(contracts)
    .set({ status: "expired" })
    .where(and(eq(contracts.status, "sent"), isNotNull(contracts.expiresAt), lt(contracts.expiresAt, now), workspaceId ? eq(contracts.workspaceId, workspaceId) : undefined))
    .returning({ id: contracts.id, number: contracts.number, title: contracts.title, workspaceId: contracts.workspaceId });
  const cfgCache = new Map<number, Awaited<ReturnType<typeof getAllSettings>>>();
  for (const r of rows) {
    if (!cfgCache.has(r.workspaceId)) cfgCache.set(r.workspaceId, await getAllSettings(r.workspaceId));
    const cfg = cfgCache.get(r.workspaceId)!;
    await revokeSigningLinks({ contractId: r.id });
    await notifyTeam(r.workspaceId, { kind: "warning", title: `قرارداد ${r.number} منقضی شد`, body: `مهلت امضای «${r.title}» بدون تکمیل به پایان رسید؛ می‌توانید آن را دوباره صادر کنید.`, href: `/contracts/${r.id}` });
    await logAudit({ action: "contract.expired", contractId: r.id, actor: "system", detail: r.number });
    emitEvent({ event: "contract.expired", contractId: r.id, text: `⌛ مهلت امضای قرارداد ${r.number} — «${r.title}» به پایان رسید و منقضی شد.`, data: { number: r.number } });
    if (cfg.admin_email) {
      await sendMail({ to: cfg.admin_email, subject: `قرارداد ${r.number} منقضی شد`, html: `<div dir="rtl"><p>مهلت امضای قرارداد «${escapeHtml(r.title)}» بدون تکمیل امضاها به پایان رسید.</p></div>`, contractId: r.id });
    }
  }
  return rows.length;
}

/** یادآوری‌ها به‌ازای هر فضای کاری و با تنظیمات خودش اجرا می‌شود */
async function sendDueReminders(onlyWorkspace?: number): Promise<number> {
  const all = onlyWorkspace ? [{ id: onlyWorkspace }] : await db.select({ id: workspaces.id }).from(workspaces);
  let total = 0;
  for (const w of all) total += await sendDueRemindersFor(w.id);
  return total;
}

async function sendDueRemindersFor(workspaceId: number): Promise<number> {
  const cfg = await getAllSettings(workspaceId);
  if (cfg.reminder_enabled !== "1") return 0;
  const first = Math.max(1, Number(cfg.reminder_first_hours) || 24) * HOUR;
  const interval = Math.max(1, Number(cfg.reminder_interval_hours) || 48) * HOUR;
  const max = Math.max(0, Math.min(20, Number(cfg.reminder_max) || 0));
  if (max === 0) return 0;
  const now = Date.now();

  const candidates = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.workspaceId, workspaceId), eq(contracts.status, "sent"), lte(contracts.issuedAt, new Date(now - first))))
    .orderBy(desc(contracts.issuedAt))
    .limit(300);
  const eligible = candidates.filter((c) => c.reminderCount < max);
  if (eligible.length === 0) return 0;

  // زمان شروع نوبت فعلی = آخرین امضای ثبت‌شده یا زمان انتشار
  const signed = await db
    .select({ contractId: contractSigners.contractId, signedAt: contractSigners.signedAt })
    .from(contractSigners)
    .where(and(inArray(contractSigners.contractId, eligible.map((c) => c.id)), eq(contractSigners.status, "signed")));
  const lastSigned = new Map<number, number>();
  for (const s of signed) if (s.signedAt) lastSigned.set(s.contractId, Math.max(lastSigned.get(s.contractId) ?? 0, s.signedAt.getTime()));

  let sent = 0;
  for (const c of eligible) {
    const turnStart = Math.max(c.issuedAt.getTime(), lastSigned.get(c.id) ?? 0);
    if (now - turnStart < first) continue;
    if (c.lastReminderAt && now - c.lastReminderAt.getTime() < interval) continue;
    // ثبت اتمیک: اگر پردازه‌ی دیگری همزمان ارسال کرده باشد، این ردیف تغییری نمی‌کند
    const claimed = await db
      .update(contracts)
      .set({ lastReminderAt: new Date(), reminderCount: c.reminderCount + 1 })
      .where(and(eq(contracts.id, c.id), eq(contracts.status, "sent"), eq(contracts.reminderCount, c.reminderCount)))
      .returning({ id: contracts.id });
    if (claimed.length === 0) continue;
    try {
      if (await sendReminder(c.id, { sms: cfg.reminder_sms === "1", actor: "system" })) sent++;
    } catch {
      /* خطا در یک قرارداد نباید بقیه را متوقف کند */
    }
  }
  return sent;
}

let running = false;

export async function runAutomation(trigger: "scheduler" | "http" | "manual", workspaceId?: number): Promise<AutomationResult & { skipped?: boolean }> {
  if (running) return { reminders: 0, expired: 0, skipped: true };
  running = true;
  try {
    let error: string | null = null;
    let result: AutomationResult = { reminders: 0, expired: 0 };
    try {
      // ابتدا انقضا، سپس یادآوری (قرارداد منقضی‌شده یادآوری نمی‌گیرد)
      result.expired = await expireOverdue(workspaceId);
      result.reminders = await sendDueReminders(workspaceId);
      // تمدید: «به‌زودی تمام می‌شود» و «پایان یافت»
      result.renewals = await runRenewalChecks(workspaceId);
      if (!workspaceId) {
        await purgeOldNotifications().catch(() => 0);
        await db.delete(userSessions).where(lt(userSessions.expiresAt, new Date(Date.now() - 30 * 86400000))).catch(() => undefined);
      }
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 300) : "خطای ناشناخته";
    }
    // فقط اجرای مفید یا خطادار ثبت می‌شود تا جدول از اجرای خالی پر نشود
    if (trigger === "manual" || result.reminders > 0 || result.expired > 0 || (result.renewals ?? 0) > 0 || error) {
      await db.insert(cronRuns).values({ trigger, reminders: result.reminders, expired: result.expired, error });
    }
    return result;
  } finally {
    running = false;
  }
}

export async function recentRuns(limit = 10) {
  return db.select().from(cronRuns).orderBy(desc(cronRuns.createdAt)).limit(limit);
}

/* ───────── کلید محافظ مسیر HTTP کرون ───────── */
export async function getCronSecret(): Promise<{ secret: string; fromEnv: boolean }> {
  if (process.env.CRON_SECRET) return { secret: process.env.CRON_SECRET, fromEnv: true };
  return { secret: await getGlobalSetting("cron_secret"), fromEnv: false };
}

export async function ensureCronSecret(): Promise<{ secret: string; fromEnv: boolean }> {
  const cur = await getCronSecret();
  if (cur.secret) return cur;
  const secret = crypto.randomBytes(24).toString("hex");
  await saveGlobalSetting("cron_secret", secret);
  return { secret, fromEnv: false };
}

export async function verifyCronSecret(provided: string | null): Promise<boolean> {
  const { secret } = await getCronSecret();
  if (!secret || !provided) return false;
  const h = (v: string) => crypto.createHash("sha256").update(v).digest();
  return crypto.timingSafeEqual(h(secret), h(provided));
}
