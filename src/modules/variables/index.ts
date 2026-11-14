import { escapeHtml } from "@/lib/html";

/** متغیرهای پویای قابل استفاده در متن قرارداد */
export const VARIABLES: { key: string; label: string }[] = [
  { key: "USER_NAME", label: "نام کاربر" },
  { key: "USER_EMAIL", label: "ایمیل کاربر" },
  { key: "USER_MOBILE", label: "موبایل کاربر" },
  { key: "CONTRACT_NUMBER", label: "شماره قرارداد" },
  { key: "DATE", label: "تاریخ امروز" },
  { key: "SITE_NAME", label: "نام سایت" },
  { key: "PRODUCT_NAME", label: "نام محصول/خدمت" },
  { key: "AMOUNT", label: "مبلغ (تومان)" },
];

export function renderVariables(html: string, values: Record<string, string>): string {
  return html.replace(/\[([A-Z_]+)\]/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? escapeHtml(values[key]) : match,
  );
}
