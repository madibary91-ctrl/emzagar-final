# رفع ۶ باگ امنیتی سطح High

| شناسه | راه‌حل | فایل‌های اصلی |
|---|---|---|
| SEC-01 | هدر Host/X-Forwarded-Host هرگز خودبه‌خود مورد اعتماد نیست. ترتیب اعتماد: `APP_URL` ← فهرست سفید `TRUSTED_HOSTS` ← (فقط غیر production) loopback. در غیر این صورت مبدأ خالی است و ایمیل‌های توکن‌دار (بازیابی رمز، تأیید ایمیل، دعوت) **بسته شکست می‌خورند** (توکن صادر/ارسال نمی‌شود). نصب‌کننده‌ی وب (پشت کلید نصب) تنها جایی است که از Host «ریشه‌ی اعتماد» می‌سازد. | `src/lib/origin.ts`, `src/lib/request.ts`, `src/modules/api/service.ts`, `src/modules/auth/*` |
| SEC-02 | `TRUSTED_PROXY_HOPS=0` دیگر به ۱ تبدیل نمی‌شود: یعنی هیچ هدر forwarded پذیرفته نمی‌شود (`unknown`). مقدار نامعتبر = ۰. زنجیره‌ی کوتاه‌تر از تعداد پراکسی‌ها و عناصر غیر IP رد می‌شود؛ پورت‌دار (`ip:port`) پشتیبانی می‌شود. | `src/lib/request.ts` |
| SEC-03 | `isLocalSite` دیگر به پروتکل نگاه نمی‌کند (http روی دامنه‌ی عمومی = نیازمند تایید مالکیت دامنه؛ تایید روی http هم ممکن است). حالت Sandbox (سایت واقعاً محلی) روی production خاموش است مگر `ALLOW_SANDBOX_CONNECT=1`؛ سقف روزانه‌ی `SANDBOX_DAILY_CAP` برای اتصال‌های تایید‌نشده. | `src/modules/connect/service.ts` |
| SEC-04 | `safeFetch`: اتصال TCP با `lookup` نگهبان ساخته می‌شود، یعنی **همان resolve که سوکت با آن وصل می‌شود** اعتبارسنجی می‌شود (بین بررسی و استفاده فاصله‌ای نیست؛ rebinding بی‌اثر). همه‌ی fetchهای آدرس‌های کاربر (Push وردپرس، تایید دامنه، وب‌هوک، AI) از آن می‌گذرند. `isPrivateIp` با `net.BlockList` همه‌ی شکل‌های IPv4/IPv6 رزرو را می‌پوشاند. | `src/lib/ssrf.ts` |
| SEC-05 | اعتبارسنج ساختاری PNG: امضا، IHDR، CRC همه‌ی تکه‌ها، ترتیب IDAT/IEND، بایت اضافه، سقف ابعاد/پیکسل و باز کردن IDAT با سقف دقیق `maxOutputLength` (ضد zip-bomb). هم هنگام دریافت و هم قبل از `doc.image` در PDF اعمال می‌شود. | `src/lib/png.ts`, `src/modules/signing/types.ts`, `src/modules/pdf/render.ts` |
| SEC-06 | `ensureClient`: حساب موجود با «فقط ایمیل» هرگز عضو فضای کاری فراخواننده نمی‌شود. یک دعوت «مشتری» برای ایمیل واقعی صاحب حساب ساخته می‌شود و عضویت فقط پس از ورود و پذیرش خودش ثبت می‌شود (ضد اسپم: ۱ دعوت در ساعت). API پاسخ `409 customer_consent_required` می‌دهد و شناسه/داده‌ای از حساب برنمی‌گرداند. | `src/modules/tenancy/service.ts`, `client-consent.ts`, `actions.ts`, `src/app/api/v1/contracts/route.ts` |

آزمون‌های جدید: `tests/unit/security-high.test.ts` و `tests/integration/security-high.test.ts` (آزمون‌های قبلی دست‌نخورده‌اند).
