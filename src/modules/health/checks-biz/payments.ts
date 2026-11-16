import { type CheckDef, type Metric, type Step } from "../types";
import { type RealGatewayId } from "@/modules/payments/types";
import { ageText, fa, isProd } from "../checks-core";
import { checkoutMode, credentialFor, getAdapter, listGatewayStatuses } from "@/modules/payments/registry";
import { db } from "@/db";
import { externalBase, simActive } from "@/lib/external";
import { probeUrl, tlsWarning } from "../probe";
import { sql } from "drizzle-orm";
import { trustedAppOrigin } from "@/lib/config";

/* ───────────────────────── درگاه‌های پرداخت ───────────────────────── */

const GATEWAY_PROBE: Record<RealGatewayId, () => string> = {
  zarinpal: () => externalBase("zarinpal", !simActive() && process.env.ZARINPAL_SANDBOX === "1" ? "https://sandbox.zarinpal.com" : "https://payment.zarinpal.com"),
  zibal: () => "https://gateway.zibal.ir",
  idpay: () => "https://api.idpay.ir",
  payir: () => "https://pay.ir",
};
export function gatewayCheck(id: RealGatewayId): CheckDef {
  const adapter = getAdapter(id)!;
  return {
    id: `gateway-${id}`,
    group: "payments",
    label: `درگاه ${adapter.label}`,
    weight: 0,
    deepAvailable: true,
    deepLabel: "تست اعتبار مرچنت (بدون پرداخت)",
    fixHref: "/platform/commerce",
    fixLabel: "تجارت و درگاه‌ها",
    async run(ctx, deep) {
      const all = await listGatewayStatuses();
      const st = all.find((g) => g.id === id);
      const cred = await credentialFor(id);
      const sourceLabel = { panel: "پنل (رمزنگاری‌شده)", env: "متغیر محیطی", sim: "شبیه‌ساز", none: "تنظیم نشده" }[cred.source];
      if (!cred.value) {
        return { status: "unconfigured", summary: "اعتبارنامه‌ی درگاه تنظیم نشده است", source: sourceLabel, hints: [`${adapter.credentialLabel} را در «تجارت و درگاه‌ها» یا متغیر ${adapter.envVar} وارد کنید.`] };
      }
      const metrics: Metric[] = [
        { label: "اعتبارنامه", value: `${adapter.credentialLabel} — ${sourceLabel}` },
        { label: "اولویت در انتخاب خودکار", value: st ? fa(st.priority) : "—" },
        { label: "وضعیت", value: st?.enabled ? "فعال" : "غیرفعال توسط مدیر", tone: st?.enabled ? "ok" : "warn" },
      ];
      if (st?.degraded) metrics.push({ label: "قطع‌کننده‌ی مدار (Circuit Breaker)", value: `کنار گذاشته شد؛ تلاش مجدد تا ${fa(st.retryInSec)} ثانیه — ${st.lastError || "—"}`, tone: "fail" });
      else if (st?.lastError) metrics.push({ label: "آخرین خطای درگاه", value: st.lastError, tone: "warn" });

      // آمار ۷ روز اخیر
      const rows = (await db.execute(sql`select status, count(*)::int as n from payments where gateway = ${id} and created_at > now() - interval '7 days' group by status`)).rows as { status: string; n: number }[];
      const n = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
      const finished = n("paid") + n("failed");
      if (rows.length) metrics.push({ label: "تراکنش‌های ۷ روز: موفق / ناموفق / معلق", value: `${fa(n("paid"))} / ${fa(n("failed"))} / ${fa(n("pending"))}`, tone: finished >= 5 && n("failed") / finished > 0.5 ? "warn" : "ok" });

      const probe = await probeUrl(GATEWAY_PROBE[id](), { timeoutMs: 8000 });
      const steps: Step[] = [...probe.steps];
      if (probe.tlsDaysLeft !== undefined) metrics.push({ label: "گواهی TLS درگاه", value: `${fa(probe.tlsDaysLeft)} روز تا انقضا`, tone: probe.tlsDaysLeft <= 14 ? "warn" : "ok" });
      if (!probe.ok) {
        return { status: "fail", latencyMs: probe.latencyMs, summary: `درگاه از سرور شما در دسترس نیست: ${probe.error}`, steps, metrics, source: sourceLabel, hints: ["بسیاری از درگاه‌های ایرانی IP سرورهای خارج از کشور را مسدود می‌کنند؛ سرور باید در ایران یا با IP مجاز باشد.", "فایروال خروجی و DNS سرور را بررسی کنید."] };
      }
      let latency = probe.latencyMs;
      let summary = `درگاه در دسترس است · ${fa(probe.latencyMs)} میلی‌ثانیه`;
      if (deep) {
        const origin = ctx.origin || trustedAppOrigin() || "https://example.com";
        const t0 = performance.now();
        const r = await adapter.init(cred.value, { amountToman: 1000, amountRial: 10_000, callbackUrl: `${origin}/api/billing/callback/${id}`, description: "health-check (no payment)", orderId: `health-${Date.now()}` });
        const ms = Math.round(performance.now() - t0);
        latency = ms;
        if (r.ok) {
          steps.push({ name: "درخواست پرداخت آزمایشی", ok: true, ms, detail: `توکن ساخته شد${r.testMode ? " (حالت آزمایشی)" : ""} — پرداختی انجام نشد` });
          summary = `اعتبارنامه تأیید شد · ${fa(ms)} میلی‌ثانیه${r.testMode ? " · حالت آزمایشی" : ""}`;
          if (r.testMode && isProd()) return { status: "warn", latencyMs: ms, summary: "درگاه در حالت آزمایشی (Sandbox) است", steps, metrics, source: sourceLabel, hints: ["برای دریافت پول واقعی، مرچنت/کلید واقعی را جایگزین کنید و ZARINPAL_SANDBOX / IDPAY_SANDBOX را خاموش کنید."] };
        } else {
          steps.push({ name: "درخواست پرداخت آزمایشی", ok: false, ms, detail: r.error });
          return { status: "fail", latencyMs: ms, summary: r.transient ? `پاسخ قطعی از درگاه نگرفتیم: ${r.error}` : `درگاه درخواست را رد کرد: ${r.error}`, steps, metrics, source: sourceLabel, hints: r.transient ? ["مشکل شبکه یا درگاه؛ چند دقیقه بعد دوباره تست کنید."] : ["مرچنت/کلید، فعال‌بودن درگاه و تطابق دامنه‌ی callback با دامنه‌ی ثبت‌شده در درگاه را بررسی کنید."] };
        }
      }
      if (st?.degraded) return { status: "warn", latencyMs: latency, summary: `شبکه سالم است اما درگاه موقتاً از انتخاب خودکار کنار رفته (${st.lastError || "خطاهای پشت‌سرهم"})`, steps, metrics, source: sourceLabel };
      const tw = tlsWarning(probe);
      if (tw) return { status: "warn", latencyMs: latency, summary: tw, steps, metrics, source: sourceLabel };
      if (!st?.enabled) return { status: "unconfigured", latencyMs: latency, summary: "پیکربندی کامل است اما توسط مدیر غیرفعال شده", steps, metrics, source: sourceLabel };
      return { status: "ok", latencyMs: latency, summary, steps, metrics, source: sourceLabel, hints: deep ? [] : ["برای اطمینان از اعتبار مرچنت، «تست اعتبار مرچنت» را بزنید (هیچ پرداختی انجام نمی‌شود)."] };
    },
  };
}
export const paymentFlow: CheckDef = {
  id: "payment-flow",
  group: "payments",
  label: "جریان پرداخت و تراکنش‌ها",
  weight: 3,
  fixHref: "/platform/commerce",
  fixLabel: "تجارت و درگاه‌ها",
  async run() {
    const [mode, gws] = await Promise.all([checkoutMode(), listGatewayStatuses()]);
    const usable = gws.filter((g) => g.configured && g.enabled);
    const healthy = usable.filter((g) => !g.degraded);
    const metrics: Metric[] = [
      { label: "حالت پرداخت", value: mode === "live" ? "واقعی (Live)" : mode === "demo" ? "آزمایشی (Demo)" : "غیرفعال", tone: mode === "live" ? "ok" : mode === "demo" ? "warn" : "fail" },
      { label: "درگاه‌های قابل‌استفاده", value: `${fa(usable.length)} از ${fa(gws.length)} · سالم: ${fa(healthy.length)}`, tone: healthy.length === 0 ? "fail" : healthy.length === 1 ? "warn" : "ok" },
    ];
    const stuck = ((await db.execute(sql`select count(*)::int as n, coalesce(min(created_at), now()) as oldest from payments where status = 'pending' and created_at < now() - interval '30 minutes' and created_at > now() - interval '7 days'`)).rows[0] ?? { n: 0 }) as { n: number; oldest: Date };
    metrics.push({ label: "تراکنش معلق بیش از ۳۰ دقیقه", value: fa(stuck.n), tone: stuck.n > 0 ? "warn" : "ok" });
    const day = (await db.execute(sql`select status, count(*)::int as n from payments where created_at > now() - interval '24 hours' and test = false group by status`)).rows as { status: string; n: number }[];
    const dn = (s: string) => day.find((r) => r.status === s)?.n ?? 0;
    metrics.push({ label: "۲۴ ساعت اخیر: موفق / ناموفق / معلق", value: `${fa(dn("paid"))} / ${fa(dn("failed"))} / ${fa(dn("pending"))}` });
    const rate = dn("paid") + dn("failed") ? Math.round((dn("paid") / (dn("paid") + dn("failed"))) * 100) : null;
    if (rate !== null) metrics.push({ label: "نرخ موفقیت پرداخت", value: `${fa(rate)}٪`, tone: rate < 50 ? "fail" : rate < 75 ? "warn" : "ok" });

    const hints: string[] = [];
    if (mode === "none") return { status: "fail", summary: "هیچ درگاه پرداختی فعال نیست؛ کاربران نمی‌توانند خرید کنند", metrics, hints: ["حداقل یک درگاه (مثلاً زرین‌پال) را در «تجارت و درگاه‌ها» تنظیم کنید."] };
    if (mode === "demo") return { status: "warn", summary: isProd() ? "فقط درگاه آزمایشی فعال است (پول واقعی دریافت نمی‌شود)" : "فقط درگاه آزمایشی فعال است (محیط توسعه)", metrics, hints: ["برای لانچ یک درگاه واقعی تنظیم کنید."] };
    if (healthy.length === 0) return { status: "fail", summary: "همه‌ی درگاه‌های فعال موقتاً ناسالم‌اند (Circuit Breaker)", metrics, hints: ["وضعیت هر درگاه را در کارت‌های پایین بررسی کنید."] };
    if (usable.length === 1) hints.push("فقط یک درگاه فعال دارید؛ برای Failover خودکار یک درگاه پشتیبان هم اضافه کنید.");
    if (stuck.n > 0) return { status: "warn", summary: `${fa(stuck.n)} تراکنش بیش از ۳۰ دقیقه معلق مانده (قدیمی‌ترین: ${ageText(Date.now() - new Date(stuck.oldest).getTime())})`, metrics, hints: ["زمان‌بند به‌صورت خودکار تراکنش‌های معلق را دوباره تأیید می‌کند؛ اگر ادامه یافت، درگاه را تست کنید."] };
    if (rate !== null && rate < 50 && dn("paid") + dn("failed") >= 5) return { status: "warn", summary: `نرخ موفقیت پرداخت پایین است (${fa(rate)}٪)`, metrics, hints };
    return { status: "ok", summary: `${fa(healthy.length)} درگاه واقعی سالم · پرداخت‌ها عادی`, metrics, hints };
  },
};
export const wallet: CheckDef = {
  id: "wallet",
  group: "payments",
  label: "کیف پول و دفتر کل",
  weight: 2,
  fixHref: "/platform/commerce",
  fixLabel: "تجارت و درگاه‌ها",
  async run() {
    const t0 = performance.now();
    const rows = (await db.execute(sql`
      select w.workspace_id, w.balance::bigint as balance, w.credits,
        coalesce(sum(t.amount) filter (where t.asset = 'toman'), 0)::bigint as toman_sum,
        coalesce(sum(t.amount) filter (where t.asset = 'credits'), 0)::bigint as credit_sum
      from wallets w left join wallet_transactions t on t.workspace_id = w.workspace_id
      group by w.workspace_id, w.balance, w.credits`)).rows as { workspace_id: number; balance: string; credits: number; toman_sum: string; credit_sum: string }[];
    const negative = rows.filter((r) => Number(r.balance) < 0 || r.credits < 0);
    const mismatch = rows.filter((r) => Number(r.balance) !== Number(r.toman_sum) || Number(r.credits) !== Number(r.credit_sum));
    const dup = ((await db.execute(sql`select count(*)::int as n from (select ref from wallet_transactions where ref is not null group by ref having count(*) > 1) d`)).rows[0] as { n: number }).n;
    const total = rows.reduce((a, r) => a + Number(r.balance), 0);
    const ms = Math.round(performance.now() - t0);
    const metrics: Metric[] = [
      { label: "کیف پول‌ها", value: fa(rows.length) },
      { label: "جمع موجودی کاربران", value: `${fa(total)} تومان` },
      { label: "موجودی منفی", value: fa(negative.length), tone: negative.length ? "fail" : "ok" },
      { label: "مغایرت موجودی با دفتر کل", value: fa(mismatch.length), tone: mismatch.length ? "fail" : "ok" },
      { label: "مرجع تراکنش تکراری", value: fa(dup), tone: dup ? "fail" : "ok" },
    ];
    const steps: Step[] = [{ name: "تطبیق موجودی با دفتر کل", ok: mismatch.length === 0, ms, detail: mismatch.length ? `فضاهای کاری مغایر: ${mismatch.slice(0, 5).map((m) => m.workspace_id).join("، ")}` : `${fa(rows.length)} کیف پول مطابق است` }];
    if (negative.length || mismatch.length || dup) {
      return { status: "fail", latencyMs: ms, summary: negative.length ? `${fa(negative.length)} کیف پول با موجودی منفی` : mismatch.length ? `${fa(mismatch.length)} کیف پول با دفتر کل مغایرت دارد` : "ثبت تکراری در دفتر کل", metrics, steps, hints: ["این وضعیت نباید رخ دهد؛ پیش از هر اصلاح بک‌آپ بگیرید و تراکنش‌های آن فضای کاری را در دفتر کل بررسی کنید."] };
    }
    return { status: "ok", latencyMs: ms, summary: rows.length ? `${fa(rows.length)} کیف پول با دفتر کل مطابق است` : "هنوز کیف پولی ساخته نشده", metrics, steps };
  },
};
