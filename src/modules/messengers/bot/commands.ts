import { ACT_ROLES, contractAccess, pdfAllowed, signLinkFor } from "../contracts";
import { ASK_CONTACT, MENU, STATE_LABEL } from "./texts";
import { type Btn, clip, maskMobile, normalizeMobile, parseGuestLinkCode } from "../util";
import { type Ctx, linked, needLink, say } from "./context";
import { STATUS_LABELS, getSigners, listContractsForUser } from "@/modules/contracts/service";
import { type TgMessage } from "../client";
import { accountsOfChat, consumeLinkCode, getChat, setChatUser, setChatVerifiedMobile } from "../service";
import { and, count, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { contracts, users, workspaceMembers, workspaces } from "@/db/schema";
import { db } from "@/db";
import { fa, faNum } from "@/lib/jalali";

/* ───────── دستورها ───────── */

export async function cmdStart(c: Ctx, arg: string) {
  if (arg) return linkWithCode(c, arg);
  if (!linked(c.chat)) {
    return say(
      c,
      `سلام 👋 به ربات ${c.site} خوش آمدید.\n\nاینجا می‌توانید:\n✍️ لینک امضای قرارداد را دریافت کنید\n📊 وضعیت قراردادها را ببینید\n🔔 اعلان‌ها و یادآوری‌ها را همین‌جا بگیرید\n\nبرای شروع شماره‌ی موبایل خود را با دکمه‌ی پایین تأیید کنید.`,
      undefined,
      ASK_CONTACT,
    );
  }
  return cmdHelp(c);
}
export async function cmdHelp(c: Ctx) {
  await say(
    c,
    `راهنمای ربات ${c.site}\n\n/pending — قراردادهای منتظر امضای شما (با لینک امضا)\n/contracts — فهرست و وضعیت قراردادها\n/status <شماره> — وضعیت یک قرارداد\n/summary — خلاصه‌ی کسب‌وکار (اعضای تیم)\n/verify — تأیید شماره برای دریافت کد امضا در همین گفتگو\n/chats — گفتگوهای آنلاین منتظر پاسخ (پشتیبانی)\n/done — پایان «پاسخ از همین‌جا» در گفتگوی آنلاین\n/mute و /unmute — بی‌صدا/فعال کردن اعلان‌ها\n/stop — قطع اتصال`,
    undefined,
    MENU,
  );
}
async function linkWithCode(c: Ctx, code: string) {
  let userId: number | null = null;
  if (code.startsWith("l")) userId = await consumeLinkCode(code, c.bot.id);
  else if (code.startsWith("g")) {
    const gid = parseGuestLinkCode(code);
    if (gid) {
      const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, gid), eq(users.isGuest, true)));
      userId = u?.id ?? null;
    }
  }
  if (!userId) return say(c, "کد اتصال نامعتبر یا منقضی شده است. دوباره از صفحه‌ی مربوطه لینک اتصال بگیرید.", undefined, ASK_CONTACT);
  await setChatUser(c.chat.id, userId);
  const [u] = await db.select({ name: users.name, mobile: users.mobile }).from(users).where(eq(users.id, userId));
  const fresh = await getChat(c.chat.id);
  const verified = !!fresh?.chat.verifiedMobile;
  await say(
    c,
    `✅ اتصال برقرار شد${u?.name ? ` — ${u.name}` : ""}.\nاز این پس لینک‌های امضا و اعلان‌ها در همین گفتگو می‌رسد.${verified ? "" : "\n\nبرای دریافت «کد تأیید امضا» در همین گفتگو (به‌جای پیامک)، شماره‌ی موبایل خود را هم تأیید کنید:"}`,
    undefined,
    verified ? MENU : ASK_CONTACT,
  );
}
export async function onContact(c: Ctx, msg: TgMessage) {
  const ct = msg.contact;
  // فقط «شماره‌ی خودِ فرستنده» که با دکمه‌ی اشتراک شماره آمده؛ مخاطب فوروارد/دستی (جعل شماره‌ی دیگران) رد می‌شود
  if (!ct?.phone_number || !msg.from || ct.user_id !== msg.from.id || msg.forward_from || msg.forward_origin || msg.forward_date) {
    return say(c, "⛔ فقط با دکمه‌ی «اشتراک شماره‌ی من» و برای شماره‌ی خودِ همین حساب می‌توان تأیید کرد.", undefined, ASK_CONTACT);
  }
  const mobile = normalizeMobile(ct.phone_number);
  if (!mobile) return say(c, "فقط شماره‌ی موبایل ایرانی (۰۹…) پذیرفته می‌شود.", undefined, MENU);
  await setChatVerifiedMobile(c.chat.id, mobile);
  const fresh = (await getChat(c.chat.id)) ?? { ...c, chat: { ...c.chat, verifiedMobile: mobile } };
  await say(c, `✅ شماره‌ی ${maskMobile(mobile)} تأیید شد.\nاز این پس لینک امضا و کد تأیید قراردادهای این شماره در همین گفتگو می‌رسد.`, undefined, MENU);
  await cmdPending({ ...c, ...fresh });
}
/** قراردادهای طرف‌بودن این چت (با حساب یا موبایل گواهی‌شده)، بدون تکرار و محدود به فضای کاری ربات اختصاصی */
async function myContracts(c: Ctx, accounts: number[]) {
  const rows = (await Promise.all(accounts.map((id) => listContractsForUser(id, "all")))).flat();
  const seen = new Set<number>();
  let uniq = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  if (c.bot.workspaceId !== null && uniq.length) {
    const ok = await db.select({ id: contracts.id }).from(contracts).where(and(inArray(contracts.id, uniq.map((r) => r.id)), eq(contracts.workspaceId, c.bot.workspaceId)));
    const okIds = new Set(ok.map((o) => o.id));
    uniq = uniq.filter((r) => okIds.has(r.id));
  }
  return uniq;
}
export async function cmdPending(c: Ctx) {
  if (!linked(c.chat)) return needLink(c);
  const accounts = await accountsOfChat(c.chat);
  const list = await myContracts(c, accounts);
  const mine = list.filter((r) => r.state === "my_turn" && r.status === "sent");
  if (!mine.length) {
    const waiting = list.filter((r) => r.state === "waiting" && r.status === "sent").length;
    return say(c, `✅ هیچ قراردادی منتظر امضای شما نیست.${waiting ? `\n⏳ ${faNum(waiting)} قرارداد منتظر امضای دیگران است (/contracts).` : ""}`, undefined, MENU);
  }
  for (const r of mine.slice(0, 8)) {
    const access = await contractAccess(c, accounts, r.id);
    const link = access ? await signLinkFor(access) : null;
    if (!link) continue;
    await say(c, `✍️ نوبت امضای شماست\n📄 ${r.number} — «${clip(r.title, 120)}»\nنقش شما: ${r.myLabel}`, [[{ text: "✍️ مشاهده و امضای قرارداد", url: link.url }], [{ text: "📊 وضعیت", data: `c:${r.id}` }]]);
  }
  if (mine.length > 8) await say(c, `و ${faNum(mine.length - 8)} قرارداد دیگر… برای فهرست کامل /contracts`);
}
export async function cmdContracts(c: Ctx) {
  if (!linked(c.chat)) return needLink(c);
  const accounts = await accountsOfChat(c.chat);
  const list = (await myContracts(c, accounts)).slice(0, 8);
  const team = await teamContracts(c);
  if (!list.length && !team.length) return say(c, "هنوز قراردادی برای شما ثبت نشده است.", undefined, MENU);
  const lines: string[] = [];
  const buttons: Btn[][] = [];
  if (list.length) {
    lines.push("📄 قراردادهای شما");
    list.forEach((r, i) => lines.push(`${faNum(i + 1)}. ${r.number} — ${clip(r.title, 60)}\n    ${STATE_LABEL[r.state] ?? r.state}`));
    for (let i = 0; i < list.length; i += 2) buttons.push(list.slice(i, i + 2).map((r) => ({ text: `${r.state === "my_turn" ? "✍️ " : ""}${r.number}`, data: `c:${r.id}` })));
  }
  if (team.length) {
    lines.push("", "👥 آخرین قراردادهای تیم");
    team.forEach((r) => lines.push(`• ${r.number} — ${clip(r.title, 60)} (${STATUS_LABELS[r.status] ?? r.status})`));
    for (let i = 0; i < team.length; i += 2) buttons.push(team.slice(i, i + 2).map((r) => ({ text: `👥 ${r.number}`, data: `c:${r.id}` })));
  }
  await say(c, lines.join("\n"), buttons);
}
async function teamContracts(c: Ctx) {
  if (!c.chat.userId) return [];
  const ws = await db.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers).where(and(eq(workspaceMembers.userId, c.chat.userId), inArray(workspaceMembers.role, ["owner", "admin", "member", "viewer"])));
  const ids = ws.map((w) => w.id).filter((id) => c.bot.workspaceId === null || id === c.bot.workspaceId);
  if (!ids.length) return [];
  return db.select({ id: contracts.id, number: contracts.number, title: contracts.title, status: contracts.status }).from(contracts).where(and(inArray(contracts.workspaceId, ids), ne(contracts.status, "draft"))).orderBy(sql`${contracts.issuedAt} desc`).limit(6);
}
export async function cmdStatus(c: Ctx, arg: string) {
  if (!linked(c.chat)) return needLink(c);
  if (!arg) return cmdContracts(c);
  const num = arg.replace(/\s+/g, "").slice(0, 40);
  const accounts = await accountsOfChat(c.chat);
  const rows = await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.number, num)).limit(5);
  for (const r of rows) if (await contractAccess(c, accounts, r.id)) return showContract(c, accounts, r.id);
  return say(c, "قراردادی با این شماره پیدا نشد (یا به آن دسترسی ندارید).");
}
export async function showContract(c: Ctx, accounts: number[], id: number) {
  const access = await contractAccess(c, accounts, id);
  if (!access) return say(c, "قرارداد پیدا نشد یا به آن دسترسی ندارید.");
  const k = access.contract;
  const signers = await getSigners(id);
  const done = signers.filter((s) => s.status === "signed").length;
  const lines = [
    `📄 ${k.number}`,
    `«${clip(k.title, 150)}»`,
    `وضعیت: ${STATUS_LABELS[k.status] ?? k.status}`,
    `صدور: ${fa(k.issuedAt)}`,
    k.status === "sent" && k.expiresAt ? `مهلت امضا: ${fa(k.expiresAt)}` : "",
    "",
    `امضاکنندگان (${faNum(done)} از ${faNum(signers.length)}):`,
    ...signers.map((s) => `${s.status === "signed" ? "✅" : s.status === "rejected" ? "❌" : "⏳"} ${s.label} — ${clip(s.userName, 40)}${s.role === "witness" ? " (شاهد)" : ""}${s.signedAt ? ` — ${fa(s.signedAt)}` : ""}`),
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "");
  const buttons: Btn[][] = [];
  const link = await signLinkFor(access);
  if (link) buttons.push([{ text: "✍️ مشاهده و امضا", url: link.url }]);
  if (k.status === "sent" && access.teamRole && ACT_ROLES.includes(access.teamRole) && c.chat.userId) buttons.push([{ text: "🔔 یادآوری به امضاکنندگان", data: `r:${id}` }]);
  if (k.status === "signed") buttons.push([{ text: (await pdfAllowed(c, access)) ? "📎 دریافت فایل نهایی (PDF)" : "📄 نسخه‌ی نهایی", data: `f:${id}` }]);
  buttons.push([{ text: "🔄 به‌روزرسانی", data: `c:${id}` }]);
  await say(c, lines.join("\n"), buttons);
}
/** خلاصه‌ی کسب‌وکار برای اعضای تیم (حساب وصل‌شده): وضعیت قراردادها و موارد در آستانه‌ی انقضا */
export async function cmdSummary(c: Ctx) {
  if (!c.chat.userId) return say(c, "خلاصه‌ی کسب‌وکار فقط برای اعضای تیمِ حساب‌های وصل‌شده است. از «حساب من ← پیام‌رسان‌ها» لینک اتصال بگیرید.", undefined, MENU);
  const mem = await db
    .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, c.chat.userId), inArray(workspaceMembers.role, ["owner", "admin", "member", "viewer"]), eq(workspaces.kind, "team")));
  const list = mem.filter((m) => c.bot.workspaceId === null || m.id === c.bot.workspaceId);
  if (!list.length) return say(c, "عضو هیچ فضای کاری نیستید.", undefined, MENU);
  const out: string[] = [];
  for (const w of list.slice(0, 5)) {
    const rows = await db.select({ status: contracts.status, n: count() }).from(contracts).where(and(eq(contracts.workspaceId, w.id), ne(contracts.status, "draft"))).groupBy(contracts.status);
    const by = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    const [soon] = await db
      .select({ n: count() })
      .from(contracts)
      .where(and(eq(contracts.workspaceId, w.id), eq(contracts.status, "sent"), gt(contracts.expiresAt, new Date()), lt(contracts.expiresAt, new Date(Date.now() + 72 * 3600_000))));
    out.push(`🏢 ${w.name}\n⏳ منتظر امضا: ${faNum(by("sent"))}\n✅ امضا شده: ${faNum(by("signed"))}\n❌ رد/منقضی/لغو: ${faNum(by("rejected") + by("expired") + by("cancelled"))}${soon?.n ? `\n⚠️ مهلتِ کمتر از ۷۲ ساعت: ${faNum(soon.n)}` : ""}`);
  }
  await say(c, out.join("\n\n"), undefined, MENU);
}
