import { GATEWAY_SESSION_MS, VERIFY_PENDING } from "@/modules/payments/types";

/**
 * وضعیت «قابل‌فهم برای کاربر» یک ردیف پرداخت.
 * پیش‌تر هر تراکنش `pending` برای همیشه «در انتظار» می‌ماند (حتی اگر کاربر در درگاه منصرف شده بود) و ردیف `failed` دلیلی نشان نمی‌داد؛
 * کاربر نمی‌دانست باید صبر کند، دوباره پرداخت کند یا پشتیبانی بگیرد.
 */
export type PaymentPhase = "paid" | "processing" | "waiting" | "abandoned" | "failed" | "refunded";

export type PaymentPhaseInfo = {
  phase: PaymentPhase;
  label: string;
  cls: string;
  /** توضیح کوتاه برای زیر وضعیت */
  hint?: string;
  /** «بررسی وضعیت از درگاه» معنا دارد؟ */
  canRecheck: boolean;
  /** «پرداخت دوباره» معنا دارد؟ */
  canRetry: boolean;
};

type Row = { status: string; error?: string | null; createdAt: Date | string; gateway?: string | null; authority?: string | null; amount?: number; refundedAmount?: number };

/** خطاهای فنی داخلی که نباید خام به کاربر نشان داده شوند */
const TECH_ERRORS: Record<string, string> = {
  activation_failed: "فعال‌سازی اشتراک انجام نشد و مبلغ به کیف پول برگشت.",
};

/** فقط متن فارسی (پیام کاربرپسند درگاه/سیستم) نمایش داده می‌شود؛ شناسه‌های فنی به متن عمومی تبدیل می‌شوند */
export function friendlyPaymentError(error: string | null | undefined): string {
  const e = (error ?? "").trim();
  if (!e) return "پرداخت کامل نشد.";
  if (TECH_ERRORS[e]) return TECH_ERRORS[e];
  if (e.startsWith(VERIFY_PENDING)) return "تایید پرداخت در حال بررسی است.";
  return /[\u0600-\u06FF]/.test(e) ? e.slice(0, 200) : "پرداخت از سمت درگاه تایید نشد.";
}

export function paymentPhase(p: Row, now = Date.now()): PaymentPhaseInfo {
  const created = new Date(p.createdAt).getTime();
  const isWallet = p.gateway === "wallet";
  const isSandbox = p.gateway === "sandbox";
  if (p.status === "paid") {
    if ((p.refundedAmount ?? 0) > 0 && p.amount !== undefined && (p.refundedAmount ?? 0) >= p.amount) {
      return { phase: "refunded", label: "مسترد شد", cls: "bg-stone-100 text-stone-700", canRecheck: false, canRetry: false };
    }
    return { phase: "paid", label: "موفق", cls: "bg-emerald-50 text-emerald-700", canRecheck: false, canRetry: false };
  }
  if (p.status === "failed") {
    return { phase: "failed", label: "ناموفق", cls: "bg-red-50 text-red-700", hint: friendlyPaymentError(p.error), canRecheck: false, canRetry: true };
  }
  // pending
  const checkable = !isSandbox && !isWallet;
  if (p.error?.startsWith(VERIFY_PENDING)) {
    return { phase: "processing", label: "در حال بررسی", cls: "bg-sky-50 text-sky-700", hint: "اگر مبلغ از حساب شما کسر شده، به‌طور خودکار اعمال می‌شود؛ لازم نیست دوباره پرداخت کنید.", canRecheck: checkable, canRetry: false };
  }
  if (now - created > GATEWAY_SESSION_MS || (p.authority ?? "").startsWith("pending:")) {
    return { phase: "abandoned", label: "ناتمام", cls: "bg-stone-100 text-stone-700", hint: "پرداخت در صفحه‌ی درگاه کامل نشد. اگر مبلغی کسر شده، «بررسی وضعیت» را بزنید؛ در غیر این صورت دوباره پرداخت کنید.", canRecheck: checkable, canRetry: true };
  }
  return { phase: "waiting", label: "در انتظار پرداخت", cls: "bg-amber-50 text-amber-700", hint: "اگر پرداخت را انجام داده‌اید ولی به سایت برنگشتید، «بررسی وضعیت» را بزنید.", canRecheck: checkable, canRetry: false };
}
