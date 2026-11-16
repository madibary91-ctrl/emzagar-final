#!/usr/bin/env bash
# بک‌آپ روزانه‌ی VPS: دیتابیس PostgreSQL (فرمت custom با pg_dump -Fc) + پوشه‌ی storage (رمزنگاری‌شده)
#
#   bash scripts/vps-backup.sh
#
# خروجی در ./backups:
#   db-YYYYMMDD-HHMMSS.dump                 ← pg_dump -Fc (فشرده؛ بازیابی تراکنشی/انتخابی با pg_restore)
#   storage-YYYYMMDD-HHMMSS.tar.gz.enc      ← tar.gz رمزنگاری‌شده با AES-256-CBC + PBKDF2 (openssl)
# بازیابی: bash scripts/vps-restore.sh  (راهنما: docs/DEPLOYMENT-GUIDE-FA.md ← «بازیابی»)
#
# تنظیمات (متغیر محیطی یا فایل .env — cron هیچ متغیری از .env نمی‌بیند، پس خودِ اسکریپت آن را می‌خواند):
#   BACKUP_PASSPHRASE  (الزامی) رمز رمزنگاری storage؛ یک نسخه‌اش را «بیرون از این سرور» نگه دارید
#   BACKUP_KEEP        تعداد نسخه‌ی نگهداری‌شده از هر نوع (پیش‌فرض ۱۴)
#   BACKUP_MIRROR      مقصد نسخه‌ی بیرونی: مسیر mount یا user@host:/path (با rsync)
#   BACKUP_RSYNC_SSH   دستور ssh برای rsync (پیش‌فرض: ssh -o BatchMode=yes -o ConnectTimeout=20)
#
# کد خروج: ۰ موفق · ۱ خطا (بک‌آپ ساخته نشد) · ۲ بک‌آپ محلی سالم است ولی کپی بیرونی (mirror) ناموفق بود
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=lib/common.sh
source "$ROOT/scripts/lib/common.sh"

OUT="backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
DC="docker compose -f docker-compose.prod.yml"
KEEP="$(cfg BACKUP_KEEP 14)"
MIRROR="$(cfg BACKUP_MIRROR)"
# (INF-03) رمز باید «export» شود تا openssl (فرایند فرزند) با -pass env: آن را ببیند؛ در نسخه‌ی قبل فقط متغیر شل بود
# و اجرای شبانه‌ی cron هر شب با خطا تمام می‌شد.
BACKUP_PASSPHRASE="$(cfg BACKUP_PASSPHRASE)"
export BACKUP_PASSPHRASE

[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_KEEP باید عدد صحیح مثبت باشد (الان: «$KEEP»)."
[ -n "$BACKUP_PASSPHRASE" ] || die "BACKUP_PASSPHRASE تنظیم نشده؛ بک‌آپ storage (شامل KYC و کلید امنیتی) بدون رمزنگاری ساخته نمی‌شود. آن را در .env بگذارید (openssl rand -hex 24)."

# ── پیش‌بررسی ابزارها (INF-12): پیش از هر کاری، نه وسط اجرا ──
need_cmd docker "(نصب: curl -fsSL https://get.docker.com | sh)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 پیدا نشد (apt install docker-compose-plugin)."
need_cmd openssl "(apt-get install -y openssl)"
need_cmd gzip
need_cmd tar
MIRROR_TOOL_OK=1
if [ -n "$MIRROR" ] && ! command -v rsync >/dev/null 2>&1; then
  # بک‌آپ محلی ارزشمند است؛ نبود rsync نباید آن را متوقف کند، ولی باید بلند و واضح اعلام شود (کد خروج ۲)
  MIRROR_TOOL_OK=0
  warn "BACKUP_MIRROR تنظیم شده ولی rsync نصب نیست (apt-get install -y rsync). بک‌آپ محلی گرفته می‌شود، کپی بیرونی انجام نخواهد شد."
fi
# توجه: این اسکریپت به curl نیازی ندارد (فقط install-vps.sh از آن استفاده می‌کند).

mkdir -p "$OUT"
umask 077
chmod 700 "$OUT" 2>/dev/null || true

# جلوگیری از اجرای هم‌زمان (cron + اجرای دستی/به‌روزرسانی)
if command -v flock >/dev/null 2>&1; then
  exec 9>"$OUT/.vps-backup.lock"
  flock -n 9 || die "بک‌آپ دیگری در حال اجراست."
fi

$DC ps --status running --services 2>/dev/null | grep -qx db  || die "سرویس db در حال اجرا نیست (docker compose -f docker-compose.prod.yml up -d)."
$DC ps --status running --services 2>/dev/null | grep -qx app || die "سرویس app در حال اجرا نیست (docker compose -f docker-compose.prod.yml up -d)."

DB_FINAL="$OUT/db-$STAMP.dump"
ST_FINAL="$OUT/storage-$STAMP.tar.gz.enc"
DB_TMP="$OUT/.partial-db-$STAMP"
ST_TMP="$OUT/.partial-storage-$STAMP"
# فایل ناتمام هرگز با نام نهایی باقی نمی‌ماند (نام نهایی فقط با mv اتمی پس از راستی‌آزمایی)
trap 'rm -f -- "$DB_TMP" "$ST_TMP"' EXIT
trap 'die "بک‌آپ در خط $LINENO ناموفق شد."' ERR

# ── ۱) دیتابیس: فرمت custom (INF-10) ──
# -Fc: فشرده، با pg_restore قابل بازیابی «تراکنشی» (--single-transaction)، انتخابی (-t) و موازی (-j).
$DC exec -T db pg_dump -U emzagar -d emzagar --no-owner -Fc -Z 6 > "$DB_TMP"
[ -s "$DB_TMP" ] || die "خروجی pg_dump خالی است."
# صحت ساختار آرشیو (فهرست محتوا باید خوانده شود)
$DC exec -T db pg_restore --list < "$DB_TMP" >/dev/null || die "آرشیو دیتابیس نامعتبر است (pg_restore --list)."
mv -f -- "$DB_TMP" "$DB_FINAL"

# ── ۲) storage: رمزنگاری‌شده؛ بدون پوشه‌ی backups (تو در تو نشود) و بدون کلید نصب ──
# شامل همه‌ی زیرپوشه‌ها: signatures، documents، attachments، kyc، identity، sources (Word/PDF)، landing، branding و config.json
$DC exec -T app tar -C /app --exclude='storage/backups' --exclude='storage/install-key.txt' -cf - storage | gzip \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE > "$ST_TMP"
[ -s "$ST_TMP" ] || die "خروجی رمزنگاری storage خالی است."
# راستی‌آزمایی کامل: رمزگشایی ← gzip ← فهرست tar (فقط gzip -t کافی نیست)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$ST_TMP" | gzip -dc | tar -tf - >/dev/null \
  || die "راستی‌آزمایی storage ناموفق بود (رمز نادرست یا فایل خراب)."
mv -f -- "$ST_TMP" "$ST_FINAL"

echo "[$(ts)] ✓ backup $STAMP  ($(du -h "$DB_FINAL" | cut -f1) db, $(du -h "$ST_FINAL" | cut -f1) storage)"

# ── ۳) نگهداری: فقط KEEP نسخه‌ی آخر از هر نوع (الگوهای قدیمی .sql.gz و .tar.gz هم پاکسازی می‌شوند) ──
prune() {
  { ls -1t -- "$@" 2>/dev/null || true; } | tail -n +"$((KEEP + 1))" | while IFS= read -r f; do rm -f -- "$f"; done
}
prune "$OUT"/db-*.dump "$OUT"/db-*.sql.gz
prune "$OUT"/storage-*.tar.gz.enc "$OUT"/storage-*.tar.gz

# ── ۴) نسخه‌ی بیرون از این دیسک/سرور ──
trap - ERR
if [ -n "$MIRROR" ]; then
  # --max-delete: اگر پوشه‌ی backups محلی به‌هر دلیل خالی/بازسازی شود (دیسک جدید، پاک‌شدن)، rsync نباید تمام تاریخچه‌ی mirror را پاک کند.
  # در حالت عادی هر شب حداکثر ۲ فایل (یک db و یک storage) از mirror حذف می‌شود.
  if [ "$MIRROR_TOOL_OK" -eq 1 ] && rsync -a --delete-after --max-delete=6 --timeout=120 \
      -e "${BACKUP_RSYNC_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=20}" \
      --include='db-*.dump' --include='db-*.sql.gz' --include='storage-*.tar.gz.enc' --exclude='*' \
      "$OUT/" "$MIRROR/"; then
    echo "[$(ts)] ✓ mirror → $MIRROR"
  else
    echo "[$(ts)] ✗ mirror ناموفق (بک‌آپ محلی سالم است)" >&2
    exit 2
  fi
else
  echo "[$(ts)] ⚠ BACKUP_MIRROR تنظیم نشده: نسخه‌ها فقط روی همین سرورند (در صورت از دست رفتن سرور همه‌چیز از بین می‌رود)." >&2
fi
