import { and, asc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { chatConversations, chatMessages, contracts, messengerChats, workspaceMembers } from "@/db/schema";
import { faNum } from "@/lib/jalali";
import { notifyUsers, teamUserIds } from "@/modules/inbox/service";
import { enqueueJob, registerJobHandler } from "@/modules/jobs/queue";
import { appBase, chatTargetsForUser, getChat, type ChatTarget } from "@/modules/messengers/service";
import { deliver, type DeliverResult } from "@/modules/messengers/send";
import { clip, type Btn } from "@/modules/messengers/util";
import { emitEvent } from "@/modules/webhooks/service";
import { ALERT_REMIND_MS, ALERT_THROTTLE_MS, type AlertJob } from "./alerts";
import { CONTEXT_LABELS, QUEUE_LABELS, type ChatContextKind, type ChatQueue } from "./meta";
import { platformAdminIds, type Conv } from "./service";

/**
 * موتور اعلان گفتگوی زنده به پیام‌رسان‌ها — بخش «اجرا» (job handlerها).
 *  - chat.alert        : تصمیم‌گیری (آیا هنوز بی‌پاسخ است؟ محدودیت نرخ؟ چه کسانی؟) + صف‌کردن پیام برای هر چت + کانال‌های یک‌طرفه (ایتا و …)
 *  - messenger.chatalert: ساخت متن و ارسال به یک چت بله/تلگرام (با دکمه‌های «ورود»، «پاسخ از همین‌جا»، «برعهده‌گرفتن»)
 */

const STAFF_ROLES = ["owner", "admin", "member"];
const MAX_SHOWN = 3;

type Row = { id: number; body: string; createdAt: Date };

const getConvById = async (id: number): Promise<Conv | null> => (await db.select().from(chatConversations).where(eq(chatConversations.id, id)))[0] ?? null;

/** پیام‌های دیده‌نشده‌ی مشتری (به‌جز یادداشت داخلی)، قدیمی به جدید */
async function requesterRows(convId: number, afterId: number, limit = 50): Promise<Row[]> {
  return db
    .select({ id: chatMessages.id, body: chatMessages.body, createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(and(eq(chatMessages.conversationId, convId), eq(chatMessages.senderKind, "requester"), eq(chatMessages.internal, false), gt(chatMessages.id, afterId)))
    .orderBy(asc(chatMessages.id))
    .limit(limit);
}

const queueOf = (c: Conv): ChatQueue => (c.queue === "platform" ? "platform" : "workspace");
const consolePath = (c: Conv) => `${queueOf(c) === "platform" ? "/platform/chat" : "/admin/chat"}?c=${c.code}`;

/** نام نمایشی مشتری برای پیام‌رسان؛ هرگز شماره‌ی موبایل یا ایمیل نمی‌آید */
const who = (c: Conv) => clip((c.requesterName || "مشتری").replace(/\s+/g, " ").trim(), 40);

async function contextLine(c: Conv): Promise<string> {
  const parts = [CONTEXT_LABELS[(c.contextKind as ChatContextKind) in CONTEXT_LABELS ? (c.contextKind as ChatContextKind) : "panel"]];
  // شماره‌ی قرارداد فقط برای تیم صادرکننده؛ صف پلتفرم فقط فراداده می‌بیند
  if (c.contractId && queueOf(c) === "workspace") {
    const [k] = await db.select({ number: contracts.number }).from(contracts).where(and(eq(contracts.id, c.contractId), eq(contracts.workspaceId, c.workspaceId)));
    if (k) parts.push(`قرارداد ${k.number}`);
  }
  return parts.join(" · ");
}

const waitLabel = (ms: number) => (ms >= 60_000 ? `⏱ منتظر ${faNum(Math.round(ms / 60_000))} دقیقه` : "");
const quote = (s: string) => `«${clip(s.replace(/\s+/g, " ").trim(), 220)}»`;

/** متن اعلان خلاصه برای چت بله/تلگرام */
function digestText(c: Conv, o: { first: boolean; remind: boolean; ctx: string; fresh: Row[]; waitMs: number }): string {
  const head = o.remind ? "⏰ هنوز بی‌پاسخ" : o.first ? "🆕 گفتگوی جدید" : "💬 پیام تازه";
  const shown = o.fresh.slice(-MAX_SHOWN);
  const more = o.fresh.length - shown.length;
  const lines = [`${head} — ${QUEUE_LABELS[queueOf(c)]}`, `👤 ${who(c)}`, `📍 ${o.ctx}`];
  const w = waitLabel(o.waitMs);
  if (w) lines.push(w);
  lines.push("");
  if (more > 0) lines.push(`… و ${faNum(more)} پیام قبلی`);
  for (const r of shown) lines.push(quote(r.body));
  return lines.join("\n");
}

/** متن کانال‌های یک‌طرفه (ایتا، روبیکا، وب‌هوک عمومی…): کوتاه، بدون اطلاعات تماس */
function channelText(c: Conv, o: { first: boolean; remind: boolean; ctx: string; fresh: Row[]; waitMs: number; url: string }): string {
  const head = o.remind ? "⏰ گفتگوی آنلاینِ بی‌پاسخ" : o.first ? "🆕 گفتگوی آنلاین جدید" : "💬 پیام تازه در گفتگوی آنلاین";
  const last = o.fresh[o.fresh.length - 1];
  return [
    `${head} — ${QUEUE_LABELS[queueOf(c)]}`,
    `👤 ${who(c)} · ${o.ctx}`,
    waitLabel(o.waitMs),
    last ? quote(clip(last.body, 140)) : "",
    o.fresh.length > 1 ? `(${faNum(o.fresh.length)} پیام جدید)` : "",
    o.url ? `🔗 ${o.url}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** مدیران کل → فضاهای کاری‌ای که مالک آن‌ها هستند (مقصد وب‌هوک «پشتیبانی پلتفرم») */
async function platformChannelWorkspaces(adminIds: number[]): Promise<number[]> {
  if (!adminIds.length) return [];
  const rows = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(and(inArray(workspaceMembers.userId, adminIds), eq(workspaceMembers.role, "owner")));
  return [...new Set(rows.map((r) => r.workspaceId))];
}

/** گیرنده‌های چت‌های پیام‌رسان: مسئول گفتگو (اگر چت متصل دارد) وگرنه همه‌ی پشتیبان‌ها */
async function pickTargets(c: Conv, staffIds: number[], remind: boolean): Promise<ChatTarget[]> {
  // ربات پلتفرم برای صف پلتفرم؛ برای تیم: ربات خودِ تیم یا ربات پلتفرم (محتوای مشتریِ پلتفرم هرگز از ربات تیم‌ها نمی‌گذرد)
  const scope = queueOf(c) === "platform" ? null : c.workspaceId;
  const collect = async (ids: number[]) => {
    const seen = new Set<number>();
    const out: ChatTarget[] = [];
    for (const id of ids) {
      for (const t of await chatTargetsForUser(id, { workspaceId: scope })) {
        if (t.chat.muted || t.chat.blocked || !t.bot.active || seen.has(t.chat.id)) continue;
        seen.add(t.chat.id);
        out.push(t);
      }
    }
    return out;
  };
  if (c.assigneeId && !remind && staffIds.includes(c.assigneeId)) {
    const mine = await collect([c.assigneeId]);
    if (mine.length) return mine;
  }
  return collect(staffIds);
}

async function runAlert(p: AlertJob): Promise<void> {
  const conv = await getConvById(Number(p.convId));
  if (!conv || conv.status !== "open") return;
  // پاسخ داده شده یا دیده شده ⇒ دیگر اعلانی لازم نیست (حتی اگر job با تأخیر یا retry رسیده باشد)
  if (conv.unreadStaff <= 0 || conv.lastMessageBy !== "requester") return;
  const unseen = await requesterRows(conv.id, conv.staffReadId);
  if (!unseen.length) return;
  const pendingMax = unseen[unseen.length - 1].id;
  const remind = p.phase === "remind";
  const prev = conv.alertedMsgId;

  if (remind) {
    // یادآوری قدیمی که اعلان جدیدتری آن را بی‌اثر کرده
    const gap = ALERT_REMIND_MS[Math.max(0, Math.min(1, (p.n ?? 1) - 1))] * 0.8;
    if (conv.alertedAt && Date.now() - conv.alertedAt.getTime() < gap) return;
    await db.update(chatConversations).set({ alertedAt: new Date(), alertedMsgId: pendingMax }).where(eq(chatConversations.id, conv.id));
  } else {
    if (prev >= pendingMax) return; // درباره‌ی همین پیام قبلاً اعلان رفته
    const claimed = await db
      .update(chatConversations)
      .set({ alertedAt: new Date(), alertedMsgId: pendingMax })
      .where(and(eq(chatConversations.id, conv.id), lt(chatConversations.alertedMsgId, pendingMax), or(isNull(chatConversations.alertedAt), lt(chatConversations.alertedAt, new Date(Date.now() - ALERT_THROTTLE_MS)))))
      .returning({ id: chatConversations.id });
    if (!claimed.length) {
      // پشت محدودیت نرخ: یک job «دنباله» تضمین می‌کند آخرین پیام‌ها پس از پایان محدودیت اعلان شوند
      if (conv.alertedAt) {
        const wait = Math.max(3_000, conv.alertedAt.getTime() + ALERT_THROTTLE_MS - Date.now() + 1_000);
        await enqueueJob("chat.alert", { convId: conv.id, msgId: pendingMax, phase: "tail" } satisfies AlertJob, { delayMs: wait, kick: false, dedupeKey: `ca:${conv.id}:tail:${conv.alertedAt.getTime()}` });
      }
      return;
    }
  }

  const fresh = remind ? unseen : unseen.filter((r) => r.id > prev);
  const waitMs = Date.now() - unseen[0].createdAt.getTime();
  const first = prev === 0 && !remind;
  const ctx = await contextLine(conv);
  const queue = queueOf(conv);
  const adminIds = queue === "platform" ? await platformAdminIds() : [];
  const staffIds = queue === "platform" ? adminIds : await teamUserIds(conv.workspaceId, STAFF_ROLES);

  // ۱) زنگوله برای بالا رفتن اولویت (فقط وقتی پشتیبانی آنلاین بوده و ندیده، یا یادآوری)؛ بدون ارسال دوباره به پیام‌رسان
  if (p.phase === "escalate" || remind) {
    await notifyUsers(staffIds, {
      kind: "warning",
      title: remind ? `هنوز بی‌پاسخ: ${who(conv)}` : `پیام بی‌پاسخ از ${who(conv)}`,
      body: clip(fresh[fresh.length - 1]?.body ?? "", 120),
      href: consolePath(conv),
      dedupeKey: `chate:${conv.id}:${pendingMax}:${remind ? "r" : "e"}`,
      skipMessenger: true,
    });
  }

  // ۲) چت‌های بله/تلگرام (دوطرفه): هر چت یک job مستقل با retry و backoff
  const live = new Set((await liveSessionChatIds(conv.id)) as number[]);
  const targets = (await pickTargets(conv, staffIds, remind)).filter((t) => !live.has(t.chat.id));
  const since = remind ? conv.staffReadId : prev;
  for (const t of targets) {
    await enqueueJob("messenger.chatalert", { chatRowId: t.chat.id, convId: conv.id, upTo: pendingMax, since, phase: remind ? "remind" : first ? "first" : "digest" }, { kick: false, dedupeKey: `mca:${conv.id}:${pendingMax}:${t.chat.id}:${remind ? "r" : "d"}` });
  }

  // ۳) کانال‌های یک‌طرفه‌ی تیم (ایتا، روبیکا، وب‌هوک عمومی، … با انتخاب صریح در «اعلان پیام‌رسان‌ها»)
  const base = await appBase(queue === "platform" ? null : conv.workspaceId).catch(() => "");
  const url = base ? base + consolePath(conv) : "";
  const text = channelText(conv, { first, remind, ctx, fresh, waitMs, url });
  if (queue === "workspace") emitEvent({ event: "chat.message", workspaceId: conv.workspaceId, text, data: { conversation: conv.code } });
  else for (const wsId of await platformChannelWorkspaces(adminIds)) emitEvent({ event: "chat.platform", workspaceId: wsId, text, data: { conversation: conv.code } });

  // ۴) یادآوری‌های بعدی اگر همچنان بی‌پاسخ ماند
  const n = remind ? (p.n ?? 1) + 1 : 1;
  if (n <= ALERT_REMIND_MS.length) {
    await enqueueJob("chat.alert", { convId: conv.id, msgId: pendingMax, phase: "remind", n } satisfies AlertJob, { delayMs: ALERT_REMIND_MS[n - 1], kick: false, dedupeKey: `ca:${conv.id}:rem${n}:${pendingMax}` });
  }
}

async function liveSessionChatIds(convId: number): Promise<number[]> {
  const rows = await db
    .select({ id: messengerChats.id })
    .from(messengerChats)
    .where(and(eq(messengerChats.replyConvId, convId), gt(messengerChats.replyUntil, new Date())));
  return rows.map((r) => r.id);
}

registerJobHandler("chat.alert", {
  async run(p) {
    await runAlert(p as unknown as AlertJob);
  },
});

/** نتیجه‌ی ارسال: خطای موقت ⇒ استثنا (تلاش دوباره با backoff)؛ دائمی ⇒ پایان */
function settle(r: DeliverResult, last: boolean) {
  if (!r.ok && r.retry && !last) throw new Error(r.error);
}

/** اعلان یا پیام زنده‌ی گفتگو ← یک چت بله/تلگرام */
registerJobHandler("messenger.chatalert", {
  async run(p, ctx) {
    const t = await getChat(Number(p.chatRowId));
    if (!t || t.chat.blocked || t.chat.muted || !t.bot.active) return;
    const conv = await getConvById(Number(p.convId));
    if (!conv || conv.status !== "open") return;
    const phase = String(p.phase);
    const relay = phase === "relay";
    // بین صف و ارسال، همکار دیگری پاسخ داده باشد اعلان بی‌فایده است (پل زنده مستثنا)
    if (!relay && (conv.unreadStaff <= 0 || conv.lastMessageBy !== "requester")) return;
    const since = Number(p.since) || 0;
    const upTo = Number(p.upTo) || 0;
    const all = (await requesterRows(conv.id, since, 80)).filter((r) => r.id <= upTo);
    if (!all.length) return;
    const base = await appBase(t.bot.workspaceId).catch(() => "");
    const open: Btn = { text: "ورود به گفتگو", url: base ? base + consolePath(conv) : undefined };
    const buttons: Btn[][] = [];
    if (relay) {
      const row = all[all.length - 1];
      const text = `💬 ${who(conv)}:\n${clip(row.body, 1500)}`;
      buttons.push([{ text: "🔚 پایان پاسخ‌گویی", data: `d:${conv.id}` }]);
      settle(await deliver(t, { text, buttons }, { kind: "chatrelay", final: ctx.last, silentLog: true }), ctx.last);
      return;
    }
    const text = digestText(conv, { first: phase === "first", remind: phase === "remind", ctx: await contextLine(conv), fresh: all, waitMs: Date.now() - all[0].createdAt.getTime() });
    if (open.url) buttons.push([open]);
    buttons.push([
      { text: "💬 پاسخ از همین‌جا", data: `k:${conv.id}` },
      { text: "✋ برعهده‌گرفتن", data: `h:${conv.id}` },
    ]);
    settle(await deliver(t, { text, buttons }, { kind: "chatalert", final: ctx.last }), ctx.last);
  },
});
