import { APP_VERSION, PRODUCT_ID } from "@/lib/version";
import { type CheckDef, type Metric, type Step } from "../types";
import { OFFLINE_GRACE_MS, callLicenseServer, getInstanceId, getLicenseInfo, licenseServerUrl, refreshLicense, resolveDomain } from "@/modules/license/client";
import { ageText, fa, isProd } from "../checks-core";
import { aiChat } from "@/modules/ai/client";
import { assertSafeAiUrl } from "@/lib/external";
import { trustedPublicKey } from "@/modules/license/crypto";
import { getAiConfig, testAiConnection, usageToday } from "@/modules/ai/service";
import { getUpdateInfo } from "@/modules/license/updater";
import { licenseServerEnabled } from "@/modules/license/server";
import { probeUrl } from "../probe";

/* ───────────────────────── هوش مصنوعی ───────────────────────── */

export const ai: CheckDef = {
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
export const license: CheckDef = {
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
      { label: "کلید عمومی فروشنده", value: trustedPublicKey() ? "تنظیم‌شده (امضا راستی‌آزمایی می‌شود)" : "تنظیم نشده یا نامعتبر (فعال‌سازی لایسنس و به‌روزرسانی مسدود است)", tone: trustedPublicKey() ? "ok" : "warn" },
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
