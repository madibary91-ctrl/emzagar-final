#!/usr/bin/env bash
# بک‌آپ روزانه: دیتابیس PostgreSQL + پوشه‌ی storage (امضاها، فایل‌ها، config.json)
# نگهداری: BACKUP_KEEP روز (پیش‌فرض ۱۴). اجرا:  ./scripts/vps-backup.sh
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP="${BACKUP_KEEP:-14}"
OUT="backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
DC="docker compose -f docker-compose.prod.yml"

umask 077
$DC exec -T db pg_dump -U emzagar -d emzagar --no-owner | gzip > "$OUT/db-$STAMP.sql.gz"
# (CR-04) storage شامل config.json (SESSION_SECRET) و مدارک KYC است: بدون پوشه‌ی backups (تو در تو نشود) و «رمزنگاری‌شده».
# BACKUP_PASSPHRASE را در جای امن «بیرون از این سرور» هم نگه دارید؛ بدون آن بازیابی storage ممکن نیست.
if [ -z "${BACKUP_PASSPHRASE:-}" ] && [ -f .env ]; then BACKUP_PASSPHRASE="$(grep '^BACKUP_PASSPHRASE=' .env | cut -d= -f2- || true)"; fi
[ -n "${BACKUP_PASSPHRASE:-}" ] || { echo "✗ BACKUP_PASSPHRASE تنظیم نشده؛ بک‌آپ storage (شامل KYC و کلید امنیتی) بدون رمزنگاری ساخته نمی‌شود." >&2; exit 1; }
$DC exec -T app tar -C /app --exclude='storage/backups' --exclude='storage/install-key.txt' -cf - storage | gzip \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE > "$OUT/storage-$STAMP.tar.gz.enc"

# بررسی سالم‌بودن فایل‌ها
gzip -t "$OUT/db-$STAMP.sql.gz"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$OUT/storage-$STAMP.tar.gz.enc" | gzip -t
echo "[$(date -Is)] ✓ backup $STAMP  ($(du -h "$OUT/db-$STAMP.sql.gz" | cut -f1) db, $(du -h "$OUT/storage-$STAMP.tar.gz.enc" | cut -f1) storage)"

find "$OUT" -maxdepth 1 -type f \( -name 'db-*.sql.gz' -o -name 'storage-*.tar.gz.enc' \) -mtime +"$KEEP" -delete

# (CR-04) نسخه‌ی بیرون از این دیسک/سرور: BACKUP_MIRROR = مسیر mount دیگر یا مقصد rsync (user@host:/path)
if [ -n "${BACKUP_MIRROR:-}" ]; then
  rsync -a --delete-after --include='db-*.sql.gz' --include='storage-*.tar.gz.enc' --exclude='*' "$OUT/" "$BACKUP_MIRROR/" \
    && echo "[$(date -Is)] ✓ mirror → $BACKUP_MIRROR" || { echo "[$(date -Is)] ✗ mirror ناموفق" >&2; exit 2; }
else
  echo "[$(date -Is)] ⚠ BACKUP_MIRROR تنظیم نشده: نسخه‌ها فقط روی همین سرورند (در صورت از دست رفتن سرور همه‌چیز از بین می‌رود)." >&2
fi
