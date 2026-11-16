/* ═════════════ مدل داده‌ی ورودی ═════════════ */

export interface PdfSigner {
  label: string;
  name: string;
  mobileMasked: string;
  signedAtText: string;
  ip: string;
  methodText: string;
  otpVerified: boolean;
  /** احراز هویت اختیاری: سطح تضمین هویت در لحظه‌ی امضا (خالی = عادی) */
  identityText?: string;
  identitySeal?: string;
  signature: Buffer | null;
  /** witness = شاهد (فقط گواهی می‌دهد) */
  role?: string;
  /** مرحله‌ی امضا (امضای هم‌زمان: هم‌مرحله‌ها هم‌زمان امضا کرده‌اند) */
  stageText?: string;
  /** امضاکننده‌ی حقوقی: نام شرکت، شناسه‌ی ملی و سمت */
  companyName?: string;
  companyNationalId?: string;
  signatoryTitle?: string;
  /** مهر شرکتی و پاراف (PNG) + هش آن‌ها (برای شناسنامه) */
  seal?: Buffer | null;
  sealSha?: string;
  initials?: Buffer | null;
  initialsSha?: string;
}
export interface PdfInput {
  siteName: string;
  number: string;
  title: string;
  customerName: string;
  issuedAtText: string;
  completedAtText: string;
  bodyHtml: string;
  signers: PdfSigner[];
  docHash: string;
  verifyUrl: string;
}
/* ═════════════ فاز ۲: لایه‌ی روکش (امضا/فیلد روی فایل اصلی)، گواهی امضا و PDF ساده از HTML ═════════════ */

export interface OverlayItem {
  kind: "image" | "text" | "check";
  /** مختصات به point، مبدأ گوشه‌ی بالا-چپ صفحه‌ی «نمایشی» */
  x: number;
  y: number;
  w: number;
  h: number;
  image?: Buffer | null;
  text?: string;
}
export interface OverlayPage {
  w: number;
  h: number;
  items: OverlayItem[];
}
export interface CertificateInput extends PdfInput {
  /** سطرهای اضافه‌ی شناسنامه (مثلاً نام و SHA-256 فایل اصلی) */
  facts?: { label: string; value: string }[];
}

/** GLM-7: رندر از سقف صفحه گذشت (سند غول‌پیکر)؛ ریشه‌ی خطا همان لحظه‌ی افزودن صفحه‌ی بعدی است، نه پس از رندر کامل */
export class PdfPageLimitError extends Error {
  /** خطای دائمی: تلاش دوباره همان نتیجه را می‌دهد (صف کار نباید retry کند) */
  readonly permanent = true;
  constructor(public maxPages: number) {
    super(`سند بیش از ${maxPages} صفحه می‌شود`);
    this.name = "PdfPageLimitError";
  }
}

/** PDF-04: سقف پیش‌فرض صفحه‌های PDF متنیِ قرارداد (متغیر PDF_MAX_PAGES؛ بازه‌ی مجاز ۱۰ تا ۲۰۰۰، پیش‌فرض ۴۰۰) */
export function maxContractPages(): number {
  const n = Number(process.env.PDF_MAX_PAGES);
  return Number.isInteger(n) && n >= 10 && n <= 2000 ? n : 400;
}
