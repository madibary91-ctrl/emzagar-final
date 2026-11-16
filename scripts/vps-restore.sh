#!/usr/bin/env bash
# بازیابی امن از بک‌آپ‌های VPS (خروجی scripts/vps-backup.sh)
#
#   bash scripts/vps-restore.sh                      آخرین نسخه‌ی دیتابیس + storage (با تأیید دستی)
#   bash scripts/vps-restore.sh --yes                بدون پرسش
#   bash scripts/vps-restore.sh --stamp 20250101-030000       نسخه‌ی مشخص
#   bash scripts/vps-restore.sh --db-only | --files-only      فقط دیتابیس / فقط فایل‌ها
#   bash scripts/vps-restore.sh --dir /path/to/backups        پوشه‌ی دیگر (مثلاً کپی برگشتی از mirror)
#
# فرمت فایل‌ها:
#   db-<stamp>.dump              pg_dump -Fc (جدید)     ← pg_restore
#   db-<stamp>.sql.gz            SQL ساده (قدیمی)       ← psql
#   storage-<stamp>.tar.gz.enc   رمزنگاری‌شده (openssl aes-256-cbc -pbkdf2 -iter 200000) ← با BACKUP_PASSPHRASE
#   storage-<stamp>.tar.gz       بدون رمز (فقط نسخه‌های خیلی قدیمی)
#
# ایمنی: دیتابیس در یک «پایگاه‌داده‌ی موقت» بازیابی می‌شود و فقط در صورت موفقیت کامل با پایگاه فعلی «عوض» می‌شود؛
# اگر چیزی خراب بود، داده‌ی فعلی دست‌نخورده می‌ماند. پیش از جایگزینی هم یک نسخه‌ی اضطراری (pre-restore-*.dump) ساخته می‌شود.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=lib/common.sh
source "$ROOT/scripts/lib/common.sh"

DC="docker compose -f docker-compose.prod.yml"
DIR="backups"; STAMP=""; YES=0; DO_DB=1; DO_FILES=1
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --stamp) STAMP="${2:-}"; shift ;;
    --dir) DIR="${2:-}"; shift ;;
    --db-only) DO_FILES=0 ;;
    --files-only) DO_DB=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "گزینه‌ی ناشناخته: $1 (راهنما: --help)" ;;
  esac
  shift
done
[ -d "$DIR" ] || die "پوشه‌ی بک‌آپ پیدا نشد: $DIR"
[ -f .env ] || die ".env پیدا نشد؛ این پوشه نصب امضاگیر نیست."

need_cmd docker; docker compose version >/dev/null 2>&1 || die "Docker Compose v2 پیدا نشد."
need_cmd gzip; need_cmd tar

newest() { { ls -1t -- "$@" 2>/dev/null || true; } | head -n 1; }
if [ -n "$STAMP" ]; then
  [[ "$STAMP" =~ ^[0-9]{8}-[0-9]{6}$ ]] || die "قالب stamp باید YYYYMMDD-HHMMSS باشد."
  DB_FILE="$(newest "$DIR/db-$STAMP.dump" "$DIR/db-$STAMP.sql.gz")"
  ST_FILE="$(newest "$DIR/storage-$STAMP.tar.gz.enc" "$DIR/storage-$STAMP.tar.gz")"
else
  DB_FILE="$(newest "$DIR"/db-*.dump "$DIR"/db-*.sql.gz)"
  ST_FILE="$(newest "$DIR"/storage-*.tar.gz.enc "$DIR"/storage-*.tar.gz)"
fi
[ "$DO_DB" -eq 0 ] || [ -n "$DB_FILE" ] || die "فایل دیتابیس مناسب در $DIR پیدا نشد."
[ "$DO_FILES" -eq 0 ] || [ -n "$ST_FILE" ] || die "فایل storage مناسب در $DIR پیدا نشد."

PASS="$(cfg BACKUP_PASSPHRASE)"
if [ "$DO_FILES" -eq 1 ] && [[ "$ST_FILE" == *.enc ]]; then
  need_cmd openssl
  [ -n "$PASS" ] || die "BACKUP_PASSPHRASE لازم است (در .env یا متغیر محیطی). رمز را از نسخه‌ی بیرونی‌اش بردارید."
  export BACKUP_PASSPHRASE="$PASS"
  # پیش از هر تغییر: رمز درست است و فایل سالم؟
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$ST_FILE" | gzip -dc | tar -tf - >/dev/null \
    || die "رمزگشایی $ST_FILE ناموفق بود (رمز نادرست یا فایل خراب). هیچ تغییری اعمال نشد."
fi
if [ "$DO_DB" -eq 1 ]; then
  case "$DB_FILE" in
    *.dump) $DC exec -T db pg_restore --list < "$DB_FILE" >/dev/null || die "$DB_FILE آرشیو معتبر pg_dump نیست." ;;
    *.sql.gz) gzip -t "$DB_FILE" || die "$DB_FILE خراب است." ;;
  esac
fi

echo
say "برنامه‌ی بازیابی:"
[ "$DO_DB" -eq 1 ]    && echo "   دیتابیس : $DB_FILE"
[ "$DO_FILES" -eq 1 ] && echo "   فایل‌ها  : $ST_FILE"
warn "داده‌ی فعلی سرور با این نسخه جایگزین می‌شود و برنامه تا پایان کار متوقف است."
if [ "$YES" -ne 1 ]; then
  [ -t 0 ] || die "ورودی تعاملی نیست؛ با --yes اجرا کنید."
  read -r -p "ادامه می‌دهید؟ (بنویسید: yes) " ans
  [ "$ans" = "yes" ] || die "لغو شد."
fi

STARTED_APP=0
cleanup() {
  # هر اتفاقی افتاد، برنامه دوباره بالا بیاید (اگر پایگاه‌داده‌ی موقت مانده، پاک شود)
  $DC exec -T db psql -U emzagar -d postgres -qc 'DROP DATABASE IF EXISTS emzagar_restore WITH (FORCE)' >/dev/null 2>&1 || true
  if [ "$STARTED_APP" -eq 0 ]; then $DC start app >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

$DC up -d db >/dev/null
say "توقف برنامه…"
$DC stop app >/dev/null

if [ "$DO_DB" -eq 1 ]; then
  SAFETY="$DIR/pre-restore-$(date +%Y%m%d-%H%M%S).dump"
  ( umask 077; $DC exec -T db pg_dump -U emzagar -d emzagar --no-owner -Fc > "$SAFETY" ) \
    && say "نسخه‌ی اضطراریِ وضعیت فعلی: $SAFETY" || { rm -f -- "$SAFETY"; warn "نسخه‌ی اضطراری ساخته نشد (دیتابیس فعلی خالی/خراب است؟)؛ ادامه می‌دهیم."; }

  say "بازیابی دیتابیس در پایگاه موقت…"
  PSQL="$DC exec -T db psql -U emzagar -d postgres -v ON_ERROR_STOP=1 -qc"
  $PSQL 'DROP DATABASE IF EXISTS emzagar_restore WITH (FORCE)'
  $PSQL 'CREATE DATABASE emzagar_restore'
  case "$DB_FILE" in
    *.dump) $DC exec -T db pg_restore -U emzagar -d emzagar_restore --no-owner --exit-on-error --single-transaction < "$DB_FILE" ;;
    *)      gzip -dc "$DB_FILE" | $DC exec -T db psql -U emzagar -d emzagar_restore -v ON_ERROR_STOP=1 --single-transaction -q >/dev/null ;;
  esac
  say "جایگزینی پایگاه‌داده…"
  $PSQL 'ALTER DATABASE emzagar RENAME TO emzagar_old' 2>/dev/null || true   # (اگر پایگاه فعلی نبود)
  $PSQL 'ALTER DATABASE emzagar_restore RENAME TO emzagar'
  $PSQL 'DROP DATABASE IF EXISTS emzagar_old WITH (FORCE)'
fi

if [ "$DO_FILES" -eq 1 ]; then
  say "بازیابی فایل‌ها (storage)…"
  # run (نه exec): برنامه متوقف است ولی volumeها همان‌اند؛ tar با کاربر «app» اجرا می‌شود تا مالکیت فایل‌ها درست بماند
  if [[ "$ST_FILE" == *.enc ]]; then
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$ST_FILE" | gzip -dc | $DC run --rm --no-deps -T app tar -C /app -xf -
  else
    gzip -dc "$ST_FILE" | $DC run --rm --no-deps -T app tar -C /app -xf -
  fi
fi

say "راه‌اندازی دوباره‌ی برنامه…"
$DC up -d app >/dev/null
STARTED_APP=1
OK=0
for _ in $(seq 1 40); do
  if $DC exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then OK=1; break; fi
  sleep 3
done
[ "$OK" -eq 1 ] || die "برنامه پس از بازیابی سالم بالا نیامد: $DC logs --tail=80 app"
say "✅ بازیابی کامل شد."
