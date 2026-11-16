#!/usr/bin/env bash
# نصب یک‌دستوریِ امضاگیر روی VPS اوبونتو/دبیان (۲۲.۰۴ به بالا) با HTTPS خودکار
#
#   sudo bash scripts/install-vps.sh <domain> <email>
#   مثال:  sudo bash scripts/install-vps.sh sign.example.com admin@example.com
#
# ایمیل «الزامی» است (INF-04): Caddy برای ثبت حساب Let's Encrypt و هشدار انقضای گواهی به آن نیاز دارد و با مقدار خالی اصلاً بالا نمی‌آید.
# اگر ایمیل را ندهید و ترمینال تعاملی باشد، از شما پرسیده می‌شود. ایمیل باید واقعی باشد (نه @example.com).
# (اختیاری) کلید عمومی لایسنس فروشنده:  LICENSE_PUBLIC_KEY=... sudo -E bash scripts/install-vps.sh …
#
# کارها: نصب Docker و ابزارها (اگر نباشند) ← فایروال (۲۲/۸۰/۴۴۳) ← ساخت .env با رمزهای تصادفی ←
#        بالا آوردن دیتابیس + برنامه + Caddy ← انتظار برای سلامت ← زمان‌بندی بک‌آپ روزانه ← یک بک‌آپ آزمایشی.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-${ACME_EMAIL:-}}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
# shellcheck source=lib/common.sh
source "$DIR/scripts/lib/common.sh"

USAGE="sudo bash scripts/install-vps.sh <domain> <email>   مثال: sudo bash scripts/install-vps.sh sign.example.com you@yourdomain.ir"
[ "$(id -u)" -eq 0 ] || die "با root اجرا کنید:  $USAGE"
[[ "$DOMAIN" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]] || die "دامنه‌ی معتبر بدهید. $USAGE"

# ۰) ایمیل ACME (الزامی)
if [ -f .env ] && [ -z "$EMAIL" ]; then EMAIL="$(env_get ACME_EMAIL 2>/dev/null || true)"; fi
if [ -z "$EMAIL" ] && [ -t 0 ]; then read -r -p "ایمیل برای گواهی HTTPS (Let's Encrypt): " EMAIL; fi
[ -n "$EMAIL" ] || die "ایمیل لازم است (Caddy بدون آن بالا نمی‌آید). $USAGE"
is_email "$EMAIL" || die "ایمیل «$EMAIL» معتبر نیست. $USAGE"
case "${EMAIL##*@}" in
  example.com|example.org|example.net|localhost) die "Let's Encrypt ایمیل‌های نمونه (@example.com) را رد می‌کند؛ ایمیل واقعی بدهید." ;;
esac

# ۱) پیش‌نیازها
if ! command -v docker >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y curl; }
  say "نصب Docker…"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 پیدا نشد (apt install docker-compose-plugin)."
# ابزارهای مورد نیاز نصب و بک‌آپ: openssl (رمزنگاری/رمزهای تصادفی) · curl (بررسی IP/DNS) · rsync (کپی بیرونی بک‌آپ) · cron (زمان‌بندی)
need_pkgs=()
command -v openssl  >/dev/null 2>&1 || need_pkgs+=(openssl)
command -v curl     >/dev/null 2>&1 || need_pkgs+=(curl)
command -v rsync    >/dev/null 2>&1 || need_pkgs+=(rsync)
command -v crontab  >/dev/null 2>&1 || need_pkgs+=(cron)
if [ "${#need_pkgs[@]}" -gt 0 ]; then
  say "نصب بسته‌های مورد نیاز: ${need_pkgs[*]}"
  apt-get update -y && apt-get install -y "${need_pkgs[@]}" || die "نصب ${need_pkgs[*]} ناموفق بود؛ دستی نصب کنید و دوباره اجرا کنید."
fi
if command -v systemctl >/dev/null 2>&1; then systemctl enable --now cron >/dev/null 2>&1 || systemctl enable --now crond >/dev/null 2>&1 || true; fi

# ۲) DNS: هشدار اگر دامنه به این سرور اشاره نمی‌کند (مانع نصب نیست)
MYIP="$(curl -fsS -4 --max-time 8 https://api.ipify.org 2>/dev/null || true)"
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

# ۴) .env (فقط اگر نبود ساخته می‌شود؛ نصب مجدد رمزها را عوض نمی‌کند)
set_env() { # set_env KEY VALUE ← جایگزینی/افزودن امن (مقدارها فقط از کاراکترهای ایمن‌اند)
  local k="$1" v="$2"
  if grep -qE "^${k}=" .env; then sed -i "s|^${k}=.*|${k}=${v}|" .env; else printf '%s=%s\n' "$k" "$v" >> .env; fi
}
if [ -f .env ]; then
  warn ".env از قبل وجود دارد؛ رمزها دست نمی‌خورد."
  # نصب‌های قدیمی ممکن است ACME_EMAIL خالی داشته باشند ← Caddy بالا نمی‌آمد
  set_env ACME_EMAIL "$EMAIL"
  [ -n "$(env_get APP_DOMAIN 2>/dev/null || true)" ] || set_env APP_DOMAIN "$DOMAIN"
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
LICENSE_PUBLIC_KEY=${LICENSE_PUBLIC_KEY:-}
LICENSE_REQUIRED=0
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
ENV
  umask 022
fi
chmod 600 .env

# ۵) بالا آوردن
docker compose -f docker-compose.prod.yml config -q || die "docker-compose.prod.yml با .env فعلی معتبر نیست؛ پیام بالا را ببینید."
say "ساخت و اجرای سرویس‌ها (بار اول چند دقیقه طول می‌کشد)…"
docker compose -f docker-compose.prod.yml up -d --build

say "انتظار برای آماده‌شدن برنامه…"
OK=0
for _ in $(seq 1 60); do
  if docker compose -f docker-compose.prod.yml exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then OK=1; break; fi
  sleep 3
done
[ "$OK" -eq 1 ] || { docker compose -f docker-compose.prod.yml logs --tail=40 app; die "برنامه بالا نیامد؛ لاگ بالا را ببینید."; }

# ۶) بک‌آپ روزانه (cron) + چرخش لاگ آن
chmod +x scripts/*.sh 2>/dev/null || true
mkdir -p "$DIR/backups" && chmod 700 "$DIR/backups"
CRONPATH="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
CRONLINE="0 3 * * * cd $DIR && bash scripts/vps-backup.sh >> $DIR/backups/backup.log 2>&1"
( crontab -l 2>/dev/null | grep -vE "vps-backup.sh|^PATH=/usr/local/sbin" || true; echo "$CRONPATH"; echo "$CRONLINE" ) | crontab - && say "بک‌آپ روزانه‌ی ساعت ۳ بامداد زمان‌بندی شد."
if [ -d /etc/logrotate.d ]; then
  cat > /etc/logrotate.d/emzagar-backup <<LR
$DIR/backups/backup.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
}
LR
fi

# بک‌آپ آزمایشی همین حالا: اگر زنجیره‌ی بک‌آپ (رمز، rsync، docker) مشکل دارد، همین لحظه معلوم شود نه شب اول
say "بک‌آپ آزمایشی…"
if bash scripts/vps-backup.sh; then :; else
  rc=$?
  if [ "$rc" -eq 2 ]; then warn "بک‌آپ محلی سالم است ولی کپی بیرونی (BACKUP_MIRROR) ناموفق بود."; else warn "بک‌آپ آزمایشی ناموفق بود؛ پیش از ادامه آن را رفع کنید:  bash scripts/vps-backup.sh"; fi
fi

KEY="$(env_get INSTALL_KEY)"
cat <<DONE

════════════════════════════════════════════════════
 ✅ نصب انجام شد
 ۱) آدرس:  https://$DOMAIN/install   (اگر گواهی هنوز صادر نشده، ۱–۲ دقیقه صبر کنید)
 ۲) کلید نصب (در صفحه‌ی نصب بخواهد): $KEY
 ۳) پس از ساخت مدیر کل: «پلتفرم ← لایسنس و به‌روزرسانی» → کلید لایسنس را فعال کنید.
 ۴) افزونه‌ی وردپرس را از «وردپرس و ووکامرس» در پنل دانلود کنید.
 ۵) ⚠ رمز بک‌آپ (BACKUP_PASSPHRASE) را همین حالا از فایل .env بردارید و «بیرون از این سرور» نگه دارید؛ بدون آن بازیابی KYC/کلید امنیتی ممکن نیست.
    سپس برای نسخه‌ی بیرونی: BACKUP_MIRROR=user@host:/path (یا mount دیگر) را در .env بگذارید (اسکریپت بک‌آپ آن را از .env می‌خواند).
 بک‌آپ‌ها: $DIR/backups   ·   بازیابی: bash scripts/vps-restore.sh   ·   به‌روزرسانی: bash scripts/vps-update.sh <فایل-zip-نسخه‌ی-جدید>
════════════════════════════════════════════════════
DONE
