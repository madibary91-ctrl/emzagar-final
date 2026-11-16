import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { contracts, contractSigners, signingLinks, users, workspaceMembers } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { getContractPdf } from "@/modules/pdf/service";
import { getOrCreateSigningLink, signingUrl, TOKEN_RE } from "@/modules/signing/links";
import { isSignerTurn } from "@/modules/signing/stages";
import { getAllSettings } from "@/modules/settings/service";
import { deliver, type DeliverResult } from "./send";
import { appBase, type Chat, type ChatTarget } from "./service";

/** نقش‌هایی که از پیام‌رسان می‌توانند قراردادهای تیم را ببینند / یادآوری بفرستند */
export const VIEW_ROLES = ["owner", "admin", "member", "viewer"];
export const ACT_ROLES = ["owner", "admin", "member"];

export type Contract = typeof contracts.$inferSelect;

export interface Access {
  contract: Contract;
  /** ردیف‌های امضاکننده‌ی خود این چت در این قرارداد */
  mySigners: (typeof contractSigners.$inferSelect)[];
  /** نقش عضویت تیم در فضای کاری قرارداد (فقط برای حساب وصل‌شده‌ی چت) */
  teamRole: string | null;
}

/**
 * دسترسی چت به یک قرارداد. اصل: فقط طرف‌های قرارداد (با حساب یا موبایل گواهی‌شده) و اعضای تیم حساب وصل‌شده.
 * ربات اختصاصی یک فضای کاری هرگز قراردادهای فضای دیگر را نشان نمی‌دهد.
 */
export async function contractAccess(t: ChatTarget, accounts: number[], contractId: number): Promise<Access | null> {
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  if (!contract || contract.status === "draft") return null;
  if (t.bot.workspaceId !== null && t.bot.workspaceId !== contract.workspaceId) return null;
  const mySigners = accounts.length ? await db.select().from(contractSigners).where(and(eq(contractSigners.contractId, contractId), inArray(contractSigners.userId, accounts))) : [];
  let teamRole: string | null = null;
  if (t.chat.userId) {
    const [m] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, contract.workspaceId), eq(workspaceMembers.userId, t.chat.userId)));
    if (m && VIEW_ROLES.includes(m.role)) teamRole = m.role;
  }
  if (!mySigners.length && !teamRole) return null;
  return { contract, mySigners, teamRole };
}

/** لینک امضای تازه برای امضاکننده‌ای که نوبتش است (یا null) */
export async function signLinkFor(access: Access): Promise<{ url: string; signerId: number } | null> {
  if (access.contract.status !== "sent") return null;
  const all = await db.select({ position: contractSigners.position, stage: contractSigners.stage, status: contractSigners.status }).from(contractSigners).where(eq(contractSigners.contractId, access.contract.id));
  for (const s of access.mySigners) {
    if (s.status !== "pending" || !isSignerTurn(all, s)) continue;
    const link = await getOrCreateSigningLink(s.id);
    if (link) return { url: await signingUrl(link.token, access.contract.workspaceId), signerId: s.id };
  }
  return null;
}

/** لینک دریافت نسخه‌ی نهایی: مهمان ← لینک اختصاصی خودش (با OTP)؛ کاربر ثبت‌نامی ← صفحه‌ی قرارداد در پنل */
export async function finalCopyUrl(access: Access): Promise<string | null> {
  const mine = access.mySigners.find((s) => s.status === "signed");
  if (mine) {
    const [u] = await db.select({ isGuest: users.isGuest }).from(users).where(eq(users.id, mine.userId));
    if (u?.isGuest) {
      const [link] = await db
        .select()
        .from(signingLinks)
        .where(and(eq(signingLinks.signerId, mine.id), isNull(signingLinks.revokedAt)))
        .orderBy(desc(signingLinks.createdAt))
        .limit(1);
      if (link) {
        try {
          const token = decryptSecret(link.tokenEnc);
          if (TOKEN_RE.test(token)) return await signingUrl(token, access.contract.workspaceId);
        } catch {
          /* لینک قابل‌بازیابی نیست */
        }
      }
      const base = await appBase(access.contract.workspaceId);
      return base ? `${base}/vault` : null;
    }
  }
  const base = await appBase(access.contract.workspaceId);
  return base ? `${base}/contracts/${access.contract.id}` : null;
}

/** PDF فقط وقتی داخل پیام‌رسان فرستاده می‌شود که ربات اجازه دهد و هویت چت گواهی‌شده باشد (مهمان: موبایل گواهی‌شده‌ی برابر) */
export async function pdfAllowed(t: ChatTarget, access: Access): Promise<boolean> {
  if (!t.bot.sendPdf || access.contract.status !== "signed") return false;
  // عضو تیمِ حساب وصل‌شده (اتصال احرازشده از پنل) می‌تواند نسخه‌ی نهایی قرارداد تیم را بگیرد
  if (access.teamRole && ACT_ROLES.includes(access.teamRole) && t.chat.userId) return true;
  for (const s of access.mySigners) {
    if (s.status !== "signed") continue;
    const [u] = await db.select({ isGuest: users.isGuest, mobile: users.mobile }).from(users).where(eq(users.id, s.userId));
    if (!u) continue;
    if (!u.isGuest && t.chat.userId === s.userId) return true;
    if (u.isGuest && t.chat.verifiedMobile && t.chat.verifiedMobile === u.mobile) return true;
  }
  return false;
}

/** نسخه‌ی نهایی قرارداد را برای یک چت می‌فرستد (PDF اگر مجاز باشد، وگرنه لینک امن) */
export async function sendFinalCopy(t: ChatTarget, access: Access, o: { final: boolean }): Promise<DeliverResult> {
  const c = access.contract;
  const url = await finalCopyUrl(access);
  const buttons = url ? [[{ text: "📄 مشاهده‌ی نسخه‌ی نهایی", url }]] : [];
  if (await pdfAllowed(t, access)) {
    const pdf = await getContractPdf(c.id);
    return deliver(t, { text: `📎 نسخه‌ی نهایی امضاشده‌ی قرارداد ${c.number}\n«${c.title}»`, buttons }, { kind: "finalcopy", contractId: c.id, final: o.final, document: { buffer: pdf.buffer, filename: `${c.number}.pdf` } });
  }
  const cfg = await getAllSettings(c.workspaceId);
  return deliver(t, { text: `✅ قرارداد ${c.number} — «${c.title}» توسط همه‌ی طرفین امضا شد.\nنسخه‌ی رسمی را از لینک امن ${cfg.site_name} دریافت کنید.`, buttons }, { kind: "finalcopy", contractId: c.id, final: o.final });
}

export type { Chat };
