export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // H-04: آدرس واقعی سوکت (غیرقابل جعل) برای شناسایی IP کلاینت و محدودکننده‌ی نرخ
    try {
      const { installPeerIpStamp } = await import("@/lib/peer-ip");
      installPeerIpStamp();
    } catch (e) {
      console.error("[boot:peer-ip]", e instanceof Error ? e.message : e);
    }
    const { simulatorUrl } = await import("@/lib/external");
    const sim = simulatorUrl();
    if (sim) console.warn(`[simulator] ⚠️ پرداخت، پیامک و هوش مصنوعی به شبیه‌ساز ${sim.origin} وصل‌اند (هیچ سرویس واقعی فراخوانی نمی‌شود). در محیط واقعی EXTERNAL_SIM_URL را خالی بگذارید.`);
    else if (process.env.EXTERNAL_SIM_URL) console.warn("[simulator] EXTERNAL_SIM_URL نادیده گرفته شد: آدرس نامعتبر است یا میزبان محلی نیست (برای میزبان غیرمحلی EXTERNAL_SIM_ALLOW_REMOTE=1).");
    // هشدار پیکربندی‌های خطرناک در production: این پرچم‌ها فقط برای توسعه/دمو هستند
    if (process.env.NODE_ENV === "production") {
      // M-06: پرچم‌های توسعه/دمو در production = راه‌اندازی ممنوع (fail-closed)، نه فقط هشدار
      const { assertSafeDevFlags } = await import("@/lib/dev-flags");
      assertSafeDevFlags();
      const risky: [string, string][] = [
        ["ALLOW_DEV_OTP", "کدهای OTP و تأیید ایمیل در پاسخ سرور نمایش داده می‌شود (دور زدن کامل احراز هویت دوعاملی)"],
        ["ALLOW_DEMO_PAYMENTS", "پرداخت آزمایشی فعال است و اشتراک پولی بدون پرداخت واقعی فعال می‌شود"],
        ["SEED_DEMO", "داده‌ی نمایشی و حساب‌های دمو ساخته می‌شود"],
        ["SKIP_EMAIL_DOMAIN_CHECK", "بررسی دامنه‌ی ایمیل هنگام ثبت‌نام غیرفعال است"],
      ];
      for (const [k, why] of risky) if (process.env[k] === "1") console.warn(`[security] ⚠️ ${k}=1 در محیط production روشن است: ${why}. آن را خاموش کنید.`);
      if (process.env.REQUIRE_EMAIL_VERIFICATION === "0") console.warn("[security] ⚠️ REQUIRE_EMAIL_VERIFICATION=0: مالکیت ایمیل ثبت‌نام‌کنندگان تأیید نمی‌شود.");
      const { trustedAppOrigin } = await import("@/lib/config");
      if (!trustedAppOrigin()) console.warn("[security] ⚠️ APP_URL تنظیم نشده است؛ لینک‌های توکن‌دار ایمیل (بازیابی رمز، تأیید ایمیل، دعوت) ساخته/ارسال نمی‌شوند. APP_URL را به آدرس HTTPS سایت مقدار دهید (یا TRUSTED_HOSTS را بدهید).");
    }
    // ارتقای خودکار ساختار دیتابیس (ایدمپوتنت): نسخه‌های جدید بدون اجرای دستی مهاجرت بالا می‌آیند
    try {
      const { isInstalled, applySchema } = await import("@/modules/install/service");
      if (await isInstalled()) await applySchema();
    } catch (e) {
      console.error("[boot:schema]", e instanceof Error ? e.message : e);
      // DB-05: schema ناقص = fail-closed. در production اجرای برنامه با ساختار نیمه‌کاره (و بی‌صدا) ممنوع است؛
      // ری‌استارت/هشدار ارکستراتور بهتر از خطاهای پراکنده‌ی «ستون وجود ندارد» در زمان اجرا است.
      if (process.env.NODE_ENV === "production" && e instanceof Error && e.name === "SchemaApplyError") throw e;
    }
    // PERF-03: پردازشگر صف کارها (PDF، ایمیل، اعلان، پاک‌سازی فایل)؛ کارهای مانده از ری‌استارت قبلی ادامه می‌یابند
    try {
      const { startJobWorker } = await import("@/modules/jobs/queue");
      startJobWorker();
    } catch (e) {
      console.error("[boot:jobs]", e instanceof Error ? e.message : e);
    }
    const { startScheduler } = await import("@/modules/automation/scheduler");
    startScheduler();
    // ربات‌های پیام‌رسان در حالت Polling (تلگرام/بله)
    try {
      const { startMessengerPoller } = await import("@/modules/messengers/poller");
      startMessengerPoller();
    } catch (e) {
      console.error("[boot:messengers]", e instanceof Error ? e.message : e);
    }
  }
}
