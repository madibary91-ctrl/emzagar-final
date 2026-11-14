import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { messengerBots } from "@/db/schema";
import { isInstalled } from "@/modules/install/service";
import { handleUpdate } from "./bot";
import { getUpdates, BotApiError } from "./client";
import { botRef, purgeMessengerData } from "./service";

/**
 * حالت «پرسش دوره‌ای» (Polling): برای هاست‌های اشتراکی/سرورهای بدون HTTPS عمومی که تلگرام یا بله نمی‌تواند به آن‌ها وب‌هوک بزند.
 * هر ربات با «اجاره» (lease) در دیتابیس قفل می‌شود تا در استقرار چندپردازه‌ای فقط یک پردازه از آن بپرسد.
 */
type G = typeof globalThis & { __emzMsgPoll?: ReturnType<typeof setInterval>; __emzMsgBusy?: boolean; __emzMsgPurgeAt?: number };
const g = globalThis as G;

const LEASE_MS = 30_000;

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
    for (const bot of bots) {
      const got = await db
        .update(messengerBots)
        .set({ pollLeaseUntil: new Date(Date.now() + LEASE_MS) })
        .where(and(eq(messengerBots.id, bot.id), or(isNull(messengerBots.pollLeaseUntil), lt(messengerBots.pollLeaseUntil, new Date()))))
        .returning({ id: messengerBots.id });
      if (!got.length) continue;
      try {
        const updates = await getUpdates(botRef(bot), bot.lastUpdateId + 1);
        let last = bot.lastUpdateId;
        for (const u of updates) {
          await handleUpdate(bot.id, u);
          handled++;
          if (u.update_id > last) last = u.update_id;
        }
        await db
          .update(messengerBots)
          .set({ lastUpdateId: last, ...(bot.status === "error" ? { status: "connected", lastError: "" } : {}) })
          .where(eq(messengerBots.id, bot.id));
      } catch (e) {
        const msg = e instanceof BotApiError ? e.message : e instanceof Error ? e.message : "خطا";
        await db.update(messengerBots).set({ status: "error", lastError: msg.slice(0, 300) }).where(eq(messengerBots.id, bot.id));
      } finally {
        await db.update(messengerBots).set({ pollLeaseUntil: null }).where(eq(messengerBots.id, bot.id));
      }
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

