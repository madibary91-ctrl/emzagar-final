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
