# امضاگیر — ایمیج production (حالت standalone؛ حجم کم و بدون نیاز به npm در زمان اجرا)
FROM node:22-alpine AS deps
WORKDIR /app
# INF-02: ساخت «تکرارپذیر» — package-lock.json الزامی است و با npm ci نصب می‌شود (نسخه‌ی دقیق + هش تمام بسته‌ها).
# بدون lock، هر ساخت (به‌ویژه روی سرورهای ایران با میرور متفاوت) می‌تواند نسخه‌های دیگری بگیرد.
#   NPM_REGISTRY=https://<میرور>   میرور npm (مثلاً میرور داخلی). npm آدرس «resolved» داخل lock را خودکار به این میرور تغییر می‌دهد.
#   ALLOW_UNLOCKED_INSTALL=1      فقط اضطراری: نصب بدون lock (غیرتکرارپذیر)
ARG NPM_REGISTRY=""
ARG ALLOW_UNLOCKED_INSTALL="0"
COPY package.json package-lock.json* ./
RUN set -eu; \
    if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi; \
    npm config set fetch-retries 5; npm config set fetch-retry-mintimeout 20000; npm config set fetch-retry-maxtimeout 120000; \
    if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    elif [ "$ALLOW_UNLOCKED_INSTALL" = "1" ]; then \
      echo "WARNING: package-lock.json not found; installing without lockfile (NOT reproducible)" >&2; \
      npm install --no-audit --no-fund; \
    else \
      echo "ERROR: package-lock.json not found. Commit it (npm install --package-lock-only) or build with --build-arg ALLOW_UNLOCKED_INSTALL=1" >&2; \
      exit 1; \
    fi

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# C-01: کلید عمومی فروشنده (اختیاری) داخل ایمیج تعبیه می‌شود. docker-compose.prod.yml آن را از LICENSE_PUBLIC_KEY در .env پاس می‌دهد (INF-11)؛
# دستی: docker build --build-arg LICENSE_PUBLIC_KEY=...
ARG LICENSE_PUBLIC_KEY=""
# INF-07: فقط src تایپ‌چک می‌شود (e2e/qa/tests/simulator/docs در .dockerignore‌اند)
ENV EMZ_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1 EMZ_TSCONFIG=tsconfig.build.json EMZ_EMBEDDED_LICENSE_PUBLIC_KEY=$LICENSE_PUBLIC_KEY
RUN npm run build
# INF-07 (دفاع در عمق): ردیابی فایل‌های standalone به‌خاطر خواندن‌های پویای fs (src/lib/wp-release.ts) «کل ریشه‌ی پروژه» را وارد خروجی می‌کند
# و outputFileTracingExcludes در Turbopack اثر ندارد. .dockerignore این پوشه‌ها را از context حذف می‌کند؛ این خط تضمین می‌کند
# حتی اگر روزی دوباره وارد context شوند، به ایمیج نهایی نرسند.
RUN cd .next/standalone && rm -rf e2e qa tests docs scripts simulator .github *.md Dockerfile docker-compose*.yml Caddyfile playwright.config.ts vitest.config.mts

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 UV_THREADPOOL_SIZE=8
RUN addgroup -S app && adduser -S app -G app && mkdir -p /app/storage /app/backups && chown app:app /app/storage /app/backups
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/assets ./assets
COPY --from=build --chown=app:app /app/wordpress-plugin ./wordpress-plugin
USER app
# CR-04: بک‌آپ‌ها روی volume «جدا» از داده‌ی اصلی‌اند (حذف/خرابی storage بک‌آپ‌ها را نمی‌برد)
VOLUME ["/app/storage", "/app/backups"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
