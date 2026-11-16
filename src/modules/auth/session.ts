import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, desc, eq, isNull, ne, gt } from "drizzle-orm";
import { db } from "@/db";
import { userSessions, users } from "@/db/schema";
import { getSecret } from "@/lib/secret";
import { trustedAppOrigin } from "@/lib/config";
import { getRequestInfo } from "@/lib/request";
import { notifyUser } from "@/modules/inbox/service";

const COOKIE = "amz_session";
const MAX_AGE = 60 * 60 * 24 * 7;

/** نسخه‌ی رمز: با تغییر رمز عبور، همه‌ی نشست‌های قبلی خودبه‌خود باطل می‌شوند */
function pv(passwordHash: string) {
  return crypto.createHash("sha256").update(passwordHash).digest("hex").slice(0, 12);
}

function mac(payload: string) {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("hex");
}

export async function isSecureRequest(): Promise<boolean> {
  // اگر آدرس مورد اعتماد سایت HTTPS است، کوکی همیشه Secure است (حتی اگر پراکسی هدر x-forwarded-proto را نفرستد)
  if (trustedAppOrigin().startsWith("https://")) return true;
  try {
    const h = await headers();
    return (h.get("x-forwarded-proto") || "").split(",")[0].trim() === "https";
  } catch {
    return false;
  }
}

/** هر نشست یک شناسه‌ی تصادفی دارد که در کوکی (امضاشده) و جدول user_sessions است؛ حذف ردیف = خروج فوری آن دستگاه */
export class GuestLoginForbiddenError extends Error {
  constructor() {
    super("GUEST_LOGIN_FORBIDDEN");
    this.name = "GuestLoginForbiddenError";
  }
}

export async function createSession(userId: number, passwordHash: string, opts: { maxAgeSec?: number } = {}) {
  // آخرین خط دفاع (مستقل از مسیر ورود: رمز، 2FA، دعوت، SSO وردپرس، …): «مهمان» هرگز نشست پنل نمی‌گیرد
  const [who] = await db.select({ isGuest: users.isGuest }).from(users).where(eq(users.id, userId));
  if (!who || who.isGuest) throw new GuestLoginForbiddenError();
  const maxAge = Math.min(MAX_AGE, Math.max(60, opts.maxAgeSec ?? MAX_AGE));
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const sid = crypto.randomBytes(24).toString("base64url");
  const payload = `${userId}.${exp}.${sid}`;
  let ip = "";
  let userAgent = "";
  try {
    ({ ip, userAgent } = await getRequestInfo());
  } catch {
    /* خارج از چرخه‌ی درخواست */
  }
  try {
    const known = await db.select({ ip: userSessions.ip, userAgent: userSessions.userAgent }).from(userSessions).where(eq(userSessions.userId, userId)).limit(200);
    await db.insert(userSessions).values({ id: sid, userId, userAgent, ip, expiresAt: new Date(exp * 1000) });
    // ورود از دستگاه/مرورگر تازه → اعلان امنیتی (اولین ورود حساب اعلان نمی‌گیرد)
    if (known.length > 0 && !known.some((k) => k.userAgent === userAgent)) {
      await notifyUser(userId, { kind: "security", title: "ورود از دستگاه جدید", body: `ورود تازه از «${describeUserAgent(userAgent)}» (IP: ${ip || "نامشخص"}). اگر شما نبودید، از «حساب من» نشست را ببندید و رمز را تغییر دهید.`, href: "/account#sessions" });
    }
  } catch (e) {
    console.error("[session:create]", e);
  }
  const jar = await cookies();
  jar.set(COOKIE, `${payload}.${mac(`${payload}.${pv(passwordHash)}`)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: await isSecureRequest(),
    path: "/",
    maxAge,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  const sid = raw ? parseCookie(raw)?.sid : null;
  if (sid) await db.update(userSessions).set({ revokedAt: new Date() }).where(and(eq(userSessions.id, sid), isNull(userSessions.revokedAt))).catch(() => undefined);
  jar.delete(COOKIE);
  jar.delete("amz_ws");
}

export type SessionUser = typeof users.$inferSelect;

/** کوکی نشست: id.exp.sid.sig */
function parseCookie(raw: string): { id: string; exp: string; sid: string | null; sig: string } | null {
  const p = raw.split(".");
  // قالب قدیمی (بدون sid) پذیرفته نمی‌شود: قابل ابطال نیست و با خروج/بستن نشست از کار نمی‌افتاد
  if (p.length === 4) return { id: p[0], exp: p[1], sid: p[2], sig: p[3] };
  return null;
}

const TOUCH_EVERY_MS = 5 * 60_000;

export async function getCurrentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return null;
  const c = parseCookie(raw);
  if (!c || !c.id || !c.exp || !c.sig || !/^\d+$/.test(c.id) || !/^\d+$/.test(c.exp)) return null;
  if (Number(c.exp) < Date.now() / 1000) return null;
  const [user] = await db.select().from(users).where(eq(users.id, Number(c.id)));
  // مهمان (is_guest) حتی با کوکی معتبر/جعلی هم کاربر پنل نیست؛ فقط لینک اختصاصی + OTP دارد
  if (!user || user.isGuest) return null;
  const payload = c.sid ? `${c.id}.${c.exp}.${c.sid}` : `${c.id}.${c.exp}`;
  const expected = mac(`${payload}.${pv(user.passwordHash)}`);
  const a = Buffer.from(c.sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (c.sid) {
    const [row] = await db.select().from(userSessions).where(and(eq(userSessions.id, c.sid), eq(userSessions.userId, user.id)));
    if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) return null;
    if (Date.now() - row.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
      await db.update(userSessions).set({ lastSeenAt: new Date() }).where(eq(userSessions.id, c.sid)).catch(() => undefined);
    }
  }
  return user;
}

/** شناسه‌ی نشست فعلی (برای علامت‌گذاری «این دستگاه») */
export async function getCurrentSessionId(): Promise<string | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  return raw ? parseCookie(raw)?.sid ?? null : null;
}

export type SessionRow = { id: string; userAgent: string; ip: string; createdAt: Date; lastSeenAt: Date; current: boolean };

export async function listSessions(userId: number, currentSid: string | null): Promise<SessionRow[]> {
  const rows = await db
    .select()
    .from(userSessions)
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt), gt(userSessions.expiresAt, new Date())))
    .orderBy(desc(userSessions.lastSeenAt))
    .limit(50);
  return rows.map((r) => ({ id: r.id, userAgent: r.userAgent, ip: r.ip, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, current: r.id === currentSid }));
}

export async function revokeSession(userId: number, sid: string): Promise<boolean> {
  const rows = await db.update(userSessions).set({ revokedAt: new Date() }).where(and(eq(userSessions.id, sid), eq(userSessions.userId, userId), isNull(userSessions.revokedAt))).returning({ id: userSessions.id });
  return rows.length > 0;
}

/** همه‌ی نشست‌ها به‌جز keepSid (null = همه) */
export async function revokeSessions(userId: number, keepSid: string | null): Promise<number> {
  const rows = await db
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt), keepSid ? ne(userSessions.id, keepSid) : undefined))
    .returning({ id: userSessions.id });
  return rows.length;
}

/** توصیف خوانا از User-Agent: «Chrome روی Windows» */
export function describeUserAgent(ua: string): string {
  if (!ua || ua === "unknown") return "دستگاه ناشناس";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /vitest|node|curl/i.test(ua) ? "ابزار خط فرمان" : "مرورگر";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} روی ${os}` : browser;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/* ═════════════ مرحله‌ی میانی ورود دومرحله‌ای ═════════════ */

const PENDING_COOKIE = "amz_2fa";
const PENDING_TTL = 5 * 60;

/**
 * پس از تأیید رمز و پیش از تأیید کد TOTP، فقط یک کوکی کوتاه‌مدت و امضاشده ساخته می‌شود (نه نشست کامل).
 * امضا به نسخه‌ی رمز وابسته است؛ با تغییر رمز، مرحله‌ی میانی هم باطل می‌شود.
 */
export async function createPending2fa(userId: number, passwordHash: string) {
  const exp = Math.floor(Date.now() / 1000) + PENDING_TTL;
  const payload = `${userId}.${exp}`;
  const jar = await cookies();
  jar.set(PENDING_COOKIE, `${payload}.${mac(`2fa:${payload}.${pv(passwordHash)}`)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: await isSecureRequest(),
    path: "/",
    maxAge: PENDING_TTL,
  });
}

export async function readPending2fa(): Promise<SessionUser | null> {
  const jar = await cookies();
  const raw = jar.get(PENDING_COOKIE)?.value;
  if (!raw) return null;
  const [id, exp, sig] = raw.split(".");
  if (!id || !exp || !sig || !/^\d+$/.test(id) || !/^\d+$/.test(exp)) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  const [user] = await db.select().from(users).where(eq(users.id, Number(id)));
  if (!user) return null;
  const expected = mac(`2fa:${id}.${exp}.${pv(user.passwordHash)}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return user;
}

export async function clearPending2fa() {
  (await cookies()).delete(PENDING_COOKIE);
}

/* ═════════════ مرحله‌ی میانی «تأیید ایمیل» ═════════════ */

const VERIFY_COOKIE = "amz_ev";
const VERIFY_COOKIE_TTL = 60 * 60;

/**
 * کاربر تأییدنشده فقط یک کوکی امضاشده‌ی کوتاه‌مدت می‌گیرد که او را به صفحه‌ی تأیید ایمیل متصل می‌کند (نه نشست).
 * H-03: کوکی یک «رازِ گره» (binding) هم دارد؛ ثبت‌نام در انتظار (رمز تازه) فقط با همین راز اعمال می‌شود.
 * قالب: id.exp.binding.sig
 */
export async function createPendingVerify(userId: number, passwordHash: string, binding: string = crypto.randomBytes(16).toString("hex")) {
  const exp = Math.floor(Date.now() / 1000) + VERIFY_COOKIE_TTL;
  const payload = `${userId}.${exp}.${binding}`;
  const jar = await cookies();
  // امضا به نسخه‌ی رمز گره خورده است: اگر کسی پس از ثبت‌نام، رمز حساب تأییدنشده را عوض کند، این کوکی باطل می‌شود
  jar.set(VERIFY_COOKIE, `${payload}.${mac(`ev:${payload}.${pv(passwordHash)}`)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: await isSecureRequest(),
    path: "/",
    maxAge: VERIFY_COOKIE_TTL,
  });
  return binding;
}

export async function readPendingVerifyState(): Promise<{ user: SessionUser; binding: string } | null> {
  const jar = await cookies();
  const raw = jar.get(VERIFY_COOKIE)?.value;
  if (!raw) return null;
  const [id, exp, binding, sig] = raw.split(".");
  if (!id || !exp || !binding || !sig || !/^\d+$/.test(id) || !/^\d+$/.test(exp) || !/^[a-f0-9]{32}$/.test(binding)) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  const [user] = await db.select().from(users).where(eq(users.id, Number(id)));
  if (!user) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(mac(`ev:${id}.${exp}.${binding}.${pv(user.passwordHash)}`));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { user, binding };
}

export async function readPendingVerify(): Promise<SessionUser | null> {
  return (await readPendingVerifyState())?.user ?? null;
}

export async function clearPendingVerify() {
  (await cookies()).delete(VERIFY_COOKIE);
}
