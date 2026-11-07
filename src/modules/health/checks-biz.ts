import { sql } from "drizzle-orm";
import { db } from "@/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { assertSafeAiUrl, externalBase, simActive } from "@/lib/external";
import { trustedAppOrigin } from "@/lib/config";
import { aiChat } from "@/modules/ai/client";
import { getAiConfig, testAiConnection, usageToday } from "@/modules/ai/service";
import { callLicenseServer, getInstanceId, getLicenseInfo, licenseServerUrl, OFFLINE_GRACE_MS, refreshLicense, resolveDomain } from "@/modules/license/client";
import { embeddedPublicKey } from "@/modules/license/crypto";
import { licenseServerEnabled } from "@/modules/license/server";
import { getUpdateInfo } from "@/modules/license/updater";
import { APP_VERSION, PRODUCT_ID } from "@/lib/version";
import { getKycThreshold, kycCounts } from "@/modules/kyc/service";
import { checkoutMode, credentialFor, getAdapter, listGatewayStatuses } from "@/modules/payments/registry";
import { REAL_GATEWAY_IDS, type RealGatewayId } from "@/modules/payments/types";
import { getReferralConfig } from "@/modules/referral/service";
import { ageText, effectiveSmtp, fa, isProd } from "./checks-core";
import { probeUrl, tlsWarning } from "./probe";
import type { CheckDef, Metric, Step } from "./types";

/* ───────────────────────── درگاه‌های پرداخت ───────────────────────── */

const GATEWAY_PROBE: Record<RealGatewayId, () => string> = {
  zarinpal: () => externalBase("zarinpal", !simActive() && process.env.ZARINPAL_SANDBOX === "1" ? "https://sandbox.zarinpal.com" : "https://payment.zarinpal.com"),
  zibal: () => "https://gateway.zibal.ir",
  idpay: () => "https://api.idpay.ir",
  payir: () => "https://pay.ir",
};

function gatewayCheck(id: RealGatewayId): CheckDef {
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

const paymentFlow: CheckDef = {
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

const wallet: CheckDef = {
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

/* ───────────────────────── هوش مصنوعی ───────────────────────── */

const ai: CheckDef = {
  id: "ai",
  group: "ai",
  label: "هوش مصنوعی",
  weight: 1,
  deepAvailable: true,
  deepLabel: "تست تولید متن (مصرف چند توکن)",
  fixHref: "/admin/settings",
  fixLabel: "تنظیمات هوش مصنوعی",
  async run(ctx, deep) {
    const cfg = await getAiConfig(ctx.workspaceId);
    if (!cfg.key) return { status: "unconfigured", summary: "کلید هوش مصنوعی تنظیم نشده است", hints: ["کلید را در «تنظیمات ← هوش مصنوعی» وارد کنید (یا AI_API_KEY برای پیش‌فرض پلتفرم)."] };
    const source = cfg.source === "workspace" ? "فضای کاری" : "پلتفرم (محیط)";
    const metrics: Metric[] = [
      { label: "سرویس", value: cfg.provider },
      { label: "مدل", value: cfg.model },
      { label: "آدرس", value: cfg.baseUrl },
    ];
    const u = await usageToday(ctx.workspaceId).catch(() => null);
    if (u) metrics.push({ label: "مصرف ۲۴ ساعت", value: `${fa(u.used)} از ${fa(u.limit)}`, tone: u.used >= u.limit ? "warn" : "ok" });
    let steps: Step[] = [];
    let probeMs = 0;
    try {
      const safe = await assertSafeAiUrl(cfg.baseUrl);
      const p = await probeUrl(safe.origin, { timeoutMs: 8000, method: "HEAD" });
      steps = p.steps;
      probeMs = p.latencyMs;
      if (!p.ok) return { status: "fail", latencyMs: p.latencyMs, summary: `سرویس AI در دسترس نیست: ${p.error}`, steps, metrics, source, hints: ["اگر سرور در ایران است، برخی سرویس‌ها (OpenAI, Anthropic) تحریم/مسدودند؛ GapGPT یا OpenRouter را امتحان کنید."] };
    } catch (e) {
      return { status: "fail", summary: e instanceof Error ? e.message : "آدرس سرویس نامعتبر است", metrics, source, hints: ["آدرس پایه‌ی سرویس باید HTTPS عمومی باشد."] };
    }
    const t0 = performance.now();
    const r = await testAiConnection({ key: cfg.key, baseUrl: cfg.baseUrl, model: cfg.model, provider: cfg.provider });
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) {
      steps.push({ name: "احراز هویت (/models)", ok: false, ms, detail: r.error });
      return { status: "fail", latencyMs: probeMs + ms, summary: r.error, steps, metrics, source, hints: ["کلید API، آدرس پایه و نام مدل را بررسی کنید؛ اعتبار حساب سرویس هم ممکن است تمام شده باشد."] };
    }
    steps.push({ name: "احراز هویت (/models)", ok: true, ms, detail: r.models.length ? `${fa(r.models.length)} مدل در دسترس` : "پاسخ معتبر (فهرست مدل ارائه نشد)" });
    let latency = ms;
    let warn: string | null = null;
    if (r.models.length && !r.models.includes(cfg.model)) {
      warn = `مدل «${cfg.model}» در فهرست سرویس نیست`;
      metrics.push({ label: "مدل انتخابی", value: "در فهرست سرویس یافت نشد", tone: "warn" });
    }
    if (deep) {
      const c0 = performance.now();
      try {
        const out = await aiChat({ key: cfg.key, baseUrl: cfg.baseUrl, model: cfg.model, provider: cfg.provider }, { system: "Health probe. Reply with the single word OK.", user: "ping", maxTokens: 8, temperature: 0, timeoutMs: 30_000 });
        const cms = Math.round(performance.now() - c0);
        latency = cms;
        steps.push({ name: "تولید متن آزمایشی", ok: !!out.text, ms: cms, detail: out.text ? `پاسخ: «${out.text.slice(0, 30)}» · ${fa(out.tokens)} توکن` : "پاسخ خالی" });
        if (!out.text) warn = "سرویس پاسخ خالی برگرداند";
      } catch (e) {
        const msg = e instanceof Error ? e.message : "خطا";
        steps.push({ name: "تولید متن آزمایشی", ok: false, ms: Math.round(performance.now() - c0), detail: msg });
        return { status: "fail", latencyMs: Math.round(performance.now() - c0), summary: `احراز هویت موفق اما تولید متن ناموفق: ${msg}`, steps, metrics, source, hints: ["نام مدل یا اعتبار حساب را بررسی کنید."] };
      }
    }
    return { status: warn || latency > 8000 ? "warn" : "ok", latencyMs: latency, summary: warn ?? `متصل · ${fa(latency)} میلی‌ثانیه${deep ? " · تولید متن تأیید شد" : ""}`, steps, metrics, source };
  },
};

/* ───────────────────────── لایسنس و به‌روزرسانی ───────────────────────── */

const DUMMY_KEY = "EMZ-HEALTH-CHECK-PING0-ZZZZZ";

const license: CheckDef = {
  id: "license",
  group: "license",
  label: "سرور لایسنس",
  weight: 2,
  deepAvailable: true,
  deepLabel: "بررسی امضاشده‌ی لایسنس",
  fixHref: "/platform/license",
  fixLabel: "لایسنس و به‌روزرسانی",
  async run(_ctx, deep) {
    const info = await getLicenseInfo();
    const url = licenseServerUrl();
    const probe = await probeUrl(url, { timeoutMs: 8000 });
    const steps: Step[] = [...probe.steps];
    const metrics: Metric[] = [
      { label: "سرور لایسنس", value: url },
      { label: "وضعیت لایسنس", value: info.state, tone: info.state === "active" ? "ok" : info.state === "unlicensed" ? "warn" : "fail" },
      { label: "کلید عمومی فروشنده", value: embeddedPublicKey() ? "تنظیم‌شده (امضا راستی‌آزمایی می‌شود)" : "تنظیم نشده (پاسخ سرور راستی‌آزمایی نمی‌شود)", tone: embeddedPublicKey() ? "ok" : isProd() ? "warn" : "ok" },
    ];
    if (info.plan) metrics.push({ label: "طرح / مشتری", value: `${info.plan} · ${info.customer || "—"}` });
    if (info.domain) metrics.push({ label: "دامنه‌ی ثبت‌شده", value: info.domain });
    if (info.expiresAt) metrics.push({ label: "انقضای لایسنس", value: new Date(info.expiresAt).toLocaleDateString("fa-IR") });
    if (probe.tlsDaysLeft !== undefined) metrics.push({ label: "گواهی TLS سرور لایسنس", value: `${fa(probe.tlsDaysLeft)} روز`, tone: probe.tlsDaysLeft <= 14 ? "warn" : "ok" });
    let graceLeftMs: number | null = null;
    if (info.okAt) {
      graceLeftMs = OFFLINE_GRACE_MS - (Date.now() - new Date(info.okAt).getTime());
      metrics.push({ label: "آخرین تأیید موفق", value: `${ageText(Date.now() - new Date(info.okAt).getTime())} پیش` });
      metrics.push({ label: "مهلت آفلاین باقی‌مانده", value: graceLeftMs > 0 ? ageText(graceLeftMs) : "تمام شده", tone: graceLeftMs < 2 * 86400_000 ? "fail" : graceLeftMs < 7 * 86400_000 ? "warn" : "ok" });
    }
    if (info.lastError) metrics.push({ label: "آخرین خطای بررسی", value: info.lastError, tone: "warn" });
    const upd = await getUpdateInfo().catch(() => null);
    if (upd) {
      metrics.push({ label: "نسخه‌ی نصب‌شده", value: upd.current });
      metrics.push({ label: "به‌روزرسانی", value: upd.updateAvailable && upd.latest ? `نسخه‌ی ${upd.latest.version} در دسترس است${upd.latest.security ? " (امنیتی)" : ""}` : "آخرین نسخه", tone: upd.updateAvailable ? (upd.latest?.security ? "warn" : "ok") : "ok" });
      if (upd.error) metrics.push({ label: "خطای کانال به‌روزرسانی", value: upd.error, tone: "warn" });
    }
    if (licenseServerEnabled()) metrics.push({ label: "نقش", value: "این نصب خودش سرور لایسنس است" });

    let latency = probe.latencyMs;
    if (deep) {
      const t0 = performance.now();
      try {
        if (info.state !== "unlicensed") {
          const after = await refreshLicense();
          steps.push({ name: "بررسی امضاشده‌ی لایسنس", ok: !after.lastError, ms: Math.round(performance.now() - t0), detail: after.lastError || `وضعیت: ${after.state}` });
          if (after.lastError) return { status: "fail", latencyMs: probe.latencyMs, summary: after.lastError, steps, metrics, hints: ["پاسخ سرور لایسنس با کلید عمومی فروشنده راستی‌آزمایی نشد یا سرور در دسترس نیست."] };
        } else {
          const r = await callLicenseServer("/api/license/v1/check", { key: DUMMY_KEY, domain: await resolveDomain(), instanceId: await getInstanceId(), version: APP_VERSION, product: PRODUCT_ID, ping: true });
          steps.push({ name: "تماس امضاشده (کلید آزمایشی)", ok: true, ms: Math.round(performance.now() - t0), detail: `سرور پاسخ داد (${String(r.data.status)})${r.verified ? " · امضا معتبر" : " · امضا بررسی نشد (کلید عمومی تنظیم نیست)"}` });
        }
        latency = Math.round(performance.now() - t0);
      } catch (e) {
        const m = e instanceof Error ? e.message : "خطا";
        steps.push({ name: "تماس امضاشده", ok: false, ms: Math.round(performance.now() - t0), detail: m });
        const optional = info.state === "unlicensed" && process.env.LICENSE_REQUIRED !== "1";
        return { status: optional ? "warn" : "fail", summary: m, steps, metrics, hints: ["آدرس LICENSE_SERVER_URL و LICENSE_PUBLIC_KEY را بررسی کنید."] };
      }
    }
    const hints: string[] = [];
    if (info.state === "unlicensed") {
      const required = process.env.LICENSE_REQUIRED === "1";
      return { status: required ? "fail" : "unconfigured", latencyMs: latency, summary: required ? "لایسنس فعال نیست و LICENSE_REQUIRED=1 است؛ صدور قرارداد جدید مسدود است" : probe.ok ? "لایسنس فعال نشده (سرور لایسنس در دسترس است)" : `لایسنس فعال نشده و سرور لایسنس در دسترس نیست: ${probe.error}`, steps, metrics, hints: ["کلید لایسنس را در «لایسنس و به‌روزرسانی» فعال کنید."] };
    }
    if (info.state !== "active") return { status: "fail", latencyMs: latency, summary: `لایسنس ${info.state === "expired" ? "منقضی" : info.state === "revoked" ? "باطل" : info.state === "suspended" ? "معلق" : info.state === "grace_expired" ? "از مهلت آفلاین گذشته" : "نامعتبر"} است`, steps, metrics, hints: ["با پشتیبانی فروشنده تماس بگیرید یا «بررسی مجدد» را بزنید."] };
    if (!probe.ok) {
      const critical = graceLeftMs !== null && graceLeftMs < 2 * 86400_000;
      return { status: critical ? "fail" : "warn", latencyMs: latency, summary: `سرور لایسنس در دسترس نیست (${probe.error}) — سایت با مهلت آفلاین کار می‌کند`, steps, metrics, hints: ["قطعی سرور لایسنس سایت را از کار نمی‌اندازد؛ اما پس از پایان مهلت آفلاین لایسنس نامعتبر می‌شود."] };
    }
    if (info.stale || !info.verified) hints.push(info.verified ? "آخرین بررسی لایسنس قدیمی است؛ «تست عمیق» را بزنید." : "کلید عمومی تنظیم نیست؛ پاسخ سرور لایسنس راستی‌آزمایی نشده است.");
    return { status: info.stale || (!info.verified && isProd()) ? "warn" : "ok", latencyMs: latency, summary: info.stale ? "لایسنس فعال؛ آخرین بررسی قدیمی است" : `لایسنس فعال · سرور ${fa(latency)} میلی‌ثانیه`, steps, metrics, hints };
  },
};

/* ───────────────────────── احراز هویت، دعوت و همگام‌سازی ───────────────────────── */

const kyc: CheckDef = {
  id: "kyc",
  group: "business",
  label: "احراز هویت (KYC)",
  weight: 1,
  fixHref: "/platform/kyc",
  fixLabel: "صف احراز هویت",
  async run() {
    const [threshold, counts] = await Promise.all([getKycThreshold(), kycCounts()]);
    const oldest = ((await db.execute(sql`select min(created_at) as t from kyc_submissions where status = 'pending'`)).rows[0] as { t: Date | null }).t;
    const steps: Step[] = [];
    // آزمون رمزنگاری واقعی: همان مسیری که کد ملی و فایل‌ها با آن ذخیره می‌شوند
    let cryptoOk = false;
    try {
      const probe = `kyc-health-${Date.now()}`;
      cryptoOk = decryptSecret(encryptSecret(probe)) === probe;
    } catch {
      cryptoOk = false;
    }
    steps.push({ name: "رمزنگاری AES-256-GCM", ok: cryptoOk, detail: cryptoOk ? "رفت‌وبرگشت موفق" : "کلید امنیتی در دسترس نیست" });
    const age = oldest ? Date.now() - new Date(oldest).getTime() : 0;
    const metrics: Metric[] = [
      { label: "آستانه‌ی الزام KYC", value: threshold > 0 ? `${fa(threshold)} تومان` : "غیرفعال", tone: threshold > 0 ? "ok" : "warn" },
      { label: "در انتظار / تأییدشده / ردشده", value: `${fa(counts.pending)} / ${fa(counts.approved)} / ${fa(counts.rejected)}` },
    ];
    if (oldest) metrics.push({ label: "قدیمی‌ترین درخواست در صف", value: ageText(age), tone: age > 7 * 86400_000 ? "fail" : age > 48 * 3600_000 ? "warn" : "ok" });
    if (!cryptoOk) return { status: "fail", summary: "رمزنگاری مدارک هویتی کار نمی‌کند", steps, metrics, hints: ["SESSION_SECRET را بررسی کنید."] };
    if (age > 7 * 86400_000) return { status: "fail", summary: `درخواست KYC بیش از ${ageText(age)} در صف مانده`, steps, metrics };
    if (age > 48 * 3600_000) return { status: "warn", summary: `${fa(counts.pending)} درخواست در صف؛ قدیمی‌ترین ${ageText(age)}`, steps, metrics };
    return { status: "ok", summary: counts.pending ? `${fa(counts.pending)} درخواست در صف بررسی` : "صف بررسی خالی است · رمزنگاری سالم", steps, metrics };
  },
};

const referral: CheckDef = {
  id: "referral",
  group: "business",
  label: "سیستم دعوت دوستان",
  weight: 1,
  fixHref: "/platform/commerce",
  fixLabel: "تنظیمات دعوت",
  async run(ctx) {
    const cfg = await getReferralConfig();
    const stats = ((await db.execute(sql`select count(*)::int as total, count(*) filter (where status = 'qualified')::int as qualified, count(*) filter (where created_at > now() - interval '24 hours')::int as recent from referrals`)).rows[0]) as { total: number; qualified: number; recent: number };
    const ips = (await db.execute(sql`select signup_ip, count(*)::int as n from referrals where signup_ip <> '' and created_at > now() - interval '7 days' group by signup_ip having count(*) >= 5 order by n desc limit 3`)).rows as { signup_ip: string; n: number }[];
    const smtp = await effectiveSmtp(ctx.workspaceId);
    const app = trustedAppOrigin();
    const metrics: Metric[] = [
      { label: "وضعیت سیستم دعوت", value: cfg.enabled ? "فعال" : "خاموش" },
      { label: "دعوت‌ها: کل / موفق / ۲۴ ساعت", value: `${fa(stats.total)} / ${fa(stats.qualified)} / ${fa(stats.recent)}` },
      { label: "پاداش هر دعوت موفق", value: `${fa(cfg.referrerWallet)} تومان + ${fa(cfg.referrerCredits)} اعتبار`, tone: "ok" },
      { label: "آدرس لینک‌های دعوت (APP_URL)", value: app || "از هدر Host ساخته می‌شود", tone: app ? "ok" : "warn" },
      { label: "ایمیل دعوت‌نامه", value: smtp ? "SMTP آماده" : "SMTP تنظیم نیست (ایمیل ارسال نمی‌شود)", tone: smtp ? "ok" : "warn" },
    ];
    if (ips.length) metrics.push({ label: "IP مشکوک (≥۵ ثبت‌نام در ۷ روز)", value: ips.map((i) => `${i.signup_ip} (${fa(i.n)})`).join("، "), tone: "warn" });
    if (!cfg.enabled) return { status: "unconfigured", summary: "سیستم دعوت خاموش است", metrics };
    if (ips.length) return { status: "warn", summary: `${fa(ips.length)} IP با ثبت‌نام‌های پیاپی (احتمال سوءاستفاده از پاداش)`, metrics, hints: ["مکانیزم ضد‌تقلب پاداش را محدود می‌کند؛ ثبت‌نام‌های این IPها را بررسی کنید."] };
    if (!smtp || (!app && isProd())) return { status: "warn", summary: !smtp ? "دعوت‌نامه‌های ایمیلی بدون SMTP ارسال نمی‌شوند" : "APP_URL تنظیم نیست؛ لینک دعوت ممکن است نادرست ساخته شود", metrics };
    return { status: "ok", summary: `فعال · ${fa(stats.qualified)} دعوت موفق از ${fa(stats.total)}`, metrics };
  },
};

const outbox: CheckDef = {
  id: "sync-outbox",
  group: "business",
  label: "صف همگام‌سازی ووکامرس/وردپرس",
  weight: 1,
  fixHref: "/admin/woocommerce",
  fixLabel: "همگام‌سازی ووکامرس",
  async run() {
    const conns = ((await db.execute(sql`select count(*)::int as n from wp_connections`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0] as { n: number }).n;
    const rows = (await db.execute(sql`select status, count(*)::int as n, min(created_at) as oldest from wp_outbox where created_at > now() - interval '7 days' group by status`)).rows as { status: string; n: number; oldest: Date }[];
    const get = (s: string) => rows.find((r) => r.status === s);
    const pending = get("pending")?.n ?? 0, dead = get("dead")?.n ?? 0, delivered = get("delivered")?.n ?? 0;
    const age = get("pending")?.oldest ? Date.now() - new Date(get("pending")!.oldest).getTime() : 0;
    const metrics: Metric[] = [
      { label: "اتصال‌های وردپرس", value: fa(conns) },
      { label: "۷ روز: تحویل‌شده / منتظر / ناموفق نهایی", value: `${fa(delivered)} / ${fa(pending)} / ${fa(dead)}`, tone: dead ? "warn" : "ok" },
    ];
    if (pending) metrics.push({ label: "قدیمی‌ترین رویداد منتظر", value: ageText(age), tone: age > 3600_000 ? "warn" : "ok" });
    if (conns === 0 && rows.length === 0) return { status: "unconfigured", summary: "سایت وردپرسی متصل نیست", metrics };
    if (dead > 0) return { status: "warn", summary: `${fa(dead)} رویداد پس از تلاش‌های مکرر ناموفق ماند`, metrics, hints: ["صفحه‌ی همگام‌سازی ووکامرس امکان «تلاش مجدد» دارد؛ اتصال سایت وردپرس را هم بررسی کنید."] };
    if (pending > 0 && age > 3600_000) return { status: "warn", summary: `${fa(pending)} رویداد بیش از ${ageText(age)} منتظر ارسال است`, metrics };
    return { status: "ok", summary: `${fa(conns)} اتصال · صف سالم`, metrics };
  },
};

export const BIZ_CHECKS: CheckDef[] = [...REAL_GATEWAY_IDS.map(gatewayCheck), paymentFlow, wallet, ai, license, kyc, referral, outbox];
