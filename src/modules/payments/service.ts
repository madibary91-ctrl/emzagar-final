import crypto from "node:crypto";
import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { payments } from "@/db/schema";
import { logAudit } from "@/modules/audit/service";
import { activateSubscription, type SubscriptionExecutor } from "@/modules/billing/subscription";
import { getPlanById } from "@/modules/billing/catalog";
import { notifyTeam } from "@/modules/inbox/service";
import { creditToman } from "@/modules/wallet/service";
import { candidateOrder, credentialFor, getAdapter, recordGatewayResult } from "./registry";
import { contractCandidateOrder, contractCredential } from "./workspace";
import { applyContractPayment } from "@/modules/contract-pay/fulfill";
import { REAL_GATEWAY_IDS, authorityKey, tokenFromAuthority, type GatewayId } from "./types";

export type PaymentKind = "subscription" | "topup" | "contract";

/** نشانه‌ی تراکنشی که کاربر پرداخت کرده ولی تایید آن به‌خاطر قطعی موقت درگاه ممکن نشد (زمان‌بند دوباره تلاش می‌کند) */
const VERIFY_PENDING = "verify_pending";

export type StartPaymentInput = {
  kind: PaymentKind;
  workspaceId: number;
  userId: number;
  /** فقط برای اشتراک */
  plan?: string;
  months?: number;
  /** مبلغ به تومان؛ همیشه سمت سرور محاسبه/اعتبارسنجی می‌شود */
  amountToman: number;
  origin: string;
  /** درگاه انتخابی کاربر (اختیاری)؛ در صورت خطا خودکار به درگاه بعدی می‌رود */
  gateway?: string;
  description: string;
  mobile?: string;
};

/**
 * ساخت تراکنش و برگرداندن آدرس هدایت به درگاه.
 * Failover: اگر درگاه انتخابی پاسخ ندهد یا درخواست را نپذیرد، همان تراکنش با درگاه بعدیِ سالم دوباره تلاش می‌شود
 * و کاربر بدون اطلاع از مشکل به درگاه دیگر هدایت می‌شود. فقط اگر همه‌ی درگاه‌ها شکست بخورند خطا می‌دهد.
 */
export async function startPayment(p: StartPaymentInput): Promise<string> {
  if (!Number.isInteger(p.amountToman) || p.amountToman < 1000) throw new Error("مبلغ نامعتبر است");
  // پرداخت قرارداد: مرچنت اختصاصی فضای کاری (در صورت ثبت) و در غیر این صورت درگاه‌های پلتفرم
  const order = p.kind === "contract" ? await contractCandidateOrder(p.workspaceId, p.gateway) : await candidateOrder(p.gateway);
  if (order.length === 0) throw new Error("درگاه پرداخت هنوز پیکربندی نشده است. با پشتیبانی تماس بگیرید.");
  if (!p.origin) throw new Error("آدرس سایت (APP_URL) تنظیم نشده است");

  const [row] = await db
    .insert(payments)
    .values({ workspaceId: p.workspaceId, userId: p.userId, plan: p.kind === "topup" ? "wallet" : p.plan || "", months: p.months ?? 1, amount: p.amountToman, kind: p.kind, gateway: order[0], authority: `pending:${crypto.randomBytes(12).toString("hex")}` })
    .returning({ id: payments.id });

  let firstError = "";
  for (const gw of order) {
    const adapter = getAdapter(gw)!;
    const credValue = p.kind === "contract" ? await contractCredential(p.workspaceId, gw, async () => (await credentialFor(gw)).value) : (await credentialFor(gw)).value;
    const res = await adapter.init(credValue, {
      amountToman: p.amountToman,
      amountRial: p.amountToman * 10,
      callbackUrl: `${p.origin}/api/billing/callback/${gw}`,
      description: p.description,
      orderId: String(row.id),
      mobile: p.mobile,
    });
    if (res.ok) {
      recordGatewayResult(gw, true);
      await db.update(payments).set({ gateway: gw, authority: authorityKey(gw, res.token), test: !!res.testMode }).where(eq(payments.id, row.id));
      if (gw !== order[0]) await logAudit({ action: "billing.failover", workspaceId: p.workspaceId, userId: p.userId, detail: `${order[0]} → ${gw}` });
      return res.redirectUrl;
    }
    // فقط خطاهای «قطعی/تایم‌اوت» به شمارنده‌ی سلامت اضافه می‌شوند (رد صریح درگاه، قطعی آن نیست)
    if (res.transient) recordGatewayResult(gw, false, res.error);
    if (!firstError) firstError = res.transient ? `درگاه پرداخت پاسخ نداد (${res.error}). چند دقیقه بعد دوباره تلاش کنید.` : `درگاه پرداخت درخواست را نپذیرفت (${res.error})`;
  }
  // هیچ درگاهی پاسخ نداد: پولی جابه‌جا نشده؛ ردیف موقت حذف می‌شود
  await db.delete(payments).where(eq(payments.id, row.id));
  throw new Error(firstError + (order.length > 1 ? " (درگاه‌های جایگزین هم در دسترس نبودند)" : ""));
}

export type VerifyResult = { ok: boolean; workspaceId?: number; kind?: PaymentKind; message: string; /** مسیر بازگشت کاربر (فقط پرداخت قرارداد) */ returnPath?: string };

type PaymentRow = typeof payments.$inferSelect;

/**
 * اعمال اثر پرداخت (فعال‌سازی اشتراک / شارژ کیف پول) **داخل تراکنشِ دیتابیسِ فراخواننده**.
 *
 * اتمی و ایدمپوتنت: «علامت اعمال» (payments.fulfilled_at) در همین تراکنش و هم‌زمان با خودِ اثر نوشته می‌شود؛
 * پس یا همه‌ی آن‌ها ثبت می‌شوند یا هیچ‌کدام (کرش وسط کار = rollback کامل)، و اجرای دوباره‌ی همان پرداخت هیچ اثری ندارد.
 * هر خطایی پرتاب می‌شود تا تراکنش برگردد؛ هیچ اثر جانبی غیردیتابیسی (اعلان، لاگ) در اینجا انجام نمی‌شود.
 */
async function applyPaymentEffects(tx: SubscriptionExecutor, pay: PaymentRow, refId: string): Promise<{ applied: boolean }> {
  if (pay.kind === "contract") return applyContractPayment(tx, pay, refId);
  if (pay.kind === "topup") {
    const claimed = await tx
      .update(payments)
      .set({ fulfilledAt: new Date() })
      .where(and(eq(payments.id, pay.id), isNull(payments.fulfilledAt)))
      .returning({ id: payments.id });
    if (claimed.length === 0) return { applied: false };
    const r = await creditToman(pay.workspaceId, pay.amount, { kind: "topup", ref: `topup:${pay.id}`, description: `شارژ از درگاه — کد پیگیری ${refId}`, userId: pay.userId, exec: tx });
    // «duplicate»: دفتر کل پیش‌تر همین پرداخت را ثبت کرده (مثلاً اعمال نیمه‌کاره‌ی نسخه‌ی قدیمی) و موجودی دوباره شارژ نمی‌شود؛ فقط علامت اعمال کامل می‌شود
    if (!r.ok && r.reason !== "duplicate") throw new Error(`wallet_credit_failed:${r.reason}`);
    return { applied: r.ok };
  }
  // اعتبار طرح (وجود در کاتالوگ و غیرپایه‌بودن) را خودِ activateSubscription زیر قفل بررسی می‌کند؛ طرح بایگانی‌شده‌ی پرداخت‌شده هم فعال می‌شود
  const r = await activateSubscription(pay.workspaceId, pay.plan, pay.months, { exec: tx, paymentId: pay.id });
  return { applied: r.applied };
}

/** اثرهای جانبیِ پس از commit (لاگ و اعلان)؛ شکست آن‌ها هرگز نتیجه‌ی پرداخت را تغییر نمی‌دهد */
async function announceFulfilled(pay: PaymentRow, refId: string): Promise<string> {
  if (pay.kind === "contract") return (await import("@/modules/contract-pay/service")).announceInstallmentPaid(pay, refId);
  if (pay.kind === "topup") {
    await logAudit({ action: "wallet.topup", workspaceId: pay.workspaceId, userId: pay.userId, detail: `${pay.amount.toLocaleString("fa-IR")} تومان — ${pay.gateway} — کد پیگیری ${refId}` }).catch(() => undefined);
    await notifyTeam(pay.workspaceId, { kind: "success", title: "کیف پول شارژ شد", body: `${pay.amount.toLocaleString("fa-IR")} تومان به کیف پول افزوده شد.`, href: "/admin/wallet" }, [pay.userId], ["owner", "admin"]).catch(() => 0);
    return "کیف پول با موفقیت شارژ شد";
  }
  const planName = (await getPlanById(pay.plan).catch(() => null))?.name ?? pay.plan;
  await logAudit({ action: "billing.paid", workspaceId: pay.workspaceId, userId: pay.userId, detail: `${planName} — ${pay.months} ماه — کد پیگیری ${refId}` }).catch(() => undefined);
  return "پرداخت با موفقیت انجام و اشتراک فعال شد";
}

/**
 * ترمیم پرداخت‌های paid که اثرشان اعمال نشده (fulfilled_at خالی): داده‌ی به‌جامانده از نسخه‌های قدیمی که «paid» و «اعمال» دو مرحله‌ی جدا بودند.
 * ردیف قفل می‌شود (FOR UPDATE) و اعمال ایدمپوتنت است؛ بنابراین اجرای هم‌زمانِ چند ترمیم‌گر یا تکرار آن بی‌خطر است.
 * خروجی: ردیفی که اعمال شد، یا null اگر چیزی برای اعمال نبود.
 */
async function recoverPaidPayment(paymentId: number): Promise<PaymentRow | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
    if (!row || row.status !== "paid" || row.fulfilledAt || row.gateway === "wallet") return null;
    const r = await applyPaymentEffects(tx, row, row.refId || String(row.id));
    return r.applied ? row : null;
  });
}

/**
 * تایید بازگشت از درگاه؛ idempotent است (بازگشت دوباره، اشتراک را دوبار تمدید یا کیف پول را دوبار شارژ نمی‌کند).
 * `status` فقط "OK" یا غیر آن است؛ آداپتور هر درگاه پارامترهای خودش را به این مقدار تبدیل می‌کند.
 */
export async function verifyPayment(authority: string, status: string): Promise<VerifyResult> {
  if (!/^[A-Za-z0-9:_-]{10,100}$/.test(authority) || authority.startsWith("pending:")) return { ok: false, message: "شناسه‌ی تراکنش نامعتبر است" };
  const [pay] = await db.select().from(payments).where(eq(payments.authority, authority));
  if (!pay) return { ok: false, message: "تراکنش یافت نشد" };
  const kind: PaymentKind = pay.kind === "topup" ? "topup" : pay.kind === "contract" ? "contract" : "subscription";
  const base = { workspaceId: pay.workspaceId, kind, ...(kind === "contract" ? { returnPath: await (await import("@/modules/contract-pay/service")).returnPathFor(pay.plan) } : {}) };
  if (pay.status === "paid") {
    // paid ولی اثرش اعمال نشده (داده‌ی نسخه‌های قدیمی): همین‌جا ترمیم می‌شود، نه اینکه بی‌صدا «تایید شده» گزارش شود
    if (!pay.fulfilledAt && pay.gateway !== "wallet") {
      try {
        const rec = await recoverPaidPayment(pay.id);
        if (rec) return { ok: true, ...base, message: await announceFulfilled(rec, rec.refId || String(rec.id)) };
      } catch {
        return { ok: false, ...base, message: "پرداخت دریافت شد ولی اعمال آن با تاخیر انجام می‌شود؛ چند دقیقه بعد بررسی کنید." };
      }
    }
    return { ok: true, ...base, message: "این پرداخت قبلاً تایید شده است" };
  }
  // تراکنشِ قبلاً ناموفق/لغوشده با بازگشت دوباره (Status=OK جعلی یا تکراری) هرگز زنده نمی‌شود
  if (pay.status === "failed") return { ok: false, ...base, message: "این تراکنش قبلاً ناموفق ثبت شده است؛ پرداخت جدیدی آغاز کنید" };
  const adapter = pay.gateway === "wallet" ? null : getAdapter(pay.gateway);
  if (!adapter) return { ok: false, ...base, message: "درگاه تراکنش نامعتبر است" };

  const fail = async (why: string): Promise<VerifyResult> => {
    await db.update(payments).set({ status: "failed", error: why.slice(0, 300) }).where(and(eq(payments.id, pay.id), eq(payments.status, "pending")));
    return { ok: false, ...base, message: why };
  };

  if (status !== "OK") return fail("پرداخت توسط شما لغو شد یا ناموفق بود");

  const credValue = pay.kind === "contract" ? await contractCredential(pay.workspaceId, adapter.id, async () => (await credentialFor(adapter.id)).value) : (await credentialFor(adapter.id)).value;
  const out = await adapter.verify(credValue, { token: tokenFromAuthority(pay.gateway, authority), orderId: String(pay.id), amountRial: pay.amount * 10 });
  if (out.state === "failed") return fail(out.error);
  if (out.state === "unknown") {
    // قطعی شبکه/5xx/پاسخ نامعتبر: تراکنش pending می‌ماند و بعداً دوباره بررسی می‌شود (وگرنه کاربری که پولش کسر شده «ناموفق» ثبت می‌شد)
    recordGatewayResult(pay.gateway, false, out.error);
    await db.update(payments).set({ error: `${VERIFY_PENDING}: ${out.error}`.slice(0, 300) }).where(and(eq(payments.id, pay.id), eq(payments.status, "pending")));
    return { ok: false, ...base, message: "تایید پرداخت با درگاه هنوز ممکن نشد؛ تراکنش شما در حال بررسی است. اگر مبلغ از حساب شما کسر شده، تا چند دقیقه‌ی دیگر به‌طور خودکار اعمال می‌شود." };
  }
  recordGatewayResult(pay.gateway, true);
  // مبلغ تاییدشده‌ی درگاه باید دقیقاً با مبلغ سفارش یکی باشد
  if (out.amountRial !== undefined && out.amountRial !== pay.amount * 10) return fail("مبلغ پرداخت‌شده با مبلغ سفارش مطابقت ندارد؛ با پشتیبانی تماس بگیرید");

  // «paid شدن» و «اعمال اثر» در **یک تراکنش دیتابیس** انجام می‌شوند:
  //  - فقط اولین درخواست موفق ردیف را از pending به paid می‌برد (درخواست‌های هم‌زمان پشت قفل ردیف منتظر می‌مانند)؛
  //  - اگر اعمال اثر شکست بخورد یا پروسه وسط کار بمیرد، کل تراکنش (از جمله وضعیت paid) برمی‌گردد و ردیف pending می‌ماند؛
  //    پس هرگز «paid بدون اثر» ساخته نمی‌شود و زمان‌بند دوباره تایید و اعمال می‌کند.
  let outcome: { applied: boolean } | null;
  try {
    outcome = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(payments)
        .set({ status: "paid", refId: out.refId, paidAt: new Date(), error: null })
        .where(and(eq(payments.id, pay.id), eq(payments.status, "pending")))
        .returning({ id: payments.id });
      if (claimed.length === 0) return null;
      return applyPaymentEffects(tx, pay, out.refId);
    });
  } catch {
    // خطای موقت دیتابیس/اعمال: تراکنش برگشته و ردیف pending است؛ علامت می‌گذاریم تا زمان‌بند دوباره تایید و اعمال کند (اعمال ایدمپوتنت است)
    await db.update(payments).set({ error: `${VERIFY_PENDING}: fulfillment` }).where(and(eq(payments.id, pay.id), eq(payments.status, "pending"))).catch(() => undefined);
    return { ok: false, ...base, message: "پرداخت دریافت شد ولی اعمال آن با تاخیر انجام می‌شود؛ چند دقیقه بعد بررسی کنید." };
  }
  if (outcome === null) {
    const [now] = await db.select({ status: payments.status }).from(payments).where(eq(payments.id, pay.id));
    return now?.status === "paid" ? { ok: true, ...base, message: "این پرداخت قبلاً تایید شده است" } : { ok: false, ...base, message: "وضعیت تراکنش نامعتبر است" };
  }
  return { ok: true, ...base, message: await announceFulfilled(pay, out.refId) };
}

/**
 * بازبینی تراکنش‌های پرداخت:
 *  ۱) pending های معلقِ قطعی درگاه (تا ۴۸ ساعت): دوباره با درگاه تایید و (اتمی) اعمال می‌شوند؛
 *  ۲) paid هایی که اثرشان اعمال نشده (fulfilled_at خالی؛ باقیمانده‌ی نسخه‌های قدیمی): بدون سقف زمانی ترمیم می‌شوند، چون پولشان گرفته شده است.
 */
export async function reconcilePendingPayments(limit = 20): Promise<{ checked: number; paid: number; recovered: number }> {
  const rows = await db
    .select({ authority: payments.authority })
    .from(payments)
    .where(and(eq(payments.status, "pending"), sql`${payments.error} like ${VERIFY_PENDING + "%"}`, gte(payments.createdAt, new Date(Date.now() - 48 * 3600_000))))
    .limit(limit);
  let paid = 0;
  for (const r of rows) {
    const res = await verifyPayment(r.authority, "OK").catch(() => null);
    if (res?.ok) paid++;
  }
  const stuck = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.status, "paid"), isNull(payments.fulfilledAt), ne(payments.gateway, "wallet")))
    .orderBy(payments.id)
    .limit(limit);
  let recovered = 0;
  for (const r of stuck) {
    const rec = await recoverPaidPayment(r.id).catch(() => null);
    if (rec) {
      recovered++;
      await announceFulfilled(rec, rec.refId || String(rec.id)).catch(() => undefined);
    }
  }
  return { checked: rows.length + stuck.length, paid, recovered };
}

/** آمار ۳۰ روز اخیر هر درگاه (برای پنل مدیر): نرخ موفقیت و مبلغ */
export async function gatewayStats() {
  const since = new Date(Date.now() - 30 * 86400_000);
  const rows = await db
    .select({
      gateway: payments.gateway,
      paid: sql<number>`count(*) filter (where ${payments.status} = 'paid')::int`,
      failed: sql<number>`count(*) filter (where ${payments.status} = 'failed')::int`,
      pending: sql<number>`count(*) filter (where ${payments.status} = 'pending')::int`,
      sum: sql<number>`coalesce(sum(${payments.amount}) filter (where ${payments.status} = 'paid' and not ${payments.test}), 0)::bigint`,
    })
    .from(payments)
    .where(gte(payments.createdAt, since))
    .groupBy(payments.gateway);
  const map = new Map(rows.map((r) => [r.gateway, { ...r, sum: Number(r.sum) }]));
  return ([...REAL_GATEWAY_IDS, "sandbox", "wallet"] as (GatewayId | "wallet")[]).map((id) => map.get(id) ?? { gateway: id, paid: 0, failed: 0, pending: 0, sum: 0 });
}
