/**
 * U-09 — مرورگرهای داخلی تلگرام/اینستاگرام/ایتا… اغلب «attachment» را بی‌صدا نادیده می‌گیرند.
 * با `?inline=1` همان PDF به‌صورت درون‌خطی (قابل‌نمایش و ذخیره از خود مرورگر) سرو می‌شود؛ بدون این پارامتر رفتار قبلی (دانلود) است.
 */
export function wantsInline(url: string | URL): boolean {
  try {
    return new URL(url, "http://local").searchParams.get("inline") === "1";
  } catch {
    return false;
  }
}

export function pdfDisposition(url: string | URL, filename: string): string {
  return `${wantsInline(url) ? "inline" : "attachment"}; filename="${filename}"`;
}
