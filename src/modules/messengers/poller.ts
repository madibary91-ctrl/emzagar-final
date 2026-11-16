import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { messengerBots } from "@/db/schema";
import { isInstalled } from "@/modules/install/service";
import { withJitter } from "@/lib/resilience";
import { handleUpdate } from "./bot";
import { getUpdates, deleteWebhook, BotApiError } from "./client";
import { botRef, markBotTokenInvalid, purgeMessengerData } from "./service";

/**
 * حالت «پرسش دوره‌ای» (Polling): برای هاست‌های اشتراکی/سرورهای بدون HTTPS عمومی که تلگرام یا بله نمی‌تواند به آن‌ها وب‌هوک بزند.
 * هر ربات با «اجاره» (lease) در دیتابیس قفل می‌شود تا در استقرار چندپردازه‌ای فقط یک پردازه از آن بپرسد.
 *
 * رفتار در خرابی (M-02):
 *  - ربات‌ها هم‌زمان پرسیده می‌شوند (یک ربات کند یا قطع، بقیه را معطل نمی‌کند).
 *  - backoff نمایی با jitter (۴ث ← ۵دقیقه) به‌جای کوبیدن هر ۴ ثانیه هنگام قطعی شبکه/توکن باطل؛ با اجاره‌ی دیتابیس هماهنگ است.
 *  - قطعی گذرای شبکه، وضعیت ربات را «خطا» نمی‌کند (ربات از کارت‌های اتصال کاربران ناپدید می‌شد)؛ فقط پس از چند شکست پیاپی.
 *  - ۴۰۱ ⇒ توکن باطل (فوراً خطا + اعلان)؛ ۴۰۹ ⇒ رفع خودکار وب‌هوکِ باقی‌مانده.
 *  - آپدیتی که پردازشش با خطای موقت شکست خورد، نوبت بعد دوباره از همان‌جا خوانده می‌شود (M-01)، نه از دست می‌رود و نه بقیه را قفل می‌کند.
 */
type G = typeof globalThis & { __emzMsgPoll?: ReturnType<typeof setInterval>; __emzMsgBusy?: boolean; __emzMsgPurgeAt?: number; __emzMsgFails?: Map<number, number> };
const g = globalThis as G;
const failures = (): Map<number, number> => (g.__emzMsgFails ??= new Map());

const LEASE_MS = 60_000;
const BACKOFF_BASE_MS = 4_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** تعداد شکست پیاپیِ گذرا تا ربات «خطا» علامت بخورد */
export const POLL_ERROR_AFTER = 5;

export const pollBackoffMs = (failCount: number): number => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failCount - 1), BACKOFF_MAX_MS);

type Bot = typeof messengerBots.$inferSelect;

async function pollBot(bot: Bot): Promise<number> {
  const got = await db
    .update(messengerBots)
    .set({ pollLeaseUntil: new Date(Date.now() + LEASE_MS) })
    .where(and(eq(messengerBots.id, bot.id), or(isNull(messengerBots.pollLeaseUntil), lt(messengerBots.pollLeaseUntil, new Date()))))
    .returning({ id: messengerBots.id });
  if (!got.length) return 0;
  let handled = 0;
  let backoff = 0;
  try {
    const ref = botRef(bot);
    const updates = await getUpdates(ref, bot.lastUpdateId + 1);
    let last = bot.lastUpdateId;
    for (const u of updates) {
      const out = await handleUpdate(bot.id, u);
      if (out === "retry") break; // نوبت بعد از همین آپدیت ادامه می‌دهیم؛ آپدیت‌های بعدی هم‌چنان به ترتیب می‌رسند
      if (out === "handled") handled++;
      if (u.update_id > last) last = u.update_id;
    }
    failures().delete(bot.id);
    if (last !== bot.lastUpdateId || bot.status === "error") {
      await db
        .update(messengerBots)
        .set({ lastUpdateId: last, ...(bot.status === "error" ? { status: "connected", lastError: "" } : {}) })
        .where(eq(messengerBots.id, bot.id));
    }
  } catch (e) {
    const err = e instanceof BotApiError ? e : null;
    const msg = (err ? err.message : e instanceof Error ? e.message : "خطا").slice(0, 300);
    const n = (failures().get(bot.id) ?? 0) + 1;
    failures().set(bot.id, n);
    backoff = withJitter(pollBackoffMs(n));
    if (err?.unauthorized || err?.code === 404) {
      backoff = withJitter(BACKOFF_MAX_MS);
      if (err.unauthorized) await markBotTokenInvalid(bot.id, msg).catch(() => undefined);
      else await db.update(messengerBots).set({ status: "error", lastError: msg }).where(eq(messengerBots.id, bot.id));
    } else {
      if (err?.code === 409) await deleteWebhook(botRef(bot)).catch(() => undefined); // وب‌هوکِ باقی‌مانده جلوی getUpdates را می‌گیرد
      const permanent = !!err && !err.transient && err.code !== 409;
      if (permanent || n >= (err?.code === 409 ? 3 : POLL_ERROR_AFTER)) {
        await db.update(messengerBots).set({ status: "error", lastError: msg }).where(eq(messengerBots.id, bot.id));
      }
    }
  } finally {
    await db.update(messengerBots).set({ pollLeaseUntil: backoff ? new Date(Date.now() + backoff) : null }).where(eq(messengerBots.id, bot.id));
  }
  return handled;
}

export async function pollOnce(): Promise<number> {
  if (g.__emzMsgBusy || !(await isInstalled())) return 0;
  g.__emzMsgBusy = true;
  let handled = 0;
  try {
    const now = new Date();
    const bots = await db
      .select()
      .from(messengerBots)
      .where(and(eq(messengerBots.active, true), eq(messengerBots.mode, "polling"), or(isNull(messengerBots.pollLeaseUntil), lt(messengerBots.pollLeaseUntil, now))));
    const results = await Promise.allSettled(bots.map((b) => pollBot(b)));
    for (const r of results) {
      if (r.status === "fulfilled") handled += r.value;
      else console.error("[messenger:poll]", r.reason instanceof Error ? r.reason.message : r.reason);
    }
    if (!g.__emzMsgPurgeAt || Date.now() - g.__emzMsgPurgeAt > 3600_000) {
      g.__emzMsgPurgeAt = Date.now();
      await purgeMessengerData().catch(() => undefined);
    }
  } catch (e) {
    console.error("[messenger:poll]", e instanceof Error ? e.message : e);
  } finally {
    g.__emzMsgBusy = false;
  }
  return handled;
}

export function startMessengerPoller(): void {
  if (g.__emzMsgPoll || process.env.NODE_ENV === "test") return;
  g.__emzMsgPoll = setInterval(() => void pollOnce(), 4000);
  g.__emzMsgPoll.unref?.();
}
