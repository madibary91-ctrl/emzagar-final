import crypto from "node:crypto";
import { escapeHtml } from "@/lib/html";
import { and, desc, eq, inArray, isNotNull, lt, lte } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { contracts, contractSigners, cronRuns, users, workspaces } from "@/db/schema";
import { getAllSettings, getAllSettingsMany, getGlobalSetting, saveGlobalSetting, type SettingKey } from "@/modules/settings/service";
import { sendMail } from "@/modules/mail";
import { logAudit } from "@/modules/audit/service";
import { notifySigner, revokeSigningLinks } from "@/modules/signing/links";
import { emitEvent } from "@/modules/webhooks/service";
import { fa } from "@/lib/jalali";
import { runRenewalChecks } from "@/modules/renewals/service";
import { runSubscriptionReminders } from "@/modules/billing/reminders";
import { issueMissingInvoices } from "@/modules/billing/invoices";
import { notifyTeam, purgeOldNotifications } from "@/modules/inbox/service";
import { userSessions } from "@/db/schema";
import { isIsolatedWorkspace } from "@/modules/tenancy/isolation";
import { currentStageSigners } from "@/modules/signing/stages";
import { lockContract } from "@/modules/contracts/lifecycle";

export type AutomationResult = { reminders: number; expired: number; renewals?: number; installments?: number };

const HOUR = 3600 * 1000;

/** ارسال یادآوری به امضاکننده‌ی فعلی از طریق ایمیل، پیامک (اختیاری) و پیام‌رسان */
async function sendReminder(contractId: number, opts: { sms: boolean; actor?: string; adminId?: number }): Promise<boolean> {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  if (!c || c.status !== "sent") return false;
  const signers = await db
    .select({ id: contractSigners.id, label: contractSigners.label, status: contractSigners.status, position: contractSigners.position, stage: contractSigners.stage, userId: contractSigners.userId })
    .from(contractSigners)
    .where(eq(contractSigners.contractId, contractId));
  // امضای هم‌زمان: یادآوری برای همه‌ی کسانی که همین حالا نوبت دارند
  const turns = currentStageSigners(signers);
  if (turns.length === 0) return false;
  let sent = false;
  for (const turn of turns) {
    const [u] = await db.select().from(users).where(eq(users.id, turn.userId));
    if (!u) continue;
    // لینک امضای اختصاصی همان نوبت (ایمیل + پیامک اختیاری)
    const url = await notifySigner(contractId, turn.id, "reminder", { smsOverride: opts.sms });
    if (!url) continue;
    sent = true;
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
  }
  return sent;
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

/** سقف تعداد قرارداد در هر نوبتِ انقضا؛ باقی‌مانده در اجرای بعدیِ زمان‌بند پردازش می‌شود */
const EXPIRE_BATCH = 500;

/**
 * منقضی کردن قراردادهایی که مهلت امضایشان گذشته است.
 *
 * A-7: پیش‌تر یک UPDATE گروهی همه را «منقضی» می‌کرد و سپس حلقه‌ی اثرهای جانبی (ابطال لینک، لاگ، اعلان، ایمیل) اجرا می‌شد؛
 * خطای یک ردیف (مثلاً SMTP یا لاگ) کل حلقه را قطع می‌کرد و بقیه‌ی قراردادها «منقضی ولی با لینکِ زنده، بدون لاگ و بدون اعلان» می‌ماندند.
 * اکنون هر قرارداد «مستقل» پردازش می‌شود:
 *  ۱) تراکنشِ خودش: قفل ردیف + سنجش دوباره‌ی (sent و مهلتِ گذشته) + تغییر وضعیت + ابطال لینک‌ها + لاگ ممیزی (اتمی)؛
 *     سنجش زیر قفل یعنی امضای هم‌زمان یا تمدید مهلتِ هم‌زمان هرگز با انقضا برنمی‌خورد (A-1)؛
 *  ۲) اثرهای شبکه‌ای (اعلان/وب‌هوک/ایمیل) پس از commit و هرکدام جدا (best-effort)؛
 *  ۳) هر خطا فقط خودِ همان ردیف را رد می‌کند و در لاگ سرور می‌آید؛ شمارش‌شده‌ها فقط ردیف‌هایی‌اند که واقعاً commit شده‌اند.
 */
async function expireOverdue(workspaceId?: number): Promise<number> {
  const now = new Date();
  const candidates = await db
    .select({ id: contracts.id })
    .from(contracts)
    .where(and(eq(contracts.status, "sent"), isNotNull(contracts.expiresAt), lt(contracts.expiresAt, now), workspaceId ? eq(contracts.workspaceId, workspaceId) : undefined))
    .orderBy(contracts.expiresAt)
    .limit(EXPIRE_BATCH);
  if (candidates.length === 0) return 0;
  // تنظیمات همه‌ی فضاهای درگیر با یک کوئری (نه یکی به‌ازای هر قرارداد منقضی‌شده)
  const wsRows = await db.selectDistinct({ id: contracts.workspaceId }).from(contracts).where(inArray(contracts.id, candidates.map((c) => c.id)));
  const cfgCache = await getAllSettingsMany(wsRows.map((r) => r.id)).catch(() => new Map<number, Record<SettingKey, string>>());

  let expired = 0;
  for (const cand of candidates) {
    try {
      const done = await withTransaction(async () => {
        const c = await lockContract(cand.id);
        if (!c || c.status !== "sent" || !c.expiresAt || c.expiresAt.getTime() >= now.getTime()) return null;
        const upd = await db
          .update(contracts)
          .set({ status: "expired" })
          .where(and(eq(contracts.id, c.id), eq(contracts.status, "sent")))
          .returning({ id: contracts.id });
        if (upd.length === 0) return null;
        await revokeSigningLinks({ contractId: c.id });
        await logAudit({ action: "contract.expired", contractId: c.id, actor: "system", detail: c.number });
        return { id: c.id, number: c.number, title: c.title, workspaceId: c.workspaceId };
      });
      if (!done) continue;
      expired++;
      await afterExpire(done, cfgCache.get(done.workspaceId));
    } catch (e) {
      console.error("[automation:expire]", cand.id, e instanceof Error ? e.message : e);
    }
  }
  return expired;
}

/** اثرهای جانبیِ پس از commit انقضا؛ هر کدام مستقل است و شکستش نه انقضا را برمی‌گرداند و نه بقیه را متوقف می‌کند */
async function afterExpire(r: { id: number; number: string; title: string; workspaceId: number }, preloaded?: Record<SettingKey, string>) {
  const step = async (label: string, fn: () => Promise<unknown> | unknown) => {
    try {
      await fn();
    } catch (e) {
      console.error(`[automation:expire:${label}]`, r.id, e instanceof Error ? e.message : e);
    }
  };
  await step("notify", () => notifyTeam(r.workspaceId, { kind: "warning", title: `قرارداد ${r.number} منقضی شد`, body: `مهلت امضای «${r.title}» بدون تکمیل به پایان رسید؛ می‌توانید آن را دوباره صادر کنید.`, href: `/contracts/${r.id}` }));
  await step("event", () => emitEvent({ event: "contract.expired", contractId: r.id, text: `⌛ مهلت امضای قرارداد ${r.number} — «${r.title}» به پایان رسید و منقضی شد.`, data: { number: r.number } }));
  await step("mail", async () => {
    const cfg = preloaded ?? (await getAllSettings(r.workspaceId));
    if (cfg.admin_email && !(await isIsolatedWorkspace(r.workspaceId))) {
      await sendMail({ to: cfg.admin_email, subject: `قرارداد ${r.number} منقضی شد`, html: `<div dir="rtl"><p>مهلت امضای قرارداد «${escapeHtml(r.title)}» بدون تکمیل امضاها به پایان رسید.</p></div>`, contractId: r.id });
    }
  });
}

/** حداقل ممکنِ «ساعت‌های اولیه» (تنظیم هر فضا حداقل ۱ ساعت است) و سقف تعداد یادآوری */
const MIN_FIRST_MS = HOUR;
const MAX_REMINDERS = 20;
const REMINDER_PARALLEL = 4;

/**
 * یادآوری‌ها به‌ازای هر فضای کاری و با تنظیمات خودش اجرا می‌شود.
 *
 * P-09: قبلاً «همه‌ی فضاهای کاری» پشت‌سرهم پیمایش می‌شد و هرکدام ≥ ۲ کوئری (تنظیمات + قراردادها) می‌زد، حتی اگر هیچ قرارداد منتظری نداشت.
 * اکنون «یک» کوئری (روی ایندکس جزئی sent) فقط فضاهایی را برمی‌گرداند که دست‌کم یک قرارداد در انتظارِ امضای قدیمی‌تر از یک ساعت و با
 * سهمیه‌ی یادآوری باقی‌مانده دارند (فضای بدون چنین قراردادی در حلقه‌ی قدیمی هم بلافاصله ۰ برمی‌گرداند؛ پس خروجی یکسان است)،
 * تنظیمات همه‌ی آن‌ها با یک کوئری گرفته می‌شود و پردازش آن‌ها با هم‌زمانی محدود (۴) انجام می‌شود تا یک فضای کُند بقیه را عقب نیندازد.
 */
export async function sendDueReminders(onlyWorkspace?: number): Promise<number> {
  if (onlyWorkspace) return sendDueRemindersFor(onlyWorkspace);
  const rows = await db
    .selectDistinct({ id: contracts.workspaceId })
    .from(contracts)
    .where(and(eq(contracts.status, "sent"), lte(contracts.issuedAt, new Date(Date.now() - MIN_FIRST_MS)), lt(contracts.reminderCount, MAX_REMINDERS)));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return 0;
  const cfgs = await getAllSettingsMany(ids);
  let total = 0;
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < ids.length; i = next++) {
      try {
        total += await sendDueRemindersFor(ids[i], cfgs.get(ids[i]));
      } catch (e) {
        console.error("[automation:reminders]", ids[i], e instanceof Error ? e.message : e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REMINDER_PARALLEL, ids.length) }, worker));
  return total;
}

async function sendDueRemindersFor(workspaceId: number, preloaded?: Record<SettingKey, string>): Promise<number> {
  const cfg = preloaded ?? (await getAllSettings(workspaceId));
  if (cfg.reminder_enabled !== "1") return 0;
  const first = Math.max(1, Number(cfg.reminder_first_hours) || 24) * HOUR;
  const interval = Math.max(1, Number(cfg.reminder_interval_hours) || 48) * HOUR;
  const max = Math.max(0, Math.min(MAX_REMINDERS, Number(cfg.reminder_max) || 0));
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
      // یادآوری خودکار اقساط و بیعانه‌های سررسیدشده (با لینک پرداخت آنلاین)
      result.installments = await (await import("@/modules/contract-pay/service")).runInstallmentReminders(workspaceId).catch(() => 0);
      if (!workspaceId) {
        // مالی: یادآوری انقضای اشتراک (۷/۳/۱ روز و پس از انقضا) + صدور فاکتورِ جامانده‌ی پرداخت‌های موفق
        await runSubscriptionReminders().catch((e) => console.error("[automation:sub-reminders]", e instanceof Error ? e.message : e));
        await issueMissingInvoices().catch((e) => console.error("[automation:invoices]", e instanceof Error ? e.message : e));
        // وب‌هوک‌های خروجیِ در صف تلاش مجدد که زمانشان رسیده (علاوه بر صف کارها؛ برای هاست‌های بدون پردازه‌ی دائمی)
        await (await import("@/modules/webhooks/retry")).processDueWebhookRetries().catch(() => 0);
        await purgeOldNotifications().catch(() => 0);
        // فاز ۲: فایل‌های بارگذاری‌شده‌ی مصرف‌نشده (۲۴ ساعت) و کدهای تأیید موبایل قدیمی
        await (await import("@/modules/docs/service")).purgeStaleDrafts().catch(() => 0);
        await (await import("@/modules/mobile/otp")).purgeOldVerifications().catch(() => undefined);
        await db.delete(userSessions).where(lt(userSessions.expiresAt, new Date(Date.now() - 30 * 86400000))).catch(() => undefined);
      }
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 300) : "خطای ناشناخته";
    }
    // فقط اجرای مفید یا خطادار ثبت می‌شود تا جدول از اجرای خالی پر نشود
    if (trigger === "manual" || result.reminders > 0 || result.expired > 0 || (result.renewals ?? 0) > 0 || (result.installments ?? 0) > 0 || error) {
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
