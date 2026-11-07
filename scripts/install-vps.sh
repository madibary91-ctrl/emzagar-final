#!/usr/bin/env bash
# نصب یک‌دستوریِ امضاگیر روی VPS اوبونتو/دبیان (۲۲.۰۴ به بالا) با HTTPS خودکار
#
#   sudo bash scripts/install-vps.sh <domain> [email]
#   مثال:  sudo bash scripts/install-vps.sh sign.example.com admin@example.com
#
# کارها: نصب Docker (اگر نباشد) ← فایروال (۲۲/۸۰/۴۴۳) ← ساخت .env با رمزهای تصادفی ←
#        بالا آوردن دیتابیس + برنامه + Caddy ← انتظار برای سلامت ← زمان‌بندی بک‌آپ روزانه.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

say()  { printf '\033[1;32m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "با root اجرا کنید:  sudo bash scripts/install-vps.sh <domain> [email]"
[[ "$DOMAIN" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]] || die "دامنه‌ی معتبر بدهید. مثال: sudo bash scripts/install-vps.sh sign.example.com you@example.com"

# ۱) پیش‌نیازها
if ! command -v docker >/dev/null 2>&1; then
  say "نصب Docker…"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 پیدا نشد (apt install docker-compose-plugin)."
command -v openssl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y openssl; }
command -v curl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y curl; }

# ۲) DNS: هشدار اگر دامنه به این سرور اشاره نمی‌کند (مانع نصب نیست)
MYIP="$(curl -fsS -4 https://api.ipify.org 2>/dev/null || true)"
DNSIP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
if [ -n "$MYIP" ] && [ -n "$DNSIP" ] && [ "$MYIP" != "$DNSIP" ]; then
  warn "دامنه به $DNSIP اشاره می‌کند ولی IP این سرور $MYIP است. تا اصلاح DNS، گواهی HTTPS صادر نمی‌شود."
elif [ -z "$DNSIP" ]; then
  warn "DNS دامنه هنوز پیدا نشد. رکورد A را به IP این سرور (${MYIP:-؟}) بزنید."
fi

# ۳) فایروال
if command -v ufw >/dev/null 2>&1; then
  say "تنظیم فایروال (SSH، HTTP، HTTPS)…"
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
fi

# ۴) .env (فقط اگر نبود؛ نصب مجدد رمزها را عوض نمی‌کند)
if [ -f .env ]; then
  warn ".env از قبل وجود دارد؛ دست نمی‌خورد."
else
  say "ساخت .env با رمزهای تصادفی…"
  rnd() { openssl rand -hex 24; }
  umask 077
  cat > .env <<ENV
APP_DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
APP_URL=https://$DOMAIN
DB_PASSWORD=$(rnd)
SESSION_SECRET=$(rnd)
CRON_SECRET=$(rnd)
INSTALL_KEY=$(rnd | cut -c1-16)
BACKUP_PASSPHRASE=$(rnd)
BACKUP_DIR=/app/backups
LICENSE_SERVER_URL=https://license.emzagar.ir
LICENSE_PUBLIC_KEY=
LICENSE_REQUIRED=0
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
ENV
  umask 022
fi

# ۵) بالا آوردن
say "ساخت و اجرای سرویس‌ها (بار اول چند دقیقه طول می‌کشد)…"
docker compose -f docker-compose.prod.yml up -d --build

say "انتظار برای آماده‌شدن برنامه…"
OK=0
for i in $(seq 1 60); do
  if docker compose -f docker-compose.prod.yml exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then OK=1; break; fi
  sleep 3
done
[ "$OK" -eq 1 ] || { docker compose -f docker-compose.prod.yml logs --tail=40 app; die "برنامه بالا نیامد؛ لاگ بالا را ببینید."; }

# ۶) بک‌آپ روزانه
chmod +x scripts/vps-backup.sh scripts/vps-update.sh 2>/dev/null || true
CRONLINE="0 3 * * * cd $DIR && ./scripts/vps-backup.sh >> $DIR/backups/backup.log 2>&1"
mkdir -p "$DIR/backups"
( crontab -l 2>/dev/null | grep -v "vps-backup.sh" ; echo "$CRONLINE" ) | crontab - && say "بک‌آپ روزانه‌ی ساعت ۳ بامداد زمان‌بندی شد."

KEY="$(grep '^INSTALL_KEY=' .env | cut -d= -f2)"
cat <<DONE

════════════════════════════════════════════════════
 ✅ نصب انجام شد
 ۱) آدرس:  https://$DOMAIN/install   (اگر گواهی هنوز صادر نشده، ۱–۲ دقیقه صبر کنید)
 ۲) کلید نصب (در صفحه‌ی نصب بخواهد): $KEY
 ۳) پس از ساخت مدیر کل: «پلتفرم ← لایسنس و به‌روزرسانی» → کلید لایسنس را فعال کنید.
 ۴) افزونه‌ی وردپرس را از «وردپرس و ووکامرس» در پنل دانلود کنید.
 ۵) ⚠ رمز بک‌آپ (BACKUP_PASSPHRASE) را همین حالا از فایل .env بردارید و «بیرون از این سرور» نگه دارید؛ بدون آن بازیابی KYC/کلید امنیتی ممکن نیست.
    سپس برای نسخه‌ی بیرونی: BACKUP_MIRROR=user@host:/path (یا mount دیگر) را در .env بگذارید.
 بک‌آپ‌ها: $DIR/backups   ·   به‌روزرسانی: ./scripts/vps-update.sh <فایل-zip-نسخه‌ی-جدید>
════════════════════════════════════════════════════
DONE
