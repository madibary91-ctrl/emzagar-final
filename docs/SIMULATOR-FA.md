# شبیه‌ساز سرویس‌های بیرونی (Simulator)

یک «بازیگر نقش» برای سه سرویس بیرونی سیستم — **درگاه پرداخت زرین‌پال، پنل پیامک (کاوه‌نگار و ملی‌پیامک) و هوش مصنوعی GapGPT** —
تا بتوانید بدون اینترنت، بدون هزینه و بدون ارسال پیامک واقعی، **هر اتفاقی** را (موفقیت، قطعی، کندی، پاسخ خراب، کمبود موجودی، حمله) به‌صورت خودکار و قابل‌تکرار بسازید و واکنش سیستم را بسنجید.

> شبیه‌ساز فقط برای **تست و توسعه** است. در production متغیر `EXTERNAL_SIM_URL` را خالی بگذارید.

---

## ۱) شروع سریع (۳۰ ثانیه)

```bash
# ترمینال ۱: شبیه‌ساز
npx tsx simulator/cli.ts --port 4010
#   داشبورد:  http://127.0.0.1:4010/__sim/ui

# ترمینال ۲: برنامه، وصل به شبیه‌ساز
EXTERNAL_SIM_URL=http://127.0.0.1:4010 npm run dev
```

از این لحظه **هیچ تماس واقعی** به زرین‌پال، کاوه‌نگار، ملی‌پیامک یا GapGPT نمی‌رود (حتی اگر آدرس سرویس هوش مصنوعی در تنظیمات، آدرس واقعی باشد).
در داشبورد می‌توانید با چند کلیک سناریو را عوض کنید، پیامک‌های ارسال‌شده و کد OTP را ببینید و پرداخت‌ها را دستی نهایی کنید.

| گزینه‌ی خط فرمان | توضیح |
|---|---|
| `--port 4010` | پورت (پیش‌فرض ۴۰۱۰) — معادل `SIM_PORT` |
| `--host 0.0.0.0` | برای docker؛ پیش‌فرض `127.0.0.1` — معادل `SIM_HOST` |
| `--startpay auto\|manual` | `auto`: صفحه‌ی پرداخت فوری «موفق» برمی‌گردد (مناسب ربات). `manual`: کاربر روی دکمه کلیک می‌کند (پیش‌فرض) |
| `--seed 7` | seed آشوب برای تکرارپذیری کامل |
| `--token s3cret` | محافظت پنل کنترل با هدر `x-sim-token` |
| `--preset total-outage` | شروع با یک پیش‌تنظیم |
| `--scenario zarinpal=service_down` | سناریوی اولیه (قابل تکرار) |
| `--quiet` | بدون لاگ درخواست‌ها |

---

## ۲) متغیرهای محیطی برنامه

| متغیر | کار |
|---|---|
| `EXTERNAL_SIM_URL` | آدرس شبیه‌ساز؛ **تنها کلید روشن‌کردن**. فقط `localhost` و IPهای خصوصی پذیرفته می‌شود (برای جلوگیری از ارسال کلید واقعی به میزبان ناشناس) |
| `EXTERNAL_SIM_ALLOW_REMOTE=1` | پذیرفتن میزبان غیرمحلی (مثلاً سرویس docker با نام `sim`) |
| `EXTERNAL_SIM_PUBLIC_URL` | آدرسی که **مرورگر** برای صفحه‌ی پرداخت می‌بیند، اگر با آدرس سرور‌به‌سرور فرق دارد (docker) |
| `EXTERNAL_TIMEOUT_SCALE=0.02` | مهلت تماس‌های بیرونی را کوتاه می‌کند (فقط در حالت شبیه‌ساز)؛ آزمون «بی‌پاسخ ماندن» به‌جای ۱۱۰ ثانیه ۲ ثانیه طول می‌کشد |
| `ZARINPAL_MERCHANT_ID` | لازم نیست؛ بدون آن یک مرچنت ساختگی خودکار استفاده می‌شود |

نشانه‌ها که شبیه‌ساز فعال است: لاگ راه‌اندازی برنامه (`[simulator] ⚠️ …`) و فیلد `simulator` در `GET /api/health`.
پرداخت‌های شبیه‌ساز با `gateway=sandbox` ثبت می‌شوند و **هرگز در «درآمد پلتفرم» شمرده نمی‌شوند**.

---

## ۳) معماری

```
 برنامه (Next.js)                         شبیه‌ساز (simulator/)
 ┌────────────────────┐   HTTP    ┌──────────────────────────────────────────┐
 │ billing / sms / ai │ ───────►  │ /zarinpal/...  /kavenegar/...            │
 │ risk (via          │           │ /melipayamak/...  /gapgpt/v1/...         │
 │ src/lib/external)  │ ◄───────  │  ├─ موتور سناریو (صف، فاز، chaos، …)       │
 └────────────────────┘           │  ├─ وضعیت: تراکنش‌ها، اعتبار، صندوق پیامک   │
        ▲                          │  └─ لاگ درخواست‌ها                        │
        │ SimClient (fetch)        │ /__sim/*  پنل کنترل JSON  +  /__sim/ui    │
 Vitest / Playwright ────────────► └──────────────────────────────────────────┘
```

* `src/lib/external.ts` تنها نقطه‌ی اتصال برنامه است: اگر `EXTERNAL_SIM_URL` باشد، آدرس هر سرویس را به شبیه‌ساز تغییر می‌دهد؛ وگرنه کاملاً بی‌اثر است.
* شبیه‌ساز **هیچ کدی از برنامه را import نمی‌کند** و فقط ماژول‌های Node را به‌کار می‌برد (بدون وابستگی تازه).
* شبیه‌ساز **حالت‌دار** است (نه یک mock ثابت): تراکنش واقعاً ساخته و verify می‌شود، اعتبار پیامک کم می‌شود، پیامک‌ها در صندوق می‌مانند.

---

## ۴) موتور سناریو

هر درخواست به سرویس، یک «سناریو» می‌گیرد. اولویت (قوی ← ضعیف):

1. **هدر** `x-sim-scenario: name` روی همان درخواست
2. **کلید جادویی**: پسوند `~سناریو` در API key / رمز عبور (مثلاً کلید پیامک `KN-KEY~insufficient_credit`) — بدون تماس با پنل کنترل، فقط همان فضای کاریِ دارای آن کلید خراب می‌شود
3. **صف** (`queue`): سناریوهای یک‌بارمصرف؛ هر درخواست مناسب، اولین مورد صف را برمی‌دارد
4. **سناریوی پیش‌فرض** سرویس (`scenario`) تا ریست بعدی

### قالب نام سناریو
| قالب | معنی |
|---|---|
| `name` | سناریوی ساده، مثل `service_down` |
| `name:arg` | با پارامتر، مثل `slow:3000` ، `flaky:40` ، `nth:3` ، `rpm:2` |
| `phase@name` | **فقط روی یک مرحله** اثر دارد؛ مثل `verify@service_down` (پرداخت شروع می‌شود ولی تایید قطع است) |

فازها: زرین‌پال `request | verify | unverified | startpay` · کاوه‌نگار `send | lookup | status | account` · ملی‌پیامک `send` · GapGPT `models | chat`.

### سناریوهای مشترک (شبکه) — برای هر چهار سرویس
| سناریو | رفتار |
|---|---|
| `network_error` | سوکت بدون پاسخ بسته می‌شود (ECONNRESET) |
| `timeout[:ms]` | اتصال باز و بدون پاسخ تا کلاینت مهلتش را تمام کند |
| `service_down` | HTTP 503 با صفحه‌ی HTML nginx |
| `bad_gateway` | HTTP 502 |
| `garbage_response` | HTTP 200 ولی HTML به‌جای JSON |
| `empty_response` | HTTP 200 با بدنه‌ی خالی |
| `truncated_response` | نیمه‌ی JSON و سپس قطع اتصال |
| `redirect` | 302 به دامنه‌ی خارجی (برنامه نباید دنبال کند) |
| `slow:ms` | پاسخ موفق، ولی با تاخیر |
| `flaky:درصد` | با احتمال مشخص یکی از خطاهای شبکه |
| `nth:N` | هر N‌امین درخواست ۵۰۳ |
| `chaos:درصد` | با احتمال مشخص یکی از **همه‌ی** خطاهای ممکن آن سرویس؛ با `seed` ثابت **کاملاً تکرارپذیر** |

### زرین‌پال
| سناریو | فاز | کد/رفتار |
|---|---|---|
| `invalid_merchant` | request | `-9` اعتبارسنجی (HTTP 400) |
| `ip_blocked` | request | `-10` |
| `merchant_inactive` | request | `-11` |
| `too_many_requests` | request | `-12` |
| `terminal_suspended` | request | `-15` |
| `authority_malformed` | request | `code=100` با authority خراب (حمله/باگ) |
| `user_cancel` | startpay | انصراف کاربر (`Status=NOK`) |
| `bank_failure` | startpay | خطای بانک (`Status=NOK`) |
| `fake_ok_unpaid` | startpay | **حمله**: `Status=OK` بدون پرداخت |
| `callback_dropped` | startpay | پول کسر شد ولی کاربر به سایت برنگشت |
| `verify_not_paid` | verify | `-51` |
| `amount_mismatch` | verify | `-50` |
| `session_invalid` | verify | `-54` |
| `already_verified` | verify | `101` (باید موفق تلقی شود) |
| `merchant_inactive_on_verify` | verify | `-11` (خطای غیرقطعی؛ تراکنش نباید «ناموفق» شود) |

رفتار پایه‌ی واقعی: اعتبارسنجی (`merchant_id` UUID، مبلغ ≥ ۱۰۰۰ ریال، `callback_url` معتبر)، تایید با مقایسه‌ی مبلغ و مرچنت، verify تکراری → `101`، verify پرداخت‌نشده → `-51`.

### کاوه‌نگار
`invalid_api_key`(403) · `account_disabled`(401) · `insufficient_credit`(418) · `invalid_receptor`(411) · `invalid_sender`(412) · `line_denied`(407) · `template_not_found`(424) · `template_bad_structure`(431) · `ip_not_allowed`(416) · `rate_limited`(451) · `test_account_limit`(501) · **`http200_failure`** (HTTP 200 ولی `return.status=418`) · `delivery_failed` (ارسال موفق، تحویل ناموفق).
حالت‌داری: اعتبار پنل (`PUT /__sim/kavenegar/credit`) با هر پیامک کم می‌شود و در صفر شدن خودکار `418` می‌دهد. کلید دارای `invalid` ← `403`. فاصله در `token` ← `432`.

### ملی‌پیامک
ملی‌پیامک همیشه HTTP 200 می‌دهد و خطا را در `Value` می‌گذارد: `bad_credentials`(0) · `insufficient_credit`(2) · `daily_limit`(3) · `invalid_sender`(5) · `system_update`(6) · `filtered_text`(7) · `inactive_user`(10) · `blacklisted`(35) · `empty_value`.
موفقیت = `RetStatus=1` و `Value` عدد بلند (recId).

### GapGPT (سازگار با OpenAI)
`invalid_key`(401) · `forbidden`(403) · `rate_limit`(429+Retry-After) · `quota_exceeded`(429) · `server_error`(500) · `overloaded`(503) · `model_not_found`(404) · `context_length`(400) · `bad_request`(400) · `empty_content` · `null_content` · `no_choices` · `content_filter` · `short_reply` · `markdown_fenced` (```html) · **`xss_payload`** (script/onerror/iframe در خروجی) · `bad_json` · `risk_wrapped_json` · `no_models_endpoint` · `models_empty` · `rpm:N` (سقف درخواست در دقیقه به‌ازای هر کلید).
پاسخ موفق «هوشمند» است: قرارداد HTML (با متغیرهای `[KEY]` استخراج‌شده از پرامپت سیستمی)، بازنویسی متن، یا تحلیل ریسک JSON. `stream:true` هم (SSE) پشتیبانی می‌شود.

### پیش‌تنظیم‌ها (Presets)
`happy` · `total-outage` · `network-chaos` · `flaky` · `slow` · `payments-down` · `verify-outage` · `no-sms-credit` · `ai-rate-limited` · `ai-hostile` — با `POST /__sim/preset/:name` یا دکمه‌های داشبورد.

---

## ۵) پنل کنترل (JSON API)

همه زیر `/__sim` و پاسخ‌ها JSON (به‌جز `ui`). اگر `--token` داده شده باشد، هدر `x-sim-token` لازم است (به‌جز `health` و `ui`).

| متد و مسیر | کار |
|---|---|
| `GET /__sim/health` | سلامت |
| `GET /__sim/state` | سناریوها، صف‌ها، اعتبار، شمارنده‌ها |
| `GET /__sim/scenarios` | فهرست کامل سناریوها و پیش‌تنظیم‌ها (با توضیح) |
| `PUT /__sim/scenario/:service` | `{scenario, latencyMs?}` سناریوی پیش‌فرض |
| `POST /__sim/queue/:service` | `{scenarios:[…]}` یا `{scenario, times}`؛ `DELETE` صف را پاک می‌کند |
| `POST /__sim/preset/:name` | اعمال پیش‌تنظیم |
| `POST /__sim/reset[?service=]` | پاک‌سازی وضعیت، لاگ، تراکنش‌ها و پیامک‌ها |
| `PUT /__sim/settings` | `{startPay: "auto"\|"manual", seed}` |
| `GET /__sim/requests` | لاگ درخواست‌ها؛ فیلتر `service` `phase` `since` `limit` |
| `GET /__sim/sms[?to=&provider=]` | صندوق پیامک |
| `GET /__sim/sms/last?to=` | آخرین پیامک و `code` (کد OTP استخراج‌شده) |
| `PUT /__sim/kavenegar/credit` / `melipayamak/credit` | `{value}` |
| `PUT /__sim/kavenegar/templates` | `{names:[…]}` فقط این قالب‌ها پذیرفته می‌شوند (وگرنه ۴۲۴) |
| `GET /__sim/zarinpal/payments[/:authority]` | تراکنش‌ها |
| `POST /__sim/zarinpal/payments/:authority/settle` | `{outcome: success\|cancel\|fail\|fake_ok, follow?}` مثل کاربر در صفحه‌ی بانک |

---

## ۶) استفاده در تست

### Vitest (بدون سرور جدا؛ شبیه‌ساز داخل همان پردازه)
```ts
import { SimClient, startSimulator } from "../../simulator";

beforeAll(async () => {
  sim = await startSimulator({ port: 0, quiet: true, startPay: "auto" });
  c = new SimClient(sim.url);
  process.env.EXTERNAL_SIM_URL = sim.url;
  process.env.EXTERNAL_TIMEOUT_SCALE = "0.02";
});
beforeEach(() => c.reset());

it("قطعی هنگام تایید پرداخت", async () => {
  await c.queue("zarinpal", ["success", "verify@service_down"]);   // شروع موفق، تایید قطع
  const url = await startCheckout({ … });
  await fetch(url, { redirect: "manual" });                         // مثل مرورگر کاربر
  expect((await verifyPayment(authority, "OK")).ok).toBe(false);
  // …پولِ کسرشده نباید «failed» شود
});

it("OTP از صندوق پیامک", async () => {
  await sendSms({ to, token: "482913", text: "…" }, null, ws);
  expect((await c.lastSms(to)).code).toBe("482913");
});
```
نمونه‌ی کامل: `tests/integration/external-services.test.ts` (واکنش برنامه) و `tests/integration/simulator.test.ts` (دقت خودِ شبیه‌ساز).

### Playwright (ربات مرورگری)
`npx tsx scripts/e2e.ts` خودکار شبیه‌ساز را بالا می‌آورد، سرور برنامه را به آن وصل می‌کند و `E2E_SIM_URL` را برای آزمون‌ها می‌گذارد.
در آزمون‌ها: `import { needSim } from "./lib/sim"` سپس `await needSim().scenario("zarinpal", "user_cancel")`. نمونه: `e2e/08-simulator.spec.ts` ([S1] پرداخت، [S2] هوش مصنوعی).
گزارش فارسی اجرا در `e2e/report/REPORT-FA.md` شامل جدول ترافیک شبیه‌ساز است و همه‌ی درخواست‌ها در `e2e/report/simulator-requests.json`.

| دستور | کار |
|---|---|
| `npx tsx scripts/e2e.ts` | همه‌چیز: Vitest + Playwright با شبیه‌ساز |
| `npx tsx scripts/e2e.ts --skip-unit -- 08-simulator` | فقط آزمون‌های شبیه‌ساز |
| `npx tsx scripts/e2e.ts --no-sim` | بدون شبیه‌ساز (رفتار قدیمی؛ آزمون‌های `S*` رد می‌شوند) |
| `E2E_SIM_PORT=4200` | پورت شبیه‌ساز در اجرای E2E (پیش‌فرض ۴۱۱۰) |

### اجرای دستی با ربات
```bash
npx tsx simulator/cli.ts --port 4110 --startpay auto &
E2E_SIM_URL=http://127.0.0.1:4110 E2E_BASE_URL=http://127.0.0.1:3100 npx playwright test e2e/08-simulator.spec.ts
```

---

## ۷) نکات رفتاری که شبیه‌ساز در برنامه اصلاح کرد

شبیه‌ساز در همان اجرای اول چند ضعف واقعی را نشان داد که رفع شد:

1. **تایید پرداخت و قطعی موقت درگاه:** قبلاً هر خطای verify تراکنش را برای همیشه «ناموفق» می‌کرد، حتی اگر پول کسر شده بود. اکنون فقط پاسخ **قطعی** درگاه (`-50 -51 -53 -54`) آن را رد می‌کند؛ قطعی شبکه/۵xx/پاسخ نامعتبر/خطای مرچنت تراکنش را `pending` با نشانه‌ی `verify_pending` نگه می‌دارد و زمان‌بند داخلی و `/api/cron/run` آن را دوباره تایید می‌کنند (`reconcilePendingPayments`).
2. **ملی‌پیامک:** پاسخ HTTP 200 همیشه «موفق» حساب می‌شد؛ در حالی‌که خطاها (اعتبار کم، رمز اشتباه، …) با HTTP 200 می‌آیند. اکنون `RetStatus` و recId بررسی می‌شود.
3. **کاوه‌نگار:** فقط کد HTTP بررسی می‌شد؛ اکنون `return.status` خوانده و هر کد به پیام فارسی روشن تبدیل می‌شود.
4. **پیام خطای شبکه:** «fetch failed» یا «Unexpected token <» خام به کاربر نشان داده می‌شد؛ اکنون پیام فارسی (قطع اتصال / مهلت تمام شد / پاسخ نامعتبر).
5. **ریدایرکت‌های سرویس پیامک** دیگر دنبال نمی‌شود (`redirect: "error"`).
6. **درآمد پلتفرم** تراکنش‌های `sandbox` (شبیه‌ساز و درگاه آزمایشی) را نمی‌شمارد.

---

## ۸) عیب‌یابی

| مشکل | علت/راه‌حل |
|---|---|
| برنامه هنوز به اینترنت می‌رود | `/api/health` را ببینید: اگر `simulator: null` است، `EXTERNAL_SIM_URL` تنظیم نشده یا میزبان غیرمحلی است (`EXTERNAL_SIM_ALLOW_REMOTE=1`) |
| `404 مسیر در شبیه‌ساز پیاده‌سازی نشده` | برنامه مسیری را صدا زده که شبیه‌ساز ندارد؛ لاگ شبیه‌ساز مسیر دقیق را نشان می‌دهد |
| صفحه‌ی پرداخت در docker باز نمی‌شود | `EXTERNAL_SIM_PUBLIC_URL` را روی آدرسی بگذارید که مرورگر می‌بیند |
| تست «بی‌پاسخ ماندن» خیلی کند است | `EXTERNAL_TIMEOUT_SCALE=0.02` |
| سناریو به‌جای سرویس دیگر اثر می‌کند | سناریوها به‌ازای هر سرویس جدا هستند؛ `GET /__sim/state` را ببینید و در تست `c.reset()` بزنید |
| آشوب هر بار فرق می‌کند | `--seed` ثابت بدهید یا `PUT /__sim/settings {seed}` |
