import crypto from "node:crypto";
import { cookies } from "next/headers";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { contracts, contractSigners, signingLinks, users } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { escapeHtml } from "@/lib/html";
import { fa } from "@/lib/jalali";
import { sha256 } from "@/lib/password";
import { getOrigin } from "@/lib/request";
import { getSecret } from "@/lib/secret";
import { getAllSettings } from "@/modules/settings/service";
import { sendMail } from "@/modules/mail";
import { sendSms } from "@/modules/sms";
import { isSecureRequest } from "@/modules/auth/session";
import { isSignerTurn } from "./stages";
import { queueSignLink } from "@/modules/messengers/outbox";

/** حداکثر عمر یک لینک امضا (اگر قرارداد مهلت کوتاه‌تری داشته باشد، همان مهلت) */
const MAX_LINK_DAYS = 60;
const DEFAULT_LINK_DAYS = 30;
/** مدت اعتبار نشست مهمان پس از تأیید OTP */
export const GUEST_SESSION_SECONDS = 30 * 60;

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

type Contract = typeof contracts.$inferSelect;
type SignerRow = typeof contractSigners.$inferSelect;

/* ───────── ساخت و بازیابی لینک ───────── */

function newToken(): string {
  return crypto.randomBytes(32).toString("base64url"); // ۴۳ نویسه، ۲۵۶ بیت آنتروپی
}

/** لینک فعال امضاکننده؛ اگر نبود (یا منقضی/مصرف‌شده بود) لینک تازه می‌سازد و بقیه را باطل می‌کند */
export async function getOrCreateSigningLink(signerId: number): Promise<{ token: string; expiresAt: Date; linkId: number } | null> {
  const [signer] = await db.select().from(contractSigners).where(eq(contractSigners.id, signerId));
  if (!signer || signer.status !== "pending") return null;
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, signer.contractId));
  if (!contract || contract.status !== "sent") return null;

  const now = new Date();
  const active = await db
    .select()
    .from(signingLinks)
    .where(and(eq(signingLinks.signerId, signerId), isNull(signingLinks.revokedAt), isNull(signingLinks.usedAt), gt(signingLinks.expiresAt, new Date(now.getTime() + 60_000))))
    .orderBy(desc(signingLinks.createdAt))
    .limit(1);
  if (active[0]) {
    const token = decryptSecret(active[0].tokenEnc);
    if (TOKEN_RE.test(token)) return { token, expiresAt: active[0].expiresAt, linkId: active[0].id };
  }

  await db.update(signingLinks).set({ revokedAt: now }).where(and(eq(signingLinks.signerId, signerId), isNull(signingLinks.revokedAt)));
  const token = newToken();
  const horizon = new Date(now.getTime() + (contract.expiresAt ? MAX_LINK_DAYS : DEFAULT_LINK_DAYS) * 86400_000);
  const expiresAt = contract.expiresAt && contract.expiresAt < horizon ? contract.expiresAt : horizon;
  const [row] = await db
    .insert(signingLinks)
    .values({ contractId: contract.id, signerId, tokenHash: sha256(token), tokenEnc: encryptSecret(token), expiresAt })
    .returning({ id: signingLinks.id });
  return { token, expiresAt, linkId: row.id };
}

export async function signingUrl(token: string, workspaceId: number): Promise<string> {
  const cfg = await getAllSettings(workspaceId);
  const base = (cfg.app_url || (await getOrigin())).replace(/\/+$/, "");
  return `${base}/sign/${token}`;
}

/** باطل‌کردن لینک‌های یک قرارداد (لغو، رد، انقضا، حذف) یا یک امضاکننده */
export async function revokeSigningLinks(by: { contractId?: number; signerId?: number }) {
  const cond = by.signerId ? eq(signingLinks.signerId, by.signerId) : eq(signingLinks.contractId, by.contractId ?? -1);
  await db.update(signingLinks).set({ revokedAt: new Date() }).where(and(cond, isNull(signingLinks.revokedAt)));
}

export async function markSigningLinkUsed(signerId: number) {
  await db.update(signingLinks).set({ usedAt: new Date() }).where(and(eq(signingLinks.signerId, signerId), isNull(signingLinks.usedAt)));
}

/* ───────── تشخیص وضعیت لینک ───────── */

export type LinkState =
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "closed"; reason: "rejected" | "cancelled" | "expired" | "draft" }
  | { status: "done"; ctx: LinkContext }
  | { status: "ok"; ctx: LinkContext };

export type LinkContext = {
  link: typeof signingLinks.$inferSelect;
  signer: SignerRow;
  contract: Contract;
  user: typeof users.$inferSelect;
};

/** از روی توکن، وضعیت لینک را تعیین می‌کند. ورودی نامعتبر یا ناموجود همیشه «invalid» است (بدون نشت اطلاعات) */
export async function resolveSigningToken(token: string): Promise<LinkState> {
  if (!TOKEN_RE.test(token)) return { status: "invalid" };
  const [link] = await db.select().from(signingLinks).where(eq(signingLinks.tokenHash, sha256(token)));
  if (!link || link.revokedAt) {
    // لینک باطل‌شده‌ی یک قرارداد پایان‌یافته را می‌توان دقیق‌تر توضیح داد
    if (link) {
      const [c] = await db.select({ status: contracts.status }).from(contracts).where(eq(contracts.id, link.contractId));
      if (c && ["rejected", "cancelled", "expired"].includes(c.status)) return { status: "closed", reason: c.status as "rejected" | "cancelled" | "expired" };
    }
    return { status: "invalid" };
  }
  const [signer] = await db.select().from(contractSigners).where(eq(contractSigners.id, link.signerId));
  const [contract] = signer ? await db.select().from(contracts).where(eq(contracts.id, signer.contractId)) : [];
  const [user] = signer ? await db.select().from(users).where(eq(users.id, signer.userId)) : [];
  if (!signer || !contract || !user || contract.id !== link.contractId) return { status: "invalid" };
  const ctx: LinkContext = { link, signer, contract, user };

  if (signer.status === "signed") return { status: "done", ctx };
  if (contract.status === "draft") return { status: "closed", reason: "draft" };
  if (contract.status === "rejected" || signer.status === "rejected") return { status: "closed", reason: "rejected" };
  if (contract.status === "cancelled") return { status: "closed", reason: "cancelled" };
  if (contract.status === "expired" || (contract.expiresAt && contract.expiresAt < new Date())) return { status: "closed", reason: "expired" };
  if (contract.status !== "sent") return { status: "invalid" };
  if (link.usedAt) return { status: "invalid" };
  if (link.expiresAt < new Date()) return { status: "expired" };

  // نوبت امضا: فقط وقتی همه‌ی امضاکنندگانِ «مرحله‌های پیشین» امضا کرده‌اند (هم‌مرحله‌ها هم‌زمان نوبت دارند)
  const all = await db.select({ position: contractSigners.position, stage: contractSigners.stage, status: contractSigners.status }).from(contractSigners).where(eq(contractSigners.contractId, contract.id));
  if (!isSignerTurn(all, signer)) return { status: "invalid" };
  return { status: "ok", ctx };
}

export async function recordLinkOpen(linkId: number): Promise<boolean> {
  const rows = await db
    .update(signingLinks)
    .set({ opens: sql`${signingLinks.opens} + 1`, lastOpenedAt: new Date() })
    .where(eq(signingLinks.id, linkId))
    .returning({ opens: signingLinks.opens });
  return rows[0]?.opens === 1;
}

/* ───────── نشست مهمان (پس از تأیید OTP) ───────── */

const cookieName = (linkId: number) => `amz_gs_${linkId}`;
const mac = (payload: string) => crypto.createHmac("sha256", getSecret()).update(`guest:${payload}`).digest("hex");

export async function startGuestSession(linkId: number, signerId: number) {
  const exp = Math.floor(Date.now() / 1000) + GUEST_SESSION_SECONDS;
  const payload = `${linkId}.${signerId}.${exp}`;
  (await cookies()).set(cookieName(linkId), `${exp}.${mac(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: await isSecureRequest(),
    path: "/",
    maxAge: GUEST_SESSION_SECONDS,
  });
}

/** آیا مرورگر فعلی (برای همین لینک و همین امضاکننده) OTP را گذرانده است؟ */
export async function hasGuestSession(linkId: number, signerId: number): Promise<boolean> {
  const raw = (await cookies()).get(cookieName(linkId))?.value;
  if (!raw) return false;
  const [expStr, sig] = raw.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now() / 1000) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(mac(`${linkId}.${signerId}.${exp}`));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ───────── اعلان به امضاکننده ───────── */

export type NotifyKind = "issue" | "turn" | "reminder";

const SUBJECTS: Record<NotifyKind, (n: string) => string> = {
  issue: (n) => `قرارداد جدید برای امضا: ${n}`,
  turn: (n) => `نوبت امضای شما: ${n}`,
  reminder: (n) => `یادآوری امضا: ${n}`,
};

export const validMobile = (m: string | null | undefined): m is string => !!m && /^09\d{9}$/.test(m);

/**
 * لینک امضای امن را برای امضاکننده می‌فرستد (ایمیل + در صورت فعال‌بودن، پیامک).
 * خروجی: آدرس لینک (برای نمایش به مدیر) یا null اگر نوبت/وضعیت اجازه نمی‌دهد.
 */
export async function notifySigner(contractId: number, signerId: number, kind: NotifyKind, opts?: { smsOverride?: boolean }): Promise<string | null> {
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  const [signer] = await db.select().from(contractSigners).where(and(eq(contractSigners.id, signerId), eq(contractSigners.contractId, contractId)));
  if (!contract || !signer) return null;
  const [user] = await db.select().from(users).where(eq(users.id, signer.userId));
  if (!user) return null;
  const link = await getOrCreateSigningLink(signerId);
  if (!link) return null;
  const url = await signingUrl(link.token, contract.workspaceId);
  const cfg = await getAllSettings(contract.workspaceId);

  const intro =
    kind === "reminder"
      ? `قرارداد «${escapeHtml(contract.title)}» هنوز منتظر امضای شماست.`
      : kind === "turn"
        ? `نوبت امضای شما در قرارداد «${escapeHtml(contract.title)}» رسیده است.`
        : `قرارداد «${escapeHtml(contract.title)}» برای امضای شما آماده است.`;
  if (user.email && !user.email.endsWith(".invalid")) {
    await sendMail({
      to: user.email,
      subject: SUBJECTS[kind](contract.number),
      html: `<div dir="rtl" style="font-family:Tahoma,sans-serif;line-height:2"><p>${escapeHtml(user.name)} عزیز، ${intro}</p><p>برای امضا نیازی به ثبت‌نام نیست؛ فقط روی دکمه‌ی زیر بزنید و با کد پیامکی هویت خود را تأیید کنید:</p><p><a href="${url}" style="display:inline-block;background:#102c31;color:#41e4ad;padding:12px 26px;border-radius:12px;text-decoration:none;font-weight:bold">مشاهده و امضای قرارداد</a></p><p style="font-size:12px;color:#666;word-break:break-all" dir="ltr">${url}</p>${contract.expiresAt ? `<p>مهلت امضا: ${fa(contract.expiresAt)}</p>` : ""}<p style="color:#888;font-size:12px">این لینک اختصاصی شماست؛ آن را با دیگران به اشتراک نگذارید.</p></div>`,
      contractId,
    });
  }
  const smsWanted = opts?.smsOverride ?? (kind === "reminder" ? cfg.reminder_sms === "1" : cfg.sign_link_sms === "1");
  if (smsWanted && validMobile(user.mobile)) {
    await sendSms({ to: user.mobile, text: `${cfg.site_name}: قرارداد ${contract.number} برای امضای شما آماده است.\n${url}` }, contractId);
  }
  // پیام‌رسان‌ها (تلگرام/بله): لینک امضا به چت‌های متصل امضاکننده هم می‌رسد (بدون هزینه‌ی پیامک)
  await queueSignLink({ contractId, signerId, userId: user.id, workspaceId: contract.workspaceId, kind });
  return url;
}
