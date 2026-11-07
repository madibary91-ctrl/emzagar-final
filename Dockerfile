# امضاگیر — ایمیج production (حالت standalone؛ حجم کم و بدون نیاز به npm در زمان اجرا)
FROM node:22-alpine AS deps
WORKDIR /app
# package-lock.json اختیاری است (اگر باشد npm ci، وگرنه npm install) تا ساخت ایمیج هیچ‌وقت به‌خاطر نبود قفل‌فایل نشکند
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV EMZ_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN npm run build

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
