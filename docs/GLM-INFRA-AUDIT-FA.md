# ممیزی زیرساخت و استقرار (GLM Infrastructure Audit) — بررسی و رفع

دامنه: `package.json`، Docker/Compose، Caddy، اسکریپت‌های `scripts/*.sh`، بک‌آپ داخلی (`src/modules/backup`)، CI و مستندات استقرار.
روش: هر ادعا ابتدا «روی کد واقعی بازتولید» شد (نه فقط خواندن)، سپس رفع و با خودآزمون/ساخت واقعی راستی‌آزمایی شد.
قانون تست‌ها رعایت شد: **هیچ تست موجودی تغییر نکرد** (فقط ابزار و خودآزمون تازه افزوده شد).

## جدول حکم‌ها

| شناسه | حکم | خلاصه‌ی یافته | رفع |
|---|---|---|---|
| INF-01 | ✅ واقعی (بحرانی) | `scripts` فقط ۵ مورد پایه داشت؛ `npm test`، `npm run backup/restore`، `plugin:*`، `test:e2e`، `test:qa`، `qa:*`، `db:check` در CI/مستندات/اسکریپت‌ها استفاده می‌شدند ولی تعریف نبودند (CI همان لحظه می‌شکست). | ۳۴ اسکریپت تعریف شد (با `npm pkg set`، دقیقاً مطابق ارجاع‌های موجود) + نگهبان `infra:check` که هر «npm run X» در README/docs/CI/scripts/src را با package.json تطبیق می‌دهد. |
| INF-02 | ✅ واقعی (بحرانی) | `package-lock.json` نبود؛ Dockerfile عمداً در این حالت `npm install` آزاد می‌کرد ⇒ ساخت غیرتکرارپذیر. | lock تولید و commit‌شدنی شد (۶۳۶ بسته، همه با `resolved` و هش). Dockerfile اکنون `npm ci` را **اجباری** می‌کند (بدون lock خطای روشن؛ فقط با `--build-arg ALLOW_UNLOCKED_INSTALL=1` اضطراری) + `NPM_REGISTRY` برای میرور ایران (npm آدرس resolved را خودکار به میرور بر می‌گرداند) + retry شبکه. CI از `npm ci` استفاده می‌کند. |
| INF-03 | ✅ واقعی (بحرانی) | **بازتولید شد:** با نسخه‌ی قبل و رمز فقط در `.env` (حالت cron) خروجی `No environment variable BACKUP_PASSPHRASE` و یک فایل `storage-*.enc` **صفر بایتی** باقی می‌ماند و اسکریپت خارج می‌شد. (نکته: اگر کاربر رمز را `export` می‌کرد کار می‌کرد؛ اما مسیر اصلی/نصب‌شده همین cron است.) هم‌ریشه: `BACKUP_MIRROR` هم فقط از محیط خوانده می‌شد، درحالی‌که راهنمای نصب می‌گفت در `.env` بگذارید. | `scripts/lib/common.sh`: خواندن امن `.env` (بدون `source`؛ CR و نقل‌قول پاک می‌شود)، `export BACKUP_PASSPHRASE`، `BACKUP_KEEP/BACKUP_MIRROR` هم از `.env`. فایل‌ها ابتدا `.partial` و پس از راستی‌آزمایی با `mv` اتمی نهایی می‌شوند. `flock` برای جلوگیری از اجرای هم‌زمان. |
| INF-04 | ✅ واقعی | `email {$ACME_EMAIL}` با مقدار خالی ⇒ دستور `email` بدون آرگومان ⇒ Caddy بالا نمی‌آید؛ compose هم `${ACME_EMAIL:-}` می‌گذاشت و install-vps ایمیل را اختیاری می‌دانست. | `ACME_EMAIL` در compose با `:?` اجباری (خطای همان لحظه‌ی `config`)، install-vps ایمیل را اجباری/اعتبارسنجی می‌کند (تعاملی می‌پرسد؛ `@example.com` را رد می‌کند؛ `.env`ِ نصب‌های قدیمی را اصلاح می‌کند)، `vps-update.sh` هم پیش از به‌روزرسانی بررسی می‌کند. (گزینه‌ی «ایمیل پیش‌فرض ساختگی» رد شد: Let's Encrypt دامنه‌های بدون MX را رد می‌کند.) |
| INF-05 | ✅ واقعی | راهنما `storage-زمان.tar.gz` و `gunzip -c … \| tar` می‌گفت؛ فایل واقعی `.tar.gz.enc` رمزنگاری‌شده است ⇒ دستور مستند خطا می‌داد (در لحظه‌ی بحران!). همچنین `DROP DATABASE` بدون ایمنی. | بخش «۶» راهنما بازنویسی شد (فرمت‌ها، رمزگشایی با `openssl`، سنجش پیش از بازیابی). **بهتر از ویرایش مستندات:** اسکریپت جدید `scripts/vps-restore.sh` (بازیابی در پایگاه موقت و جایگزینی اتمی، نسخه‌ی اضطراری پیش از جایگزینی، توقف پیش از هر تغییر با رمز غلط، پذیرش فرمت‌های قدیمی). |
| INF-06 | ✅ واقعی + یافته‌ی بیشتر | `FILE_DIRS` فاقد `sources` (Word/PDF بارگذاری‌شده) و `landing` بود ⇒ پس از بازیابی ردیف‌های دیتابیس به فایل‌های گم‌شده اشاره می‌کردند. **GLM یک مورد را از قلم انداخت:** `branding` (لوگو) هم نبود و بدتر، با `process.cwd()/storage` نوشته می‌شد نه `STORAGE_DIR` (با مسیر سفارشی خارج از هر بک‌آپی می‌افتاد). (بک‌آپ شبانه‌ی bash کل `storage` را tar می‌کند، پس آنجا مشکل نداشت.) | سه پوشه به `FILE_DIRS` افزوده شد؛ branding به `STORAGE_DIR` رفت. نگهبان `infra:check` هر پوشه‌ی جدیدِ `storage/<x>` در سورس را که در FILE_DIRS نباشد گزارش می‌کند. تست‌های موجود بک‌آپ بدون تغییر سبزند (storage آن‌ها موقتی است). |
| INF-07 | ✅ واقعی (با اصلاح پیش‌فرض ادعا) | ادعا «COPY . . فایل‌های تست را در ایمیج می‌برد» دقیق نیست: مرحله‌ی نهایی فقط `standalone` را کپی می‌کند. **اما در عمل بدتر بود:** ساخت واقعی `EMZ_STANDALONE=1` نشان داد خروجی standalone به‌خاطر `fs` پویا در `src/lib/wp-release.ts` «کل ریشه‌ی پروژه» را رد‌یابی می‌کند (هشدار Turbopack) ⇒ `e2e/ qa/ tests/ docs/ scripts/ simulator/ SECURITY-AUDIT.md` واقعاً داخل ایمیج نهایی بودند. (`outputFileTracingExcludes` در Turbopack اثر نداشت؛ آزموده و کنار گذاشته شد.) | `.dockerignore` بازنویسی شد؛ چون `tsconfig.json` همه‌ی `**/*.ts` (e2e/qa/…) را تایپ‌چک می‌کند، `tsconfig.build.json` (فقط `src`) برای ساخت Docker افزوده شد (`EMZ_TSCONFIG`) — ساخت واقعی با context حذف‌شده موفق بود؛ در Dockerfile یک مرحله‌ی prune دفاع در عمق است؛ CI یک job «docker» دارد که وجود این مسیرها در ایمیج را رد می‌کند. |
| INF-08 | ✅ واقعی | هیچ `logging` ⇒ لاگ json-file نامحدود؛ هیچ سقف منابع. | `x-logging` (۵×۱۰MB، فشرده) برای همه‌ی سرویس‌ها؛ `mem_limit` برای app/db/caddy (قابل تنظیم با `APP_MEM_LIMIT/DB_MEM_LIMIT/CADDY_MEM_LIMIT`)، `NODE_OPTIONS=--max-old-space-size` کمی کمتر از سقف، `pids_limit`، `init: true`، `no-new-privileges`، `cap_drop: ALL` برای app. |
| INF-10 | ✅ واقعی (بهبود) | SQL ساده: بازیابی غیرتراکنشی/غیرانتخابی، بدون راستی‌آزمایی ساختاری. | `pg_dump -Fc -Z 6` ⇒ `db-*.dump`؛ راستی‌آزمایی با `pg_restore --list`؛ بازیابی با `--single-transaction --exit-on-error`. نگهداری/mirror فرمت قدیمی را هم می‌شناسد. |
| INF-11 | ✅ واقعی | `ARG LICENSE_PUBLIC_KEY` در Dockerfile همیشه خالی می‌ماند چون compose `args` نمی‌داد. | `build.args` در هر دو compose؛ نگهبان: هر ARG تعریف‌شده در Dockerfile باید در compose پاس داده شود. راهنما: پس از افزودن کلید `up -d --build`. |
| INF-12 | ⚠️ نیمه‌درست | `vps-backup.sh` اصلاً `curl` به کار نمی‌برد (ادعای curl نادرست؛ curl فقط در install-vps است). `rsync` درست است ولی فقط وقتی `BACKUP_MIRROR` تنظیم باشد. | پیش‌بررسی `docker/compose/openssl/gzip/tar` پیش از هر کاری؛ نبود `rsync` با mirror ⇒ هشدار از ابتدا، بک‌آپ محلی ساخته می‌شود و در پایان کد خروج ۲. install-vps ابزارها (`openssl curl rsync cron`) را نصب می‌کند. |
| INF-13 | ✅ واقعی | `backups/` در `.gitignore` و `.dockerignore` نبود. همچنین `.env.production`/`.env.local` و `*.pem` هم ignore نبودند. | `backups/`، الگوهای `*.dump/*.sql.gz/*.tar.gz.enc`، `.env.*` (به‌جز نمونه‌ها)، `*.pem` در هر دو. |

## INF-09 / INF-14 / INF-15 / INF-16 («انتخاب طراحی / باگ نیست»)

متن این چهار مورد در درخواست نبود؛ بنابراین نمی‌توان ادعا کرد «همان مورد با همان شناسه» بررسی شد. به‌جایش **همه‌ی نامزدهای محتمل لایه‌ی زیرساخت** از نو ممیزی شد. نتیجه:

**پذیرفتن «انتخاب طراحی» (بدون تغییر، با دلیل):**
- `docker-compose.yml` (توسعه/نصب سریع) پورت ۳۰۰۰ را روی همه‌ی اینترفیس‌ها باز می‌کند و رمز پیش‌فرض دیتابیس دارد: مسیر «نصب با یک دستور و باز کردن IP:3000» است؛ دیتابیس هرگز publish نمی‌شود و `TRUSTED_PROXY_HOPS=0` هدرهای جعلی را نادیده می‌گیرد. تولید فقط با `docker-compose.prod.yml` (رمز اجباری، فقط Caddy بیرونی). در راهنما صریح آمده است.
- ابزار تست (`vitest`, `tsx`, `playwright`) در `dependencies` است: `scripts/*.ts` و بسته‌ی فروش (`build-release.mjs`) در محیط بدون devDependencies هم اجرا می‌شوند؛ جابه‌جایی ریسک شکستن بسته‌ی فروش دارد و سود ناچیزی (چون ایمیج standalone است).
- `HEALTHCHECK` با `wget` (busybox در alpine)، مالکیت volumeها (پوشه‌ها در ایمیج با `chown app` ساخته می‌شوند و volume نام‌دار آن را به ارث می‌برد)، `flush_interval -1` برای SSE و `max_size 60MB` در Caddy: درست‌اند.

**باگ‌های واقعی دیگری که در همین ممیزی یافته و رفع شد (برچسب EXTRA چون شناسه‌ی GLM ندارند):**
1. `vps-update.sh` هنگام اجرا فایل خودش را (با جایگزینی کد) روی دیسک عوض می‌کرد؛ bash اسکریپت را تدریجی می‌خواند ⇒ ادامه از آفست اشتباه. اکنون همه‌چیز در `main()` و فراخوانی با `exit` در همان خط است.
2. `crontab` روی اوبونتوی مینیمال نصب نیست؛ `crontab -` شکست می‌خورد و نصب پس از بالا آمدن سرویس‌ها نیمه‌کاره می‌ماند ⇒ بسته‌ی `cron` نصب می‌شود. `backup.log` هم بی‌پایان بزرگ می‌شد ⇒ logrotate.
3. فایل‌های `scripts/*.sh` در مخزن بیت اجرایی نداشتند (`./scripts/…` ⇒ Permission denied) ⇒ همه‌ی فراخوانی‌ها «bash scripts/…» شد و نگهبان آن را اجبار می‌کند.
4. `.env.production.example` مقدار `BACKUP_PASSPHRASE/BACKUP_KEEP/BACKUP_MIRROR` را نداشت (نصب دستی ⇒ بک‌آپ هرگز کار نمی‌کرد).
5. `rsync --delete-after` اگر `backups/` محلی خالی/بازسازی می‌شد کل تاریخچه‌ی mirror را پاک می‌کرد ⇒ `--max-delete=6` و `ssh BatchMode` (cron هرگز روی پرسش رمز گیر نکند).
6. هیچ ابزار بازیابی خودکاری وجود نداشت ⇒ `vps-restore.sh`.
7. نصب‌کننده هیچ‌وقت بک‌آپ را آزمایش نمی‌کرد ⇒ بک‌آپ آزمایشی در پایان نصب (خطا همان لحظه دیده می‌شود نه شب اول).

## ابزارهای نگهبان (جلوگیری از بازگشت)

| دستور | کار |
|---|---|
| `npm run infra:check` | ارجاع‌های npm، هم‌خوانی lock، نحو bash، export رمز، `-Fc`، ACME اجباری، پوشه‌های بک‌آپ، ignoreها، logging/mem_limit، ARGهای Docker |
| `npm run infra:selftest` | ۲۴ بررسی روی زنجیره‌ی کامل بک‌آپ ← رمزگشایی ← نگهداری ← بازیابی با «docker جعلی» (شرایط cron واقعی: `env -i`) |
| CI: job `static` | هر دو دستور بالا + `npm ci` |
| CI: job `docker` | اعتبار compose، خطای ACME_EMAIL خالی، ساخت واقعی ایمیج، نبود e2e/qa/tests/docs در ایمیج |

## راستی‌آزمایی انجام‌شده

- `bash scripts/infra-selftest.sh` ← ۲۴ بررسی موفق؛ `node scripts/check-infra.mjs` ← سالم.
- بازتولید INF-03 روی اسکریپت قدیمی (خطا + فایل صفربایتی) و عدم تکرار روی اسکریپت جدید.
- ساخت واقعی `next build` با `EMZ_STANDALONE=1` روی context «بدون e2e/qa/tests/docs/scripts/simulator» و `tsconfig.build.json` ✔.
- `npx next typegen` · `tsc --noEmit` · `npm run build` ✔ (جزئیات در گزارش تحویل).
- محدودیت صادقانه: Docker در محیط ممیزی نبود؛ فایل‌های compose با YAML parser اعتبارسنجی شدند و `docker build` واقعی به job «docker» در CI سپرده شد (معادل آن، ساخت context حذف‌شده، اجرا شد).
