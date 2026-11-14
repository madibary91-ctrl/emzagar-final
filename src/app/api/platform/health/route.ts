import { rateLimit } from "@/lib/rate-limit";
import { escapeHtml } from "@/lib/html";
import { sendMail } from "@/modules/mail";
import { sendSms } from "@/modules/sms";
import { auditHealthAction, buildSnapshot, runChecks, runOne } from "@/modules/health/service";
import { guardAdmin, json } from "@/modules/health/guard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** وضعیت کامل داشبورد (از حافظه‌ی نهان ۴۰ ثانیه‌ای؛ force=1 همه را دوباره می‌سنجد) */
export async function GET(req: Request) {
  const g = await guardAdmin(req, { bucket: "health-get", limit: 40 });
  if (!g.ok) return g.res;
  const force = new URL(req.url).searchParams.get("force") === "1";
  const snapshot = await buildSnapshot(g.ctx, { force, workspaceName: g.workspaceName });
  return json({ ok: true, snapshot });
}

type Body = { action?: string; id?: string; deep?: boolean; to?: string };

/** ابزارهای عیب‌یابی: تست مجدد/عمیق یک سرویس، تست عمیق همه، ایمیل و پیامک آزمایشی */
export async function POST(req: Request) {
  const g = await guardAdmin(req, { mutating: true, bucket: "health-post", limit: 30 });
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || typeof body.action !== "string") return json({ ok: false, error: "درخواست نامعتبر" }, 400);

  if (body.action === "run") {
    const id = String(body.id || "");
    const deep = body.deep === true;
    const p = runOne(id, g.ctx, deep);
    if (!p) return json({ ok: false, error: "سرویس ناشناخته" }, 404);
    if (deep) await auditHealthAction(g.user.id, "health.deep_test", id);
    return json({ ok: true, result: await p });
  }

  if (body.action === "deep-all") {
    if (!rateLimit(`health-deep-all:${g.user.id}`, 4, 5 * 60_000).ok) return json({ ok: false, error: "تست عمیق همه‌ی سرویس‌ها را هر ۵ دقیقه حداکثر ۴ بار می‌توان اجرا کرد" }, 429);
    await runChecks(g.ctx, { deep: true, force: true });
    await auditHealthAction(g.user.id, "health.deep_test", "all");
    return json({ ok: true, snapshot: await buildSnapshot(g.ctx, { workspaceName: g.workspaceName }) });
  }

  if (body.action === "email") {
    const to = String(body.to || "").trim().slice(0, 200);
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(to)) return json({ ok: false, error: "آدرس ایمیل معتبر نیست" }, 400);
    if (!rateLimit(`health-mail:${g.user.id}`, 5, 10 * 60_000).ok) return json({ ok: false, error: "حداکثر ۵ ایمیل آزمایشی در ۱۰ دقیقه مجاز است" }, 429);
    const t0 = performance.now();
    const r = await sendMail({
      to,
      subject: "ایمیل آزمایشی — داشبورد سلامت سیستم",
      html: `<div dir="rtl" style="font-family:Tahoma,sans-serif;line-height:2"><h3>✅ ایمیل آزمایشی</h3><p>اگر این پیام را در صندوق ورودی می‌بینید، ارسال ایمیل سیستم به‌درستی کار می‌کند.</p><p style="color:#666;font-size:12px">زمان: ${escapeHtml(new Date().toLocaleString("fa-IR"))}</p></div>`,
      workspaceId: g.ctx.workspaceId,
    });
    await auditHealthAction(g.user.id, "health.test_email", `${r.status}`);
    const ms = Math.round(performance.now() - t0);
    if (r.status === "sent") return json({ ok: true, message: `ایمیل در ${ms} میلی‌ثانیه به سرور SMTP تحویل شد؛ صندوق ورودی (و اسپم) را بررسی کنید.` });
    if (r.status === "logged") return json({ ok: false, error: "SMTP تنظیم نشده است؛ ایمیل فقط در صندوق ارتباطات ثبت شد و ارسال نشد." });
    return json({ ok: false, error: `ارسال ناموفق: ${(r.error || "خطای نامشخص").slice(0, 200)}` });
  }

  if (body.action === "sms") {
    const to = String(body.to || "").trim();
    if (!/^09\d{9}$/.test(to)) return json({ ok: false, error: "شماره‌ی موبایل باید به شکل 09123456789 باشد" }, 400);
    if (!rateLimit(`health-sms:${g.user.id}`, 3, 10 * 60_000).ok) return json({ ok: false, error: "حداکثر ۳ پیامک آزمایشی در ۱۰ دقیقه مجاز است" }, 429);
    const t0 = performance.now();
    const r = await sendSms({ to, text: "پیامک آزمایشی داشبورد سلامت امضاگیر ✅" }, null, g.ctx.workspaceId);
    await auditHealthAction(g.user.id, "health.test_sms", r.ok ? (r.testMode ? "logged" : "sent") : "failed");
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) return json({ ok: false, error: `ارسال ناموفق: ${(r.error || "خطای نامشخص").slice(0, 200)}` });
    if (r.testMode) return json({ ok: false, error: "پنل پیامک تنظیم نیست (حالت آزمایشی)؛ پیامک فقط در لاگ ثبت شد و واقعاً ارسال نشد." });
    return json({ ok: true, message: `پیامک در ${ms} میلی‌ثانیه به پنل تحویل شد؛ دریافت آن را روی گوشی بررسی کنید.` });
  }

  return json({ ok: false, error: "عملیات ناشناخته" }, 400);
}
