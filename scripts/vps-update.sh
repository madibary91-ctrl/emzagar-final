#!/usr/bin/env bash
# به‌روزرسانی امن روی VPS با بک‌آپ خودکار و بازگشت خودکار در صورت شکست
#
#   ./scripts/vps-update.sh <emzagar-new.zip>      ← از فایل zip نسخه‌ی جدید (خرید/دانلود از فروشنده)
#   ./scripts/vps-update.sh --git                  ← اگر سورس را با git گرفته‌اید (git pull --ff-only)
#   ./scripts/vps-update.sh --rebuild              ← فقط ساخت دوباره (بدون تغییر فایل)
#
# گام‌ها: بک‌آپ دیتابیس/فایل‌ها ← برچسب‌گذاری ایمیج فعلی (برای بازگشت) ← جایگزینی کد (بدون .env/storage/backups) ←
#         ساخت ← بالا آوردن ← تست سلامت ← در صورت خطا: بازگشت خودکار به ایمیج قبلی.
# دیتابیس و storage هرگز پاک نمی‌شوند (volumeهای Docker).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
DC="docker compose -f docker-compose.prod.yml"
say()  { printf '\033[1;32m▶ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

ARG="${1:-}"
[ -n "$ARG" ] || die "استفاده: ./scripts/vps-update.sh <emzagar-new.zip> | --git | --rebuild"
[ -f .env ] || die ".env پیدا نشد؛ این پوشه نصب امضاگیر نیست."

say "۱) بک‌آپ پیش از به‌روزرسانی…"
./scripts/vps-backup.sh

say "۲) نگه‌داشتن ایمیج فعلی برای بازگشت…"
docker image inspect emzagar-app:latest >/dev/null 2>&1 && docker tag emzagar-app:latest emzagar-app:previous || true

case "$ARG" in
  --git)
    git pull --ff-only
    ;;
  --rebuild)
    ;;
  *)
    [ -f "$ARG" ] || die "فایل $ARG پیدا نشد."
    command -v unzip >/dev/null 2>&1 || { apt-get update -y && apt-get install -y unzip; }
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    unzip -q "$ARG" -d "$TMP"
    SRC="$TMP"
    # اگر zip یک پوشه‌ی بالاترین سطح دارد، همان را منبع بگیر
    if [ "$(find "$TMP" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ] && [ -d "$(find "$TMP" -mindepth 1 -maxdepth 1)" ]; then SRC="$(find "$TMP" -mindepth 1 -maxdepth 1)"; fi
    [ -f "$SRC/package.json" ] || die "این zip ساختار امضاگیر ندارد (package.json پیدا نشد)."
    say "جایگزینی کد (فایل‌های .env، backups و Caddyfile شما حفظ می‌شود)…"
    # پوشه‌های سورس پاک می‌شوند تا فایل‌های حذف‌شده‌ی نسخه‌ی قبل در ساخت جدید نماند
    rm -rf "$ROOT/src" "$ROOT/wordpress-plugin" "$ROOT/docs"
    tar -C "$SRC" --exclude='./.env' --exclude='./backups' --exclude='./Caddyfile' --exclude='./.git' -cf - . | tar -C "$ROOT" -xf -
    ;;
esac

say "۳) ساخت و اجرای نسخه‌ی جدید…"
if ! $DC up -d --build; then
  OK=0
else
  OK=0
  for i in $(seq 1 60); do
    if $DC exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then OK=1; break; fi
    sleep 3
  done
fi

if [ "$OK" -ne 1 ]; then
  printf '\033[1;31m✗ نسخه‌ی جدید سالم بالا نیامد؛ بازگشت خودکار…\033[0m\n'
  if docker image inspect emzagar-app:previous >/dev/null 2>&1; then
    docker tag emzagar-app:previous emzagar-app:latest
    $DC up -d --no-build app
    die "به نسخه‌ی قبلی برگشتیم. لاگ: $DC logs --tail=80 app"
  fi
  die "ایمیج قبلی برای بازگشت نبود. لاگ: $DC logs --tail=80 app"
fi
docker image prune -f >/dev/null 2>&1 || true
say "✅ به‌روزرسانی کامل شد. افزونه‌های وردپرس ظرف ۱۲ ساعت (یا با «بررسی همین حالا») نسخه‌ی جدید را دریافت می‌کنند."
