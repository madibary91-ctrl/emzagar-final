#!/usr/bin/env bash
# توابع مشترک اسکریپت‌های عملیاتی VPS (install / backup / restore / update).
# فقط source می‌شود:   source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
#
# چرا این فایل؟ (INF-03) اسکریپت‌های زمان‌بندی‌شده با cron هیچ متغیر محیطی‌ای از .env نمی‌بینند؛
# همه‌ی مقادیر عملیاتی (BACKUP_PASSPHRASE، BACKUP_MIRROR، …) باید «به‌صورت امن» از .env خوانده
# و در صورت نیاز export شوند. .env هرگز source نمی‌شود (اجرای کد دلخواه + شکستن روی مقدارهای دارای فاصله/کاراکتر ویژه).

say()  { printf '\033[1;32m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit "${DIE_CODE:-1}"; }
ts()   { date -Is; }

# env_get KEY [فایل]  ← مقدار KEY را از فایل .env می‌خواند (آخرین تعریف برنده است؛ CR و نقل‌قول دور مقدار حذف می‌شود)
env_get() {
  local key="$1" file="${2:-.env}" line val
  [ -f "$file" ] || return 1
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n 1)" || return 1
  val="${line#*=}"
  val="${val%$'\r'}"
  if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
  printf '%s' "$val"
}

# cfg KEY [پیش‌فرض]  ← اولویت: متغیر محیطی ← فایل .env ← پیش‌فرض
cfg() {
  local key="$1" def="${2:-}" v="${!1:-}"
  [ -n "$v" ] || v="$(env_get "$key" 2>/dev/null || true)"
  printf '%s' "${v:-$def}"
}

# need_cmd دستور [راهنما]  ← وجود دستور را بررسی می‌کند و در نبود آن با پیام روشن متوقف می‌شود
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "دستور «$1» روی این سرور نصب نیست.${2:+ $2}"
}

# is_email آدرس  ← اعتبارسنجی ساده‌ی ایمیل (برای ACME)
is_email() { [[ "${1:-}" =~ ^[A-Za-z0-9._%+-]+@([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]; }
