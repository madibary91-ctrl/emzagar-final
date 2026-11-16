/**
 * قرارداد مشترک درگاه‌های پرداخت.
 * افزودن درگاه جدید = نوشتن یک آداپتور (init / parseCallback / verify) و ثبت آن در registry.ts؛
 * هیچ بخش دیگری از سیستم (کیف پول، اشتراک، صفحه‌ی بازگشت) تغییر نمی‌کند.
 */
export type GatewayId = "zarinpal" | "zibal" | "idpay" | "payir" | "sandbox";
export const REAL_GATEWAY_IDS = ["zarinpal", "zibal", "idpay", "payir"] as const;
export type RealGatewayId = (typeof REAL_GATEWAY_IDS)[number];

export const isRealGateway = (v: unknown): v is RealGatewayId => (REAL_GATEWAY_IDS as readonly unknown[]).includes(v);
export const isGatewayId = (v: unknown): v is GatewayId => v === "sandbox" || isRealGateway(v);

/** نشانه‌ی تراکنشی که کاربر پرداخت کرده ولی تایید آن به‌خاطر قطعی موقت درگاه ممکن نشد (زمان‌بند دوباره تلاش می‌کند) */
export const VERIFY_PENDING = "verify_pending";
/** تا این مدت از ساخت، زمان‌بند تراکنش‌های verify_pending را دوباره با درگاه تایید می‌کند (پولِ احتمالاً کسرشده) */
export const VERIFY_RETRY_HORIZON_MS = 48 * 3600_000;
/**
 * R-03: تراکنشِ verify_pending (کاربر برگشته و پولش احتمالاً کسر شده ولی درگاه جواب قطعی نداده) پس از ۴۸ ساعت رها نمی‌شود؛
 * تا این افق با فاصله‌ی روزانه همچنان با درگاه تطبیق داده می‌شود و پس از آن در شمارنده‌ی `stale` برای پیگیری انسانی گزارش می‌شود.
 */
export const VERIFY_LONG_HORIZON_MS = 30 * 24 * 3600_000;
/** حداکثر مدتی که کاربر می‌تواند در صفحه‌ی درگاه بماند و بعد به سایت برگردد (سقف محافظه‌کارانه‌ی نشست درگاه‌ها) */
export const GATEWAY_SESSION_MS = 2 * 3600_000;

export interface InitInput {
  amountToman: number;
  amountRial: number;
  callbackUrl: string;
  description: string;
  /** شناسه‌ی سفارش ما (شناسه‌ی ردیف پرداخت) */
  orderId: string;
  mobile?: string;
}

/** transient=true یعنی «جواب قطعی نگرفتیم» (قطعی شبکه، تایم‌اوت، 5xx، پاسخ غیر JSON) و به شمارش خرابی درگاه اضافه می‌شود */
export type InitResult =
  | { ok: true; token: string; redirectUrl: string; testMode?: boolean }
  | { ok: false; transient: boolean; error: string };

export type VerifyOutcome =
  | { state: "paid"; refId: string; amountRial?: number }
  | { state: "failed"; error: string }
  /** پاسخ قطعی نگرفتیم؛ تراکنش pending می‌ماند و زمان‌بند بعداً دوباره بررسی می‌کند */
  | { state: "unknown"; error: string };

export interface GatewayAdapter {
  id: GatewayId;
  label: string;
  blurb: string;
  /** نام فیلد اعتبارنامه در پنل مدیر (مرچنت / کلید API) */
  credentialLabel: string;
  /** متغیر محیطی جایگزین */
  envVar: string;
  isValidCredential(c: string): boolean;
  init(credential: string, input: InitInput): Promise<InitResult>;
  /** پارامترهای بازگشت از درگاه (GET یا POST) را به توکن تراکنش و وضعیت موفق/ناموفق تبدیل می‌کند */
  parseCallback(q: URLSearchParams): { token: string | null; ok: boolean };
  verify(credential: string, p: { token: string; orderId: string; amountRial: number }): Promise<VerifyOutcome>;
}

/** کلید یکتای ذخیره‌شده‌ی تراکنش: زرین‌پال و سندباکس بدون پیشوند (سازگاری رو به عقب)، بقیه با پیشوند درگاه */
export function authorityKey(gateway: string, token: string): string {
  return gateway === "zarinpal" || gateway === "sandbox" ? token : `${gateway}:${token}`;
}
export function tokenFromAuthority(gateway: string, authority: string): string {
  return authority.startsWith(`${gateway}:`) ? authority.slice(gateway.length + 1) : authority;
}
