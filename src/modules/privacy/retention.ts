import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { encryptSecret } from "@/lib/crypto";
import { envInt } from "@/lib/semaphore";

/**
 * سیاست نگهداری و پاک‌سازی داده‌ی شخصی (D-02، D-03 و موارد هم‌خانواده).
 *
 * اصل طراحی: «کمترین نگهداری که منطق امنیتی و ادله‌ی حقوقی را نمی‌شکند».
 *  - همه‌ی مدت‌ها با متغیر محیطی قابل‌تنظیم‌اند (پیش‌فرض‌ها پایین).
 *  - هر مرحله دسته‌ای (LIMIT) و idempotent است؛ بر پایه‌ی ایندکس زمانی اجرا می‌شود (نه اسکن کامل) و با اجرای هم‌زمان چند پروسه امن است.
 *  - مراحل مستقل‌اند: شکست یکی بقیه را متوقف نمی‌کند و جدا از `runAutomation` اجرا می‌شود (پیش‌تر پاک‌سازی OTP پشت چند مرحله‌ی دیگر
 *    بود و با خطای هر کدام از آن‌ها اجرا نمی‌شد).
 */
export interface RetentionPolicy {
  /** کد OTP امضا: هش کد پس از این مدت از همه‌ی ردیف‌ها پاک می‌شود (ساعت) */
  otpCodeHours: number;
  /** شمارنده‌ی تلاش‌های ناموفق (برای سقف «کل عمر» امضاکننده) تا این مدت می‌ماند، سپس ردیف حذف می‌شود (روز) */
  otpAttemptDays: number;
  /** ردیف‌های تأیید موبایل (ارسال سریع/فرم عمومی) و توکن‌های بازیابی رمز/اتصال (روز) */
  tokenDays: number;
  /** رویدادهای ممیزی بدون قرارداد (ورود، تنظیمات، …) کاملاً حذف می‌شوند (روز) */
  auditDays: number;
  /** IP و User-Agent رویدادهای کم‌ارزش قرارداد (مشاهده، ارسال کد، …) ناشناس می‌شود؛ رویدادهای ادله‌ای (امضا/تکمیل) دست‌نخورده‌اند (روز) */
  auditPiiDays: number;
  /** سابقه‌ی تحویل وب‌هوک (موفق/مرده) و بدنه‌ی رویدادهای مرده (روز) */
  webhookLogDays: number;
  /** متن دستور کاربر در جدول مصرف هوش مصنوعی (روز) */
  aiPromptDays: number;
}

export function retentionPolicy(): RetentionPolicy {
  return {
    otpCodeHours: envInt("OTP_RETENTION_HOURS", 24, 1, 24 * 30),
    otpAttemptDays: envInt("OTP_ATTEMPT_RETENTION_DAYS", 365, 30, 3650),
    tokenDays: envInt("TOKEN_RETENTION_DAYS", 7, 1, 365),
    auditDays: envInt("AUDIT_RETENTION_DAYS", 365, 30, 3650),
    auditPiiDays: envInt("AUDIT_PII_DAYS", 365, 30, 3650),
    webhookLogDays: envInt("WEBHOOK_LOG_RETENTION_DAYS", 30, 1, 365),
    aiPromptDays: envInt("AI_PROMPT_RETENTION_DAYS", 30, 1, 365),
  };
}

/** رویدادهای ادله‌ای که IP/UA آن‌ها هرگز ناشناس نمی‌شود (سابقه‌ی حقوقی امضا و سند) */
export const AUDIT_EVIDENCE_ACTIONS = [
  "contract.signed", "contract.completed", "contract.issued", "contract.published", "contract.rejected", "contract.cancelled",
  "otp.verified", "document.finalized", "document.failed", "collect.submitted", "collect.voided", "contract.deleted",
];

async function countOf(q: SQL): Promise<number> {
  const r = await db.execute(q);
  return Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0);
}

/** اجرای دسته‌ای یک دستور (که تعداد ردیف‌های دست‌خورده را برمی‌گرداند) تا تمام‌شدن کار یا سقف دسته‌ها */
async function batched(step: (limit: number) => SQL, batch = 5000, maxBatches = 20): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await countOf(step(batch));
    total += n;
    if (n < batch) break;
  }
  return total;
}

export interface RetentionReport {
  otpCodeScrubbed: number;
  otpRowsDeleted: number;
  tokensDeleted: number;
  auditDeleted: number;
  auditAnonymized: number;
  webhookDeleted: number;
  webhookPayloadsCleared: number;
  aiPromptsCleared: number;
  secretsSealed: number;
  errors: string[];
}

export async function runRetention(policy: RetentionPolicy = retentionPolicy()): Promise<RetentionReport> {
  const rep: RetentionReport = { otpCodeScrubbed: 0, otpRowsDeleted: 0, tokensDeleted: 0, auditDeleted: 0, auditAnonymized: 0, webhookDeleted: 0, webhookPayloadsCleared: 0, aiPromptsCleared: 0, secretsSealed: 0, errors: [] };
  const step = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      rep.errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
      console.error(`[retention:${label}]`, e instanceof Error ? e.message : e);
    }
  };

  // ── D-02: OTP امضا ──
  await step("otp-scrub", async () => {
    // هش کد ۶‌رقمی با brute-force آفلاین قابل‌شکستن است ⇒ پس از مدت کوتاه از همه‌ی ردیف‌ها پاک می‌شود. ردیف خودش برای
    // «سقف تلاش ناموفق در کل عمر» (verifyOtp) می‌ماند، وگرنه پاک‌سازی بی‌صدا ضدحمله‌ی brute-force را ضعیف می‌کرد.
    rep.otpCodeScrubbed = await batched((n) => sql`
      with x as (update otp_codes set code_hash = ''
                  where id in (select id from otp_codes where created_at < now() - (${policy.otpCodeHours}::int * interval '1 hour') and code_hash <> '' limit ${n})
                  returning 1) select count(*)::int as n from x`);
  });
  await step("otp-delete", async () => {
    // ردیفِ بدون هیچ تلاش ناموفق اطلاعاتی برای سقف ندارد ⇒ همراه هش حذف می‌شود؛ ردیف دارای تلاش پس از otpAttemptDays
    rep.otpRowsDeleted = await batched((n) => sql`
      with x as (delete from otp_codes
                  where id in (select id from otp_codes
                                where (attempts = 0 and created_at < now() - (${policy.otpCodeHours}::int * interval '1 hour'))
                                   or created_at < now() - (${policy.otpAttemptDays}::int * interval '1 day') limit ${n})
                  returning 1) select count(*)::int as n from x`);
  });

  // ── توکن‌های کوتاه‌عمر (تأیید موبایل، بازیابی رمز، اتصال) ──
  await step("tokens", async () => {
    rep.tokensDeleted += await batched((n) => sql`
      with x as (delete from mobile_verifications where id in (select id from mobile_verifications where created_at < now() - (${policy.tokenDays}::int * interval '1 day') limit ${n}) returning 1) select count(*)::int as n from x`);
    rep.tokensDeleted += await batched((n) => sql`
      with x as (delete from password_resets where id in (select id from password_resets where expires_at < now() - (${policy.tokenDays}::int * interval '1 day') limit ${n}) returning 1) select count(*)::int as n from x`);
    rep.tokensDeleted += await batched((n) => sql`
      with x as (delete from connect_tokens where id in (select id from connect_tokens where expires_at < now() - (${policy.tokenDays}::int * interval '1 day') limit ${n}) returning 1) select count(*)::int as n from x`);
  });

  // ── D-03: لاگ ممیزی ──
  await step("audit-delete", async () => {
    rep.auditDeleted = await batched((n) => sql`
      with x as (delete from audit_logs where id in (select id from audit_logs where contract_id is null and created_at < now() - (${policy.auditDays}::int * interval '1 day') limit ${n}) returning 1) select count(*)::int as n from x`);
  });
  await step("audit-anonymize", async () => {
    // IPv4 → /24 (a.b.c.0)، IPv6 → /48 (سه بخش اول)؛ User-Agent پاک می‌شود. فقط رویدادهای غیرادله‌ای.
    const evidence = sql.join(AUDIT_EVIDENCE_ACTIONS.map((a) => sql`${a}`), sql`, `);
    rep.auditAnonymized = await batched((n) => sql`
      with x as (
        update audit_logs set
          ip = case when ip ~ '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$' then regexp_replace(ip, '\\.[0-9]+$', '.0')
                    when ip like '%:%' then split_part(ip, ':', 1) || ':' || split_part(ip, ':', 2) || ':' || split_part(ip, ':', 3) || '::'
                    else ip end,
          user_agent = ''
         where id in (select id from audit_logs
                       where created_at < now() - (${policy.auditPiiDays}::int * interval '1 day')
                         and action not in (${evidence})
                         and ip ~ '^[0-9a-fA-F.:]+$' and ip ~ '[.:]'
                         and (coalesce(user_agent, '') <> '' or ip !~ '(\\.0|::)$')
                       limit ${n})
        returning 1) select count(*)::int as n from x`);
  });

  // ── وب‌هوک و هوش مصنوعی ──
  await step("webhook-log", async () => {
    rep.webhookDeleted = await batched((n) => sql`
      with x as (delete from webhook_deliveries where id in (select id from webhook_deliveries where status in ('ok','dead') and created_at < now() - (${policy.webhookLogDays}::int * interval '1 day') limit ${n}) returning 1) select count(*)::int as n from x`);
  });
  await step("ai-prompts", async () => {
    rep.aiPromptsCleared = await batched((n) => sql`
      with x as (update ai_generations set prompt = '' where id in (select id from ai_generations where created_at < now() - (${policy.aiPromptDays}::int * interval '1 day') and prompt <> '' limit ${n}) returning 1) select count(*)::int as n from x`);
  });

  // ── D-01: رازهای قدیمیِ متن‌ساده را رمز می‌کند ──
  await step("seal-legacy", async () => {
    rep.secretsSealed = await sealLegacySecrets();
  });
  return rep;
}

/** رازهای متن‌سادهٔ به‌جامانده از نسخه‌های پیش از D-01 (مقصد وب‌هوک: توکن ربات/کلید HMAC) را رمز می‌کند؛ idempotent */
export async function sealLegacySecrets(limit = 500): Promise<number> {
  const rows = await db.execute(sql`select id, secret from webhook_endpoints where secret <> '' and secret not like 'enc:v1:%' order by id limit ${limit}`);
  let n = 0;
  for (const r of rows.rows as { id: number; secret: string }[]) {
    await db.execute(sql`update webhook_endpoints set secret = ${encryptSecret(r.secret)} where id = ${r.id} and secret = ${r.secret}`);
    n++;
  }
  return n;
}

type Holder = typeof globalThis & { __emzRetentionAt?: number; __emzRetentionRun?: Promise<RetentionReport> };
/** حداکثر یک‌بار در ساعت (و تک‌پروازی در همین پروسه)؛ از تیک زمان‌بند صدا زده می‌شود */
export async function runRetentionIfDue(everyMs = 3600_000, now = Date.now()): Promise<RetentionReport | null> {
  const g = globalThis as Holder;
  if (g.__emzRetentionRun) return g.__emzRetentionRun;
  if (now - (g.__emzRetentionAt ?? 0) < everyMs) return null;
  g.__emzRetentionAt = now;
  const p = runRetention().finally(() => {
    g.__emzRetentionRun = undefined;
  });
  g.__emzRetentionRun = p;
  return p;
}
