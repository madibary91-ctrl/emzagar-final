import { type CheckDef, type Metric, type Step } from "../types";
import { db } from "@/db";
import { explainNetError, probeSocket, tlsWarning } from "../probe";
import { extTimeout, externalBase } from "@/lib/external";
import { fa, isProd } from "./util";
import { getAllSettings } from "@/modules/settings/service";
import nodemailer from "nodemailer";
import { guardedSmtpOptions, type SmtpConnectOptions } from "@/lib/smtp-guard";
import { platformSms } from "@/modules/sms";
import { sql } from "drizzle-orm";

/* ───────────────────────── ایمیل و پیامک ───────────────────────── */

type SmtpCfg = { host: string; port: number; user: string; pass: string; from: string; source: string };
/** همان منطق sendMail: SMTP فضای کاری، وگرنه SMTP پلتفرم (محیط) */
export async function effectiveSmtp(workspaceId: number): Promise<SmtpCfg | null> {
  const s = await getAllSettings(workspaceId);
  if (workspaceId && s.smtp_host) return { host: s.smtp_host, port: Number(s.smtp_port) || 587, user: s.smtp_user, pass: s.smtp_pass, from: s.smtp_from || s.smtp_user || s.admin_email, source: "فضای کاری" };
  if (process.env.SMTP_HOST) return { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 587, user: process.env.SMTP_USER || "", pass: process.env.SMTP_PASS || "", from: process.env.SMTP_FROM || process.env.SMTP_USER || "", source: "پلتفرم (محیط)" };
  return null;
}
export const email: CheckDef = {
  id: "email",
  group: "comms",
  label: "ایمیل (SMTP)",
  weight: 3,
  fixHref: "/admin/settings",
  fixLabel: "تنظیمات ایمیل",
  async run(ctx) {
    const cfg = await effectiveSmtp(ctx.workspaceId);
    if (!cfg) {
      const must = process.env.REQUIRE_EMAIL_VERIFICATION !== "0";
      return {
        status: must && isProd() ? "fail" : "unconfigured",
        summary: "SMTP تنظیم نشده؛ ایمیل‌ها فقط در صندوق ارتباطات ثبت می‌شوند",
        hints: [must ? "تأیید ایمیل هنگام ثبت‌نام اجباری است؛ بدون SMTP کاربران نمی‌توانند حساب را فعال کنند." : "برای ارسال لینک امضا و بازیابی رمز، SMTP را تنظیم کنید.", "تنظیم: «تنظیمات ← ایمیل» یا متغیرهای SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS."],
      };
    }
    const secure = cfg.port === 465;
    // M-01: میزبان/پورت فضای کاری پیش از هر اتصال از محافظ SSRF می‌گذرد و به IP پین‌شده وصل می‌شود (داشبورد سلامت = اسکنر پورت نشود)
    let target: SmtpConnectOptions;
    try {
      target = await guardedSmtpOptions(cfg.host, cfg.port, { trusted: cfg.source !== "فضای کاری" });
    } catch (e) {
      return { status: "fail", summary: e instanceof Error ? e.message : "میزبان یا پورت SMTP مجاز نیست", steps: [{ name: "بررسی مقصد", ok: false, detail: "مقصد SMTP مجاز نیست" }], source: cfg.source, hints: ["فقط میزبان عمومی و پورت‌های 25، 465، 587 یا 2525 مجازند."] };
    }
    const sock = await probeSocket(cfg.host, cfg.port, { secure, readBanner: !secure, timeoutMs: 8000, connectHost: target.host });
    const metrics: Metric[] = [
      { label: "میزبان", value: `${cfg.host}:${cfg.port}` },
      { label: "رمزنگاری", value: secure ? "TLS مستقیم (465)" : cfg.port === 587 ? "STARTTLS (587)" : "پورت غیراستاندارد" },
      { label: "فرستنده", value: cfg.from || "—" },
      { label: "احراز هویت", value: cfg.user ? `کاربر ${cfg.user}` : "بدون احراز هویت", tone: cfg.user ? "ok" : "warn" },
    ];
    if (!sock.ok) return { status: "fail", latencyMs: sock.latencyMs, summary: sock.error || "اتصال به سرور SMTP برقرار نشد", steps: sock.steps, metrics, source: cfg.source, hints: ["میزبان/پورت را بررسی کنید؛ بسیاری از هاست‌ها پورت 25 و گاهی 587 را مسدود می‌کنند.", "برای پورت 465 رمزنگاری مستقیم و برای 587 STARTTLS لازم است."] };
    // احراز هویت کامل (بدون ارسال ایمیل)
    const t0 = performance.now();
    const steps = [...sock.steps];
    try {
      const tr = nodemailer.createTransport({ host: target.host, port: target.port, secure: target.secure, tls: target.tls, auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 });
      await tr.verify();
      tr.close();
      steps.push({ name: "احراز هویت SMTP", ok: true, ms: Math.round(performance.now() - t0), detail: "ورود موفق (ایمیلی ارسال نشد)" });
    } catch (e) {
      const m = e instanceof Error ? e.message : "خطا";
      const authFail = /auth|535|credentials|username|password/i.test(m);
      steps.push({ name: "احراز هویت SMTP", ok: false, ms: Math.round(performance.now() - t0), detail: m.slice(0, 160) });
      return { status: "fail", latencyMs: sock.latencyMs + Math.round(performance.now() - t0), summary: authFail ? "نام کاربری یا رمز SMTP پذیرفته نشد" : `SMTP پاسخ نامعتبر داد: ${m.slice(0, 80)}`, steps, metrics, source: cfg.source, hints: authFail ? ["رمز برنامه‌ای (App Password) سرویس ایمیل را بررسی کنید."] : [] };
    }
    const total = sock.latencyMs + Math.round(performance.now() - t0);
    const tls0 = tlsWarning(sock);
    return { status: tls0 || total > 6000 ? "warn" : "ok", latencyMs: total, summary: tls0 ?? `ورود موفق · ${fa(total)} میلی‌ثانیه`, steps, metrics, source: cfg.source, hints: ["برای اطمینان از رسیدن ایمیل به صندوق ورودی، از ابزار «ارسال ایمیل آزمایشی» استفاده کنید."] };
  },
};
type SmsInfo = { id: "log" | "kavenegar" | "melipayamak"; source: string; key?: string; user?: string; pass?: string };
async function effectiveSms(workspaceId: number): Promise<SmsInfo> {
  const s = await getAllSettings(workspaceId);
  if (s.sms_provider === "kavenegar" && s.kavenegar_api_key) return { id: "kavenegar", source: "فضای کاری", key: s.kavenegar_api_key };
  if (s.sms_provider === "melipayamak" && s.melipayamak_username) return { id: "melipayamak", source: "فضای کاری", user: s.melipayamak_username, pass: s.melipayamak_password };
  const p = platformSms();
  if (p?.provider.id === "kavenegar") return { id: "kavenegar", source: "پلتفرم (مدیریت‌شده)", key: p.cfg.kavenegar_api_key };
  if (p?.provider.id === "melipayamak") return { id: "melipayamak", source: "پلتفرم (مدیریت‌شده)", user: p.cfg.melipayamak_username, pass: p.cfg.melipayamak_password };
  return { id: "log", source: "حالت آزمایشی" };
}
export const sms: CheckDef = {
  id: "sms",
  group: "comms",
  label: "پیامک (OTP و لینک امضا)",
  weight: 2,
  fixHref: "/admin/settings",
  fixLabel: "تنظیمات پیامک",
  async run(ctx) {
    const info = await effectiveSms(ctx.workspaceId);
    if (info.id === "log") {
      return {
        status: isProd() ? "warn" : "unconfigured",
        source: info.source,
        summary: "پنل پیامک تنظیم نشده؛ پیامک‌ها فقط در لاگ ثبت می‌شوند",
        hints: ["کد تأیید امضا (OTP) از طریق پیامک واقعی نمی‌رسد؛ در «تنظیمات ← پیامک» کاوه‌نگار یا ملی‌پیامک را وصل کنید.", "یا PLATFORM_SMS_PROVIDER را برای پنل مدیریت‌شده‌ی پلتفرم تنظیم کنید."],
      };
    }
    const label = info.id === "kavenegar" ? "کاوه‌نگار" : "ملی‌پیامک";
    const base = info.id === "kavenegar" ? externalBase("kavenegar", "https://api.kavenegar.com") : externalBase("melipayamak", "https://rest.payamak-panel.com");
    const t0 = performance.now();
    const steps: Step[] = [];
    const metrics: Metric[] = [{ label: "سرویس", value: label }];
    try {
      let credit: number | null = null;
      if (info.id === "kavenegar") {
        const res = await fetch(`${base}/v1/${encodeURIComponent(info.key || "")}/account/info.json`, { signal: AbortSignal.timeout(extTimeout(10_000)), redirect: "error" });
        const j = (await res.json().catch(() => null)) as { return?: { status?: number; message?: string }; entries?: { remaincredit?: number; expiredate?: number; type?: string } } | null;
        const st = j?.return?.status;
        if (st !== 200) {
          const msg = st === 403 ? "کلید API کاوه‌نگار نامعتبر است" : st === 416 ? "IP سرور در فهرست مجاز کاوه‌نگار نیست" : st === 401 ? "حساب کاوه‌نگار غیرفعال است" : res.status >= 500 ? `پنل کاوه‌نگار در دسترس نیست (HTTP ${res.status})` : `پاسخ ناموفق (کد ${st ?? res.status})`;
          steps.push({ name: "account/info", ok: false, ms: Math.round(performance.now() - t0), detail: msg });
          return { status: "fail", latencyMs: Math.round(performance.now() - t0), summary: msg, steps, metrics, source: info.source };
        }
        credit = Number(j?.entries?.remaincredit ?? NaN);
        if (j?.entries?.type) metrics.push({ label: "نوع حساب", value: String(j.entries.type) });
        if (j?.entries?.expiredate) metrics.push({ label: "انقضای حساب", value: new Date(j.entries.expiredate * 1000).toLocaleDateString("fa-IR") });
      } else {
        const res = await fetch(`${base}/api/SendSMS/GetCredit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: info.user, password: info.pass }), signal: AbortSignal.timeout(extTimeout(10_000)), redirect: "error" });
        const j = (await res.json().catch(() => null)) as { RetStatus?: number; Value?: string; StrRetStatus?: string } | null;
        if (!res.ok || !j || Number(j.RetStatus) !== 1) {
          const msg = !res.ok ? `پنل ملی‌پیامک در دسترس نیست (HTTP ${res.status})` : "نام کاربری یا رمز ملی‌پیامک اشتباه است";
          steps.push({ name: "GetCredit", ok: false, ms: Math.round(performance.now() - t0), detail: msg });
          return { status: "fail", latencyMs: Math.round(performance.now() - t0), summary: msg, steps, metrics, source: info.source };
        }
        credit = Number(j.Value);
      }
      const ms = Math.round(performance.now() - t0);
      steps.push({ name: "احراز و اعتبار", ok: true, ms, detail: Number.isFinite(credit) ? `اعتبار: ${fa(credit as number)}` : "پاسخ معتبر" });
      if (credit !== null && Number.isFinite(credit)) metrics.push({ label: "اعتبار باقی‌مانده", value: fa(credit), tone: credit <= 0 ? "fail" : credit < 5000 ? "warn" : "ok" });
      if (credit !== null && Number.isFinite(credit) && credit <= 0) return { status: "fail", latencyMs: ms, summary: "اعتبار پنل پیامک تمام شده است", steps, metrics, source: info.source, hints: ["پنل را شارژ کنید؛ بدون اعتبار کد امضا ارسال نمی‌شود."] };
      const low = credit !== null && Number.isFinite(credit) && credit < 5000;
      return { status: low || ms > 6000 ? "warn" : "ok", latencyMs: ms, summary: low ? `اعتبار پنل کم است (${fa(credit as number)})` : `${label} متصل · ${fa(ms)} میلی‌ثانیه`, steps, metrics, source: info.source, hints: ["برای اطمینان از رسیدن پیامک، از ابزار «ارسال پیامک آزمایشی» استفاده کنید."] };
    } catch (e) {
      const msg = explainNetError(e);
      steps.push({ name: "اتصال", ok: false, ms: Math.round(performance.now() - t0), detail: msg });
      return { status: "fail", latencyMs: Math.round(performance.now() - t0), summary: `ارتباط با ${label} برقرار نشد: ${msg}`, steps, metrics, source: info.source };
    }
  },
};
export const deliverability: CheckDef = {
  id: "deliverability",
  group: "comms",
  label: "کیفیت تحویل پیام (۲۴ ساعت)",
  weight: 1,
  fixHref: "/admin/logs",
  async run() {
    const rows = (await db.execute(sql`select channel, status, count(*)::int as n from notifications where created_at > now() - interval '24 hours' group by channel, status`)).rows as { channel: string; status: string; n: number }[];
    const by = (ch: string, st: string) => rows.find((r) => r.channel === ch && r.status === st)?.n ?? 0;
    const metrics: Metric[] = [];
    let worst: "ok" | "warn" | "fail" = "ok";
    let summary = "";
    for (const [ch, label] of [["email", "ایمیل"], ["sms", "پیامک"]] as const) {
      const sent = by(ch, "sent"), failed = by(ch, "failed"), logged = by(ch, "logged");
      const real = sent + failed;
      const rate = real ? Math.round((failed / real) * 100) : 0;
      const tone = real >= 5 && rate > 50 ? "fail" : failed > 0 && rate > 20 ? "warn" : "ok";
      metrics.push({ label: `${label}: موفق / ناموفق / فقط ثبت‌شده`, value: `${fa(sent)} / ${fa(failed)} / ${fa(logged)}`, tone });
      if (tone === "fail") { worst = "fail"; summary = `${label}: ${fa(rate)}٪ ارسال‌ها ناموفق است`; }
      else if (tone === "warn" && worst !== "fail") { worst = "warn"; summary = `${label}: ${fa(failed)} ارسال ناموفق`; }
    }
    const last = (await db.execute(sql`select channel, error, created_at from notifications where status = 'failed' and created_at > now() - interval '24 hours' order by id desc limit 1`)).rows[0] as { channel: string; error: string | null; created_at: Date } | undefined;
    if (last?.error) metrics.push({ label: "آخرین خطا", value: `${last.channel}: ${last.error.slice(0, 110)}`, tone: "warn" });
    const total = rows.reduce((a, r) => a + r.n, 0);
    return { status: worst, summary: summary || (total ? `${fa(total)} پیام در ۲۴ ساعت گذشته بدون مشکل` : "در ۲۴ ساعت گذشته پیامی ارسال نشده"), metrics };
  },
};
