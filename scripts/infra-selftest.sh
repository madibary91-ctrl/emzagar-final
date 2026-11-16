#!/usr/bin/env bash
# خودآزمون زنجیره‌ی بک‌آپ/بازیابی VPS بدون Docker واقعی:
#   npm run infra:selftest      (یا:  bash scripts/infra-selftest.sh)
#
# یک «docker» جعلی در PATH می‌گذارد که pg_dump/tar/psql را شبیه‌سازی می‌کند (tar و openssl و gzip «واقعی»‌اند)، سپس:
#   ۱) سناریوی cron: رمز فقط در .env است (نه در محیط) ← باید موفق شود (INF-03)
#   ۲) نام و فرمت فایل‌ها: db-*.dump (-Fc) و storage-*.tar.gz.enc (INF-05/10)
#   ۳) رمزگشایی دستی با دستور مستند در راهنما + وجود sources/landing/branding داخل آرشیو
#   ۴) نگهداری (BACKUP_KEEP)، نبود رمز، نبود rsync با BACKUP_MIRROR (کد خروج ۲)
#   ۵) بازیابی کامل: رمز غلط ← بدون تغییر؛ رمز درست ← فایل‌ها و دنباله‌ی دستورهای دیتابیس
set -Eeuo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; bad=0
ok()  { pass=$((pass+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
nok() { bad=$((bad+1));  printf '  \033[31m✗ %s\033[0m\n' "$*"; }
expect() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else nok "$d"; fi; }
expect_fail() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then nok "$d"; else ok "$d"; fi; }

# ── پروژه‌ی آزمایشی ──
P="$T/proj"; APP="$T/app"; BIN="$T/bin"; LOG="$T/docker.log"
mkdir -p "$P/scripts/lib" "$APP/storage"/{signatures,sources,landing,branding,backups} "$BIN"
cp "$SRC"/scripts/{vps-backup.sh,vps-restore.sh} "$P/scripts/"; cp "$SRC/scripts/lib/common.sh" "$P/scripts/lib/"
: > "$P/docker-compose.prod.yml"
printf 'signed' > "$APP/storage/signatures/a.png"; printf 'word-bytes' > "$APP/storage/sources/contract.docx"
printf 'img' > "$APP/storage/landing/lp-1.png"; printf 'logo' > "$APP/storage/branding/logo-1.png"; printf 'x' > "$APP/storage/backups/nested.txt"
printf '{"sessionSecret":"s"}' > "$APP/storage/config.json"; printf 'KEY' > "$APP/storage/install-key.txt"
PASSPH='p@ss word-123'
# .env به سبک ویندوز (CRLF) و با نقل‌قول: خوانش باید هر دو را تمیز کند
printf 'APP_DOMAIN=x.ir\r\nBACKUP_PASSPHRASE="%s"\r\n' "$PASSPH" > "$P/.env"

cat > "$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
# docker جعلی برای خودآزمون
echo "docker $*" >> "$FAKE_LOG"
[ "$1" = compose ] && shift
[ "${1:-}" = "-f" ] && shift 2
sub="${1:-}"; shift || true
case "$sub" in
  version|config|up|stop|start|image) exit 0 ;;
  ps) printf 'db\napp\n' ;;
  run) # run --rm --no-deps -T app tar ...
    while [ "${1:-}" != "tar" ] && [ $# -gt 0 ]; do shift; done
    shift; [ "$1" = "-C" ] && shift 2; exec tar -C "$FAKE_APP" "$@" ;;
  exec)
    [ "$1" = "-T" ] && shift
    svc="$1"; shift; cmd="$1"; shift
    case "$svc:$cmd" in
      db:pg_dump) printf 'PGDMP-fake-custom-format' ;;
      db:pg_restore) head -c5 | grep -q PGDMP || exit 1; [ "${1:-}" = "--list" ] && exit 0; cat >/dev/null ;;
      db:psql) cat >/dev/null ;;
      app:tar) [ "$1" = "-C" ] && shift 2; exec tar -C "$FAKE_APP" "$@" ;;
      app:wget) exit 0 ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$BIN/docker"
export FAKE_LOG="$LOG" FAKE_APP="$APP"
# محیط «cron»: PATH حداقلی + بدون هیچ متغیر BACKUP_*
run() { ( cd "$P" && env -i PATH="$BIN:/usr/bin:/bin" HOME="$T" FAKE_LOG="$LOG" FAKE_APP="$APP" "$@" ); }

echo "▶ بک‌آپ (شبیه cron: رمز فقط در .env)"
expect "بک‌آپ بدون هیچ متغیر محیطی موفق است (INF-03)" run bash scripts/vps-backup.sh
DB="$(ls "$P"/backups/db-*.dump 2>/dev/null | head -1 || true)"; ST="$(ls "$P"/backups/storage-*.tar.gz.enc 2>/dev/null | head -1 || true)"
expect "فایل دیتابیس با فرمت custom (.dump) ساخته شد (INF-10)" test -s "${DB:-/nonexistent}"
expect "فایل storage رمزنگاری‌شده (.tar.gz.enc) ساخته شد" test -s "${ST:-/nonexistent}"
expect "هیچ فایل ناتمام (.partial) نمانده" bash -c "! ls -A '$P/backups' | grep -q partial"
expect "پوشه‌ی بک‌آپ فقط برای مالک (700)" test "$(stat -c %a "$P/backups")" = 700
LISTING="$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "pass:$PASSPH" -in "$ST" 2>/dev/null | gzip -dc | tar -tf - 2>/dev/null || true)"
for f in storage/signatures/a.png storage/sources/contract.docx storage/landing/lp-1.png storage/branding/logo-1.png storage/config.json; do
  expect "آرشیو شامل $f" grep -qx "$f" <<<"$LISTING"
done
expect_fail "آرشیو شامل storage/backups نیست (تو در تو نمی‌شود)" grep -q "storage/backups/" <<<"$LISTING"
expect_fail "آرشیو شامل install-key.txt نیست" grep -q install-key <<<"$LISTING"

echo "▶ نگهداری و خطاها"
for i in 01 02 03 04 05; do : > "$P/backups/db-2020010$i-030000.dump"; touch -d "2020-01-0$((10#$i)) 03:00" "$P/backups/db-2020010$i-030000.dump"; done
run env BACKUP_KEEP=3 bash scripts/vps-backup.sh >/dev/null 2>&1 || true
expect "BACKUP_KEEP=3: فقط ۳ نسخه‌ی دیتابیس می‌ماند" test "$(ls "$P"/backups/db-*.dump | wc -l)" -eq 3
expect "جدیدترین نسخه حذف نشده" test -s "$DB"
mv "$P/.env" "$P/.env.off"
expect_fail "بدون BACKUP_PASSPHRASE با خطا متوقف می‌شود" run bash scripts/vps-backup.sh
mv "$P/.env.off" "$P/.env"
printf 'BACKUP_MIRROR=%s\r\n' "$T/mirror" >> "$P/.env"
set +e; run bash scripts/vps-backup.sh >/dev/null 2>&1; rc=$?; set -e
if ! command -v rsync >/dev/null 2>&1; then
  expect "بدون rsync و با BACKUP_MIRROR: کد خروج ۲ (بک‌آپ محلی سالم)" test "$rc" -eq 2
else
  expect "با rsync: mirror انجام شد" test -s "$(ls "$T"/mirror/storage-*.enc 2>/dev/null | head -1)"
fi
sed -i '/BACKUP_MIRROR/d' "$P/.env"

echo "▶ بازیابی"
LATEST_ST="$(ls -1t "$P"/backups/storage-*.tar.gz.enc | head -1)"
rm -f "$APP/storage/sources/contract.docx" "$APP/storage/branding/logo-1.png"
cp "$P/.env" "$P/.env.good"; printf 'APP_DOMAIN=x.ir\nBACKUP_PASSPHRASE=wrong\n' > "$P/.env"
: > "$LOG"
expect_fail "رمز غلط: بازیابی پیش از هر تغییر متوقف می‌شود" run bash scripts/vps-restore.sh --yes
expect "رمز غلط: هیچ دستور تغییردهنده‌ای اجرا نشد" bash -c "! grep -qE ' (stop|run) ' '$LOG'"
mv "$P/.env.good" "$P/.env"; : > "$LOG"
expect "بازیابی با رمز درست موفق است" run bash scripts/vps-restore.sh --yes
expect "فایل Word حذف‌شده برگشت" test "$(cat "$APP/storage/sources/contract.docx" 2>/dev/null)" = word-bytes
expect "لوگوی حذف‌شده برگشت" test "$(cat "$APP/storage/branding/logo-1.png" 2>/dev/null)" = logo
expect "دیتابیس در پایگاه موقت بازیابی و سپس جایگزین شد" bash -c "grep -c 'emzagar_restore' '$LOG' | grep -qv '^0\$'"
expect "برنامه پس از بازیابی دوباره بالا آمد" grep -q ' up -d app' "$LOG"
expect "مسیر --stamp و فرمت اشتباه رد می‌شود" bash -c "! (cd '$P' && env -i PATH='$BIN:/usr/bin:/bin' FAKE_LOG='$LOG' FAKE_APP='$APP' bash scripts/vps-restore.sh --yes --stamp bad >/dev/null 2>&1)"
void=$LATEST_ST

echo
if [ "$bad" -eq 0 ]; then printf '\033[1;32m✓ خودآزمون زیرساخت: %d بررسی موفق\033[0m\n' "$pass"; else printf '\033[1;31m✗ %d شکست از %d بررسی\033[0m\n' "$bad" "$((pass+bad))"; exit 1; fi
