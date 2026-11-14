export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

import sanitize from "sanitize-html";

const ALIGN = [/^(left|right|center|justify)$/];

/**
 * پاک‌سازی HTML قرارداد با فهرست سفید (allowlist): فقط تگ‌ها و ویژگی‌های امن متن غنی باقی می‌مانند.
 * خروجی هوش مصنوعی، قالب‌ها و متن قرارداد همگی از همین مسیر عبور می‌کنند (جلوگیری از Stored XSS).
 */
export function sanitizeHtml(html: string): string {
  return sanitize(html, {
    allowedTags: [
      "h1", "h2", "h3", "h4", "p", "br", "hr", "ul", "ol", "li", "strong", "b", "em", "i", "u", "s", "sub", "sup",
      "blockquote", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "span", "div", "a",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      "*": ["style", "dir", "colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowProtocolRelative: false,
    allowedStyles: {
      "*": { "text-align": ALIGN, direction: [/^(rtl|ltr)$/] },
    },
    transformTags: {
      a: sanitize.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }),
    },
  });
}
