# معماری ماژولار کد (Domain-Oriented Layout)

این سند نتیجه‌ی بازسازی ساختاری (Refactoring) پروژه است. **رفتار سیستم و منطق کاری بدون هیچ تغییری** حفظ شده؛
فقط فایل‌های سنگین بر اساس دامنه (Domain) به فایل‌های کوچک‌تر شکسته شده‌اند.

## قاعده‌ی طلایی: مسیرهای import تغییر نکرده‌اند

هر فایل سنگین `x.ts` به پوشه‌ی `x/` با یک `index.ts` (Barrel) تبدیل شده است. چون `@/modules/foo/service`
هم به فایل و هم به پوشه‌ی دارای `index.ts` resolve می‌شود، **هیچ import قدیمی و هیچ آزمونی تغییر نکرد**.
`index.ts` فقط نام‌های عمومی قبلی را «صریح» بازصادر می‌کند؛ پس API عمومی هر ماژول یک‌جا و قابل‌ممیزی است
و توابع داخلی (خصوصی) از بیرون دیده نمی‌شوند.

## نقشه‌ی بازسازی

| پیش از این | اکنون | تقسیم بر اساس |
|---|---|---|
| `src/db/schema.ts` (۱۷۸۵ خط، ۸۵ جدول) | `src/db/schema/*.ts` (۲۲ فایل) | دامنه: `identity`, `tenancy`, `contracts`, `negotiation`, `documents`, `collect`, `vault`, `merge`, `ai`, `support`, `chat`, `wordpress`, `billing`, `wallet`, `kyc`, `messengers`, `notifications`, `developer`, `shop`, `health`, `licensing`, `platform` |
| `modules/contracts/service.ts` | `modules/contracts/service/` | `core`, `issue`, `signers`, `query`, `manage`, `reports` |
| `modules/chat/service.ts` | `modules/chat/service/` | `core`, `context`, `conversations`, `requester`, `staff`, `privacy` |
| `modules/pdf/render.ts` | `modules/pdf/render/` | `types`, `layout`, `writer`, `contract`, `overlay`, `certificate` |
| `modules/sync/service.ts` | `modules/sync/service/` | `util`, `connection`, `inbound`, `links`, `outbound`, `overview` |
| `modules/backup/core.ts` | `modules/backup/core/` | `types`, `secrets`, `fs-utils`, `create`, `verify`, `restore` |
| `modules/health/checks-core.ts` | `modules/health/checks-core/` | `util`, `system`, `config`, `ops`, `messaging`, `registry` |
| `modules/health/checks-biz.ts` | `modules/health/checks-biz/` | `payments`, `ai-license`, `growth`, `registry` |
| `modules/identity/service.ts` | `modules/identity/service/` | `core`, `config`, `shahkar`, `documents`, `admin` |
| `modules/install/service.ts` | `modules/install/service/` | `state`, `key`, `status`, `database`, `schema`, `account` |
| `modules/collect/service.ts` | `modules/collect/service/` | `core`, `campaigns`, `submissions`, `exports` |
| `modules/docs/service.ts` | `modules/docs/service/` | `core`, `ingest`, `drafts`, `sources`, `fields`, `compose` |
| `modules/connect/service.ts` | `modules/connect/service/` | `core`, `handshake`, `connections`, `tokens` |
| `modules/license/updater.ts` | `modules/license/updater/` | `paths`, `info`, `package`, `history`, `install` |
| `modules/landing/schema.ts` | `modules/landing/schema/` | `model`, `defs`, `sanitize`, `doc`, `palettes`, `defaults` |
| `modules/messengers/service.ts` | `modules/messengers/service/` | `core`, `bots`, `chats`, `link-codes`, `log` |
| `modules/messengers/bot.ts` | `modules/messengers/bot/` | `texts`, `context`, `commands`, `router` |
| `modules/hub/service.ts` | `modules/hub/service/` | `core`, `features`, `depth`, `pulse`, `customers` |
| `modules/contract-pay/service.ts` | `modules/contract-pay/service/` | `core`, `plans`, `payment`, `receivables`, `reminders` |
| `modules/merge/service.ts` | `modules/merge/service/` | `core`, `batches`, `processing` |
| `modules/ai/knowledge/service.ts` | `modules/ai/knowledge/service/` | `docs`, `stats`, `personalization`, `prompt` |
| `modules/ai/knowledge/text.ts` | `modules/ai/knowledge/text/` | `normalize`, `extract`, `redact`, `chunk`, `style` |
| `components/landing/sections.tsx` | `components/landing/sections/` | `shared`, `hero`, `proof`, `features`, `conversion` |
| `components/HealthDashboard.tsx`، `chat/ChatConsole.tsx`، `landing/editor/LandingEditor.tsx` | پوشه‌ی هم‌نام | کامپوننت اصلی + `format`/`widgets`/`helpers`/`parts`/`constants` |
| `app/contracts/[id]/page.tsx` | `page.tsx` (نمایش) + `load-page-data.ts` (بارگذاری داده) | جداسازی لایه‌ی داده از نمایش |

## قراردادهای ساختاری (برای کد جدید)

1. **سقف اندازه:** هر فایل منطقی ≈ ۳۰۰ خط. از آن بیشتر شد، بر اساس دامنه بشکنید و `index.ts` بسازید.
2. **گراف وابستگی یک‌طرفه:** فایل‌های هر پوشه از «پایه» (`core`/`types`/`util`) به «بالا» (`router`/`registry`) وابسته‌اند.
   وابستگی دوطرفه ممنوع است؛ در صورت نیاز، تابع مشترک را به `core` منتقل کنید (مثال: `chat/service/core.ts`).
3. **وضعیت قابل‌تغییر ماژول (`let`)** باید کنار تمام توابعی بماند که آن را تغییر می‌دهند
   (مثال: `install/service/state.ts` شامل `installedMemo` و `finalizeInstall`)، چون ES Module اجازه‌ی assign به import را نمی‌دهد.
4. **ماژول‌های mock‌شده در آزمون‌ها** (`branding/service`, `platform/admin`, `auth/session`, `lib/config`, `lib/ssrf`) عمداً شکسته نشدند.
5. **فایل‌های `"use server"`** (`actions.ts`) شکسته نشدند؛ Next.js اجازه‌ی `export … from` در آن‌ها را نمی‌دهد.
   در فایل‌های `"use client"` دستور در تک‌تک فایل‌های جدید و `index.ts` تکرار شده است.
6. **schema دیتابیس:** مسیر `drizzle.config.json` اکنون `./src/db/schema/index.ts` است.
   خروجی DDL نصب‌کننده (`src/db/ddl.ts`) پیش و پس از بازسازی **بایت‌به‌بایت یکسان** راستی‌آزمایی شد
   (۸۵ جدول، همه‌ی ایندکس‌ها و Foreign Keyها). جدول جدید → فقط `export const` در فایل دامنه‌ی مربوط (barrel این پوشه عمداً `export *` است تا هیچ جدولی از DDL نصب‌کننده جا نماند)؛ برای «فایل دامنه‌ی تازه» یک خط `export * from "./نام"` به `schema/index.ts` اضافه کنید.
   ارجاع‌های متقابل جدول‌ها با `() => table.col` تنبل‌اند، پس وابستگی دوری بین فایل‌های schema (مثلاً `contracts` ↔ `shop`) ایمن است.
