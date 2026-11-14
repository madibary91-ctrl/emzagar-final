import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts, contractSigners, userNotifications, users } from "@/db/schema";
import { fa } from "@/lib/jalali";
import { registerJobHandler } from "@/modules/jobs/queue";
import { getOrCreateSigningLink, signingUrl } from "@/modules/signing/links";
import { getAllSettings } from "@/modules/settings/service";
import { accountsOfChat, appBase, getChat } from "./service";
import { contractAccess, sendFinalCopy } from "./contracts";
import { deliver } from "./send";
import { clip, NOTICE_ICON } from "./util";

/** نتیجه‌ی ارسال را به صف برمی‌گرداند: خطای موقت ⇒ استثنا (تلاش دوباره با backoff)؛ دائمی ⇒ پایان */
function settle(r: Awaited<ReturnType<typeof deliver>>, last: boolean) {
  if (!r.ok && r.retry && !last) throw new Error(r.error);
}

/** اعلان درون‌برنامه‌ای (زنگوله) ← پیام‌رسان */
registerJobHandler("messenger.notice", {
  async run(p, ctx) {
    const t = await getChat(Number(p.chatRowId));
    if (!t || t.chat.blocked || t.chat.muted || !t.bot.active) return;
    const [n] = await db.select().from(userNotifications).where(eq(userNotifications.id, Number(p.notificationId)));
    if (!n) return;
    const [u] = await db.select({ isGuest: users.isGuest }).from(users).where(eq(users.id, n.userId));
    const base = await appBase(t.bot.workspaceId);
    // مهمان حساب/پنل ندارد: پیوند «/contracts/…» برایش بی‌فایده است؛ به‌جای آن کیف اسناد (ورود با OTP)
    const href = u?.isGuest ? (base ? "/vault" : null) : n.href;
    const buttons = href && base && href.startsWith("/") ? [[{ text: u?.isGuest ? "کیف اسناد من" : "مشاهده در پنل", url: base + href }]] : [];
    const text = `${NOTICE_ICON[n.kind] ?? "ℹ️"} ${n.title}${n.body ? `\n${clip(n.body, 600)}` : ""}`;
    settle(await deliver(t, { text, buttons }, { kind: "notice", final: ctx.last }), ctx.last);
  },
});

/** لینک امضا (صدور / نوبت / یادآوری) ← پیام‌رسان امضاکننده */
registerJobHandler("messenger.signlink", {
  async run(p, ctx) {
    const t = await getChat(Number(p.chatRowId));
    if (!t || t.chat.blocked || !t.bot.active) return;
    const signerId = Number(p.signerId);
    const [signer] = await db.select().from(contractSigners).where(eq(contractSigners.id, signerId));
    if (!signer) return;
    const [contract] = await db.select().from(contracts).where(eq(contracts.id, signer.contractId));
    // وضعیت در لحظه‌ی ارسال دوباره سنجیده می‌شود (ممکن است بین صف و ارسال امضا/لغو شده باشد)
    if (!contract || contract.status !== "sent" || signer.status !== "pending") return;
    const link = await getOrCreateSigningLink(signerId);
    if (!link) return;
    const url = await signingUrl(link.token, contract.workspaceId);
    const cfg = await getAllSettings(contract.workspaceId);
    const kind = String(p.kind);
    const head = kind === "reminder" ? "⏰ یادآوری امضا" : kind === "turn" ? "✍️ نوبت امضای شماست" : "📨 قرارداد جدید برای امضا";
    const lines = [
      `${head} — ${cfg.site_name}`,
      `📄 ${contract.number} — «${clip(contract.title, 120)}»`,
      `نقش شما: ${signer.label}`,
      contract.expiresAt ? `⏳ مهلت امضا: ${fa(contract.expiresAt)}` : "",
      "",
      "برای امضا نیازی به ثبت‌نام نیست؛ پس از باز کردن لینک، کد تأیید برایتان ارسال می‌شود.",
    ].filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""));
    const r = await deliver(
      t,
      { text: lines.join("\n"), buttons: [[{ text: "✍️ مشاهده و امضای قرارداد", url }], [{ text: "📊 وضعیت قرارداد", data: `c:${contract.id}` }]] },
      { kind: "signlink", contractId: contract.id, final: ctx.last },
    );
    settle(r, ctx.last);
  },
});

/** نسخه‌ی نهایی امضاشده (PDF) ← پیام‌رسان طرفین (فقط رباتی که «ارسال PDF» دارد) */
registerJobHandler("messenger.finalcopy", {
  async run(p, ctx) {
    const t = await getChat(Number(p.chatRowId));
    if (!t || t.chat.blocked || !t.bot.active || !t.bot.sendPdf) return;
    const access = await contractAccess(t, await accountsOfChat(t.chat), Number(p.contractId));
    if (!access || access.contract.status !== "signed") return;
    settle(await sendFinalCopy(t, access, { final: ctx.last }), ctx.last);
  },
});
