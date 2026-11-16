import { and, eq, gte, sql } from "drizzle-orm";
import { db, lockScope, withScopeMutex, withTransaction } from "@/db";
import { aiGenerations } from "@/db/schema";
import { getPlan } from "@/modules/billing/service";
import { onShutdown, waitUntil } from "@/lib/shutdown";
import { redactPii } from "@/modules/ai/knowledge/text/redact";
import { scrubSecrets } from "@/lib/scrub";
import { AI_RESERVATION_TTL_MS, AI_STATUS_RESERVED, aiCountedCondition } from "./quota-status";

/**
 * MX-03 — سهمیه‌ی روزانه‌ی هوش مصنوعی به‌صورت «رزرو اتمی».
 *
 * مشکل قبلی: «شمارش مصرف ← تماس با سرویس بیرونی (تا ۱۱۰ ثانیه) ← ثبت ردیف» (بخوان‌-بعد-بنویس). همه‌ی درخواست‌های هم‌زمان
 * «۷ از ۸» می‌دیدند و همگی تماس (= هزینه‌ی API روی حساب پلتفرم) می‌گرفتند؛ ردیف مصرف فقط «پس از» پاسخ ثبت می‌شد.
 *
 * راه‌حل: پیش از هر تماس بیرونی، زیر قفل سریال‌کننده‌ی فضای کاری، «شمارش + درج ردیف reserved» در یک تراکنش کوتاه انجام می‌شود.
 *  - ردیف reserved همان لحظه در شمارش سقف حساب می‌شود ⇒ حداکثر `سقف` تماس هم‌زمان/متوالی در ۲۴ ساعت، حتی با هزار درخواست موازی.
 *  - پس از تماس: `settleAiQuota` ردیف را به ok (مصرف قطعی + توکن) یا failed (خطای سرویس ⇒ سهمیه‌ی کاربر برمی‌گردد) تبدیل می‌کند.
 * قفل فقط حین «شمارش+درج» نگه داشته می‌شود (میلی‌ثانیه)، نه حین تماس شبکه‌ای.
 *
 * R-02 (خاموشی/کرش): اگر پروسه وسط تماس بمیرد، ردیف reserved دیگر ۲۴ ساعت سهمیه‌ی مشتری را نمی‌سوزاند:
 *  ۱) هنگام SIGTERM، رزروهای «همین پروسه» که هنوز تسویه نشده‌اند تا مهلت‌ِ تخلیه صبر می‌کنند و سپس `failed` می‌شوند؛
 *  ۲) برای SIGKILL/OOM/قطع برق، رزروِ قدیمی‌تر از `AI_RESERVATION_TTL_MS` (۱۰ دقیقه؛ بیش از طولانی‌ترین تماس ۱۱۰ ثانیه‌ای)
 *     در هیچ شمارشی حساب نمی‌شود و `reapStaleAiReservations` آن را (برای پاکیزگی داده) به failed می‌برد.
 */
export type AiQuotaReservation = { ok: true; id: number; used: number; limit: number } | { ok: false; used: number; limit: number; resetAt: Date | null };

const WINDOW_MS = 24 * 3600_000;

/** D-06: متن دستور کاربر فقط برای نمایش مصرف نگه داشته می‌شود؛ داده‌ی حساس داخلش پیش از ذخیره حذف می‌شود */
const storedPrompt = (p: string): string => redactPii(p).text.slice(0, 490);

/** رزروهای باز همین پروسه (شناسه‌ی ردیف) — برای آزادسازی هنگام خاموشی */
type Holder = typeof globalThis & { __emzAiOpen?: Set<number> };
const openReservations = (): Set<number> => ((globalThis as Holder).__emzAiOpen ??= new Set<number>());

export async function reserveAiQuota(p: { workspaceId: number; userId: number; kind: string; prompt: string; model: string }): Promise<AiQuotaReservation> {
  const limit = (await getPlan(p.workspaceId)).aiPerDay;
  // P-04: صف هم‌زمانی «پیش از گرفتن اتصال» (بدون مصرف استخر)، سپس قفل مشورتی برای هم‌زمانی بین پروسه‌ها
  const out = await withScopeMutex("ai-quota", p.workspaceId, () =>
    withTransaction(async () => {
      await lockScope("ai-quota", p.workspaceId);
      const counted = and(eq(aiGenerations.workspaceId, p.workspaceId), aiCountedCondition(), gte(aiGenerations.createdAt, new Date(Date.now() - WINDOW_MS)));
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(aiGenerations).where(counted);
      const used = row?.n ?? 0;
      if (used >= limit) {
        // AI-07: ردیف «(used − limit + 1)ام» که از پنجره خارج می‌شود لازم است، نه همیشه قدیمی‌ترین؛
        // وقتی سقف طرح کم شده (used > limit) آزادشدن یک سهمیه هنوز اجازه‌ی تماس نمی‌دهد و پیام قبلی «زود» می‌گفت.
        // ردیف reserved بعد از TTL (۱۰ دقیقه) شمرده نمی‌شود، پس انقضای مؤثر آن created+TTL است.
        const exp = sql<Date>`case when ${aiGenerations.status} = ${AI_STATUS_RESERVED} then ${aiGenerations.createdAt} + (${AI_RESERVATION_TTL_MS} * interval '1 millisecond') else ${aiGenerations.createdAt} + (${WINDOW_MS} * interval '1 millisecond') end`;
        const [nth] = await db.select({ at: exp }).from(aiGenerations).where(counted).orderBy(exp).limit(1).offset(Math.max(0, used - limit));
        const at = nth?.at ? new Date(nth.at) : null;
        return { ok: false as const, used, limit, resetAt: at && !Number.isNaN(at.getTime()) ? at : null };
      }
      const [ins] = await db
        .insert(aiGenerations)
        .values({ workspaceId: p.workspaceId, userId: p.userId, kind: p.kind, prompt: storedPrompt(p.prompt), model: p.model, status: AI_STATUS_RESERVED })
        .returning({ id: aiGenerations.id });
      return { ok: true as const, id: ins.id, used: used + 1, limit };
    }),
  );
  if (out.ok) openReservations().add(out.id);
  return out;
}

/** تبدیل رزرو به نتیجه‌ی قطعی؛ idempotent (فقط ردیف هنوز-reserved را تغییر می‌دهد) */
export async function settleAiQuota(id: number, r: { status: "ok" | "failed"; error?: string | null; tokens?: number; prompt?: string }): Promise<void> {
  await db
    .update(aiGenerations)
    .set({ status: r.status, error: r.error ? scrubSecrets(r.error, [], 500) : null, tokens: r.tokens ?? 0, ...(r.prompt !== undefined ? { prompt: storedPrompt(r.prompt) } : {}) })
    .where(and(eq(aiGenerations.id, id), eq(aiGenerations.status, AI_STATUS_RESERVED)));
  // فقط پس از موفقیت نوشتن؛ اگر دیتابیس خطا داد، رزرو «باز» می‌ماند تا قلاب خاموشی دوباره تلاش کند
  openReservations().delete(id);
}

/** آزادسازی رزرو هنگام خطای پیش‌بینی‌نشده (سهمیه‌ی کاربر نمی‌سوزد) */
export const releaseAiQuota = (id: number, error: string) => settleAiQuota(id, { status: "failed", error: error.slice(0, 300) }).catch(() => undefined);

/** تعداد رزروهای باز همین پروسه (برای پایش/آزمون) */
export const openAiReservationCount = (): number => openReservations().size;

/**
 * R-02: رزروهای یتیم (پروسه‌ی صاحبشان مرده) را به failed می‌برد تا سهمیه‌ی مشتری برگردد.
 * امن است: هیچ تماس مجازی بیش از ۱۱۰ ثانیه طول نمی‌کشد، پس TTL ده‌دقیقه‌ای فقط رزروهای مُرده را می‌گیرد.
 */
export async function reapStaleAiReservations(now = Date.now()): Promise<number> {
  const res = await db.execute(sql`
    update ai_generations set status = 'failed', error = 'orphaned: پروسه‌ی سرور هنگام تماس متوقف شد؛ سهمیه برگردانده شد'
     where status = ${AI_STATUS_RESERVED} and created_at <= ${new Date(now - AI_RESERVATION_TTL_MS)}
    returning id`);
  return res.rows.length;
}

onShutdown(
  "ai-quota",
  async (ctx) => {
    const drained = await waitUntil(() => openReservations().size === 0, ctx.drainDeadline);
    if (drained) return;
    const ids = [...openReservations()];
    for (const id of ids) await releaseAiQuota(id, "shutdown: سرور هنگام تماس خاموش شد؛ سهمیه برگردانده شد");
    console.warn(`[shutdown:ai-quota] ${ids.length} رزرو نیمه‌تمام آزاد شد (سهمیه‌ی مشتریان نسوخت)`);
  },
  20,
);
