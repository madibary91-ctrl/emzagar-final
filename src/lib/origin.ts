import { trustedAppOrigin } from "@/lib/config";

/**
 * ───────────── تعیین «آدرس پایه‌ی مورد اعتماد» (ضد Host Header Poisoning) ─────────────
 *
 * هدرهای Host و X-Forwarded-Host را مهاجم کاملاً کنترل می‌کند. اگر لینک بازیابی رمز/تأیید ایمیل/دعوت از آن‌ها
 * ساخته شود، مهاجم برای ایمیل قربانی «فراموشی رمز» می‌زند و لینکی با توکن واقعی به دامنه‌ی خودش ارسال می‌شود.
 *
 * قاعده: هیچ هدر درخواستی هرگز «خودبه‌خود» مورد اعتماد نیست. ترتیب اعتماد:
 *  ۱) APP_URL / آدرس ثبت‌شده توسط نصب‌کننده (trustedAppOrigin)
 *  ۲) فهرست سفید صریح TRUSTED_HOSTS (مثلاً "sign.example.com,www.example.com")؛ هدر فقط اگر در فهرست باشد
 *  ۳) فقط در حالت توسعه (غیر production): میزبان loopback (localhost / 127.0.0.1 / ::1)
 *  در غیر این صورت رشته‌ی خالی برمی‌گردد و فراخواننده‌ی حساس (ایمیل‌های توکن‌دار) باید «بسته» شکست بخورد.
 */

type Getter = (name: string) => string | null | undefined;

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:]+\])(?::\d{1,5})?$/;

function firstValue(v: string | null | undefined): string {
  return String(v ?? "").split(",")[0].trim().toLowerCase();
}

function hostnameOf(host: string): string {
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "");
}

const isLoopback = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostnameOf(host));

function trustedHosts(): Set<string> {
  return new Set(
    String(process.env.TRUSTED_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => HOST_RE.test(h)),
  );
}

function protoOf(get: Getter, host: string): "http" | "https" {
  const p = firstValue(get("x-forwarded-proto"));
  if (p === "https" || p === "http") return p;
  return isLoopback(host) ? "http" : "https";
}

/** آدرس پایه‌ی قابل اعتماد درخواست؛ اگر هیچ منبع معتبری نبود رشته‌ی خالی */
export function resolveTrustedOrigin(get: Getter): string {
  const fixed = trustedAppOrigin();
  if (fixed) return fixed;

  const allow = trustedHosts();
  if (allow.size > 0) {
    for (const cand of [firstValue(get("x-forwarded-host")), firstValue(get("host"))]) {
      if (cand && HOST_RE.test(cand) && allow.has(cand)) return `${protoOf(get, cand)}://${cand}`;
    }
  }

  if (process.env.NODE_ENV !== "production") {
    const host = firstValue(get("host"));
    if (host && HOST_RE.test(host) && isLoopback(host)) return `${protoOf(get, host)}://${host}`;
  }
  return "";
}

/**
 * آدرس بر پایه‌ی هدر Host (بدون اعتماد). فقط برای نصب‌کننده‌ی وب که پشت «کلید نصب» است و
 * خودِ مالک سایت آن را باز می‌کند؛ نتیجه پس از نصب «ریشه‌ی اعتماد» (appUrl) می‌شود.
 */
export function bootstrapOriginFromHeaders(get: Getter): string {
  const fixed = trustedAppOrigin();
  if (fixed) return fixed;
  const host = firstValue(get("x-forwarded-host")) || firstValue(get("host"));
  if (!host || !HOST_RE.test(host)) return "";
  return `${protoOf(get, host)}://${host}`;
}
