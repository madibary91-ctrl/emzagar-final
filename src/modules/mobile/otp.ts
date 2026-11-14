import crypto from "node:crypto";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { mobileVerifications } from "@/db/schema";
import { sha256 } from "@/lib/password";
import { randomOtp } from "@/lib/otp-digits";
import { getSecret } from "@/lib/secret";
import { sendSms } from "@/modules/sms";
import { devSecretsAllowed } from "@/modules/signing/types";
import { normalizeMobile } from "@/modules/guests/service";

/**
 * تأیید مالکیت شماره‌ی موبایل (بدون حساب کاربری) برای ارسال سریع و فرم‌های عمومی.
 * پیامک ← کد ۶ رقمی ← «گواهی تأیید» (proof) امضاشده با HMAC که فقط یک‌بار قابل مصرف و ۳۰ دقیقه معتبر است.
 */
export type Purpose = "quick" | "collect" | "vault";

const TTL_MS = 5 * 60_000;
const PROOF_TTL_S = 30 * 60;
const RESEND_S = 60;
const MAX_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
const MAX_PER_IP_HOUR = 30;

const hashCode = (p: Purpose, scope: string, mobile: string, code: string) => sha256(`${getSecret()}:mv:${p}:${scope}:${mobile}:${code}`);
const mac = (payload: string) => crypto.createHmac("sha256", getSecret()).update(`mvproof:${payload}`).digest("hex");

export interface SendResult {
  ok: boolean;
  error?: string;
  seconds?: number;
  devCode?: string;
}

export async function sendMobileCode(p: { purpose: Purpose; scope: string; mobile: string; ip: string; workspaceId?: number; siteName?: string }): Promise<SendResult> {
  const mobile = normalizeMobile(p.mobile);
  if (!mobile) return { ok: false, error: "شماره‌ی موبایل معتبر نیست؛ به‌صورت 09123456789 وارد کنید" };
  const key = and(eq(mobileVerifications.purpose, p.purpose), eq(mobileVerifications.scope, p.scope), eq(mobileVerifications.mobile, mobile));
  const [last] = await db.select().from(mobileVerifications).where(key).orderBy(desc(mobileVerifications.createdAt)).limit(1);
  if (last) {
    const wait = Math.ceil(RESEND_S - (Date.now() - last.createdAt.getTime()) / 1000);
    if (wait > 0) return { ok: false, error: `برای ارسال مجدد ${wait} ثانیه صبر کنید`, seconds: wait };
  }
  const hourAgo = new Date(Date.now() - 3600_000);
  const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(mobileVerifications).where(and(key, gt(mobileVerifications.createdAt, hourAgo)));
  if ((n?.n ?? 0) >= MAX_PER_HOUR) return { ok: false, error: "حداکثر ۵ کد در ساعت برای هر شماره؛ کمی بعد دوباره تلاش کنید" };
  const [ni] = await db.select({ n: sql<number>`count(*)::int` }).from(mobileVerifications).where(and(eq(mobileVerifications.ip, p.ip), gt(mobileVerifications.createdAt, hourAgo)));
  if ((ni?.n ?? 0) >= MAX_PER_IP_HOUR) return { ok: false, error: "درخواست‌های ارسال کد از این شبکه زیاد بود؛ کمی بعد دوباره تلاش کنید" };

  const code = randomOtp(crypto.randomInt); // M-09: ۶ رقم (otp-digits.ts)
  await db.insert(mobileVerifications).values({
    purpose: p.purpose,
    scope: p.scope,
    mobile,
    codeHash: hashCode(p.purpose, p.scope, mobile, code),
    ip: p.ip.slice(0, 64),
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  const res = await sendSms({ to: mobile, token: code, text: `کد تأیید شماره‌ی موبایل${p.siteName ? ` در ${p.siteName}` : ""}: ${code}` }, null, p.workspaceId ?? 0);
  if (!res.ok && !res.testMode) return { ok: false, error: "ارسال پیامک ناموفق بود: " + (res.error ?? "") };
  return { ok: true, seconds: RESEND_S, devCode: res.testMode && devSecretsAllowed() ? code : undefined };
}

export async function verifyMobileCode(p: { purpose: Purpose; scope: string; mobile: string; code: string }): Promise<{ ok: true; proof: string } | { ok: false; error: string }> {
  const mobile = normalizeMobile(p.mobile);
  if (!mobile) return { ok: false, error: "شماره‌ی موبایل معتبر نیست" };
  const [row] = await db
    .select()
    .from(mobileVerifications)
    .where(and(eq(mobileVerifications.purpose, p.purpose), eq(mobileVerifications.scope, p.scope), eq(mobileVerifications.mobile, mobile), isNull(mobileVerifications.verifiedAt)))
    .orderBy(desc(mobileVerifications.createdAt))
    .limit(1);
  if (!row) return { ok: false, error: "ابتدا کد تأیید را دریافت کنید" };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, error: "کد منقضی شده است؛ کد جدید دریافت کنید" };
  const claimed = await db
    .update(mobileVerifications)
    .set({ attempts: sql`${mobileVerifications.attempts} + 1` })
    .where(and(eq(mobileVerifications.id, row.id), isNull(mobileVerifications.verifiedAt), lt(mobileVerifications.attempts, MAX_ATTEMPTS)))
    .returning({ id: mobileVerifications.id });
  if (claimed.length === 0) return { ok: false, error: "تعداد تلاش‌ها بیش از حد مجاز است؛ کد جدید دریافت کنید" };
  const a = Buffer.from(row.codeHash);
  const b = Buffer.from(hashCode(p.purpose, p.scope, mobile, String(p.code || "").trim().replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: "کد تأیید نادرست است" };
  const done = await db.update(mobileVerifications).set({ verifiedAt: new Date() }).where(and(eq(mobileVerifications.id, row.id), isNull(mobileVerifications.verifiedAt))).returning({ id: mobileVerifications.id });
  if (!done.length) return { ok: false, error: "این کد قبلاً استفاده شده است" };
  const exp = Math.floor(Date.now() / 1000) + PROOF_TTL_S;
  const payload = `${row.id}.${exp}`;
  return { ok: true, proof: `${payload}.${mac(`${payload}:${p.purpose}:${p.scope}:${mobile}`)}` };
}

/** گواهی تأیید را (بدون مصرف) راستی‌آزمایی می‌کند */
async function checkProofRow(proof: string, p: { purpose: Purpose; scope: string; mobile: string }) {
  const mobile = normalizeMobile(p.mobile);
  const m = /^(\d{1,12})\.(\d{9,12})\.([a-f0-9]{64})$/.exec(String(proof || ""));
  if (!mobile || !m) return null;
  const [id, exp, sig] = [Number(m[1]), Number(m[2]), m[3]];
  if (exp < Date.now() / 1000) return null;
  const want = mac(`${id}.${exp}:${p.purpose}:${p.scope}:${mobile}`);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const [row] = await db.select().from(mobileVerifications).where(eq(mobileVerifications.id, id));
  if (!row || !row.verifiedAt || row.consumedAt || row.mobile !== mobile || row.purpose !== p.purpose || row.scope !== p.scope) return null;
  return row;
}

export async function isProofValid(proof: string, p: { purpose: Purpose; scope: string; mobile: string }): Promise<boolean> {
  return !!(await checkProofRow(proof, p));
}

/** مصرف اتمی و یک‌بارمصرف؛ true فقط برای اولین فراخوانی */
export async function consumeProof(proof: string, p: { purpose: Purpose; scope: string; mobile: string }): Promise<boolean> {
  const row = await checkProofRow(proof, p);
  if (!row) return false;
  const r = await db.update(mobileVerifications).set({ consumedAt: new Date() }).where(and(eq(mobileVerifications.id, row.id), isNull(mobileVerifications.consumedAt))).returning({ id: mobileVerifications.id });
  return r.length === 1;
}

/** پاک‌سازی ردیف‌های قدیمی (کرون) */
export async function purgeOldVerifications(): Promise<void> {
  await db.delete(mobileVerifications).where(lt(mobileVerifications.createdAt, new Date(Date.now() - 2 * 86400_000)));
}
