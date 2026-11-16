/**
 * پاک‌سازی سبک HTML در مرورگر پیش از درج در ویرایشگر.
 *
 * خروجی هوش مصنوعی در سرور با فهرست سفید پاک‌سازی می‌شود؛ اما کاربر می‌تواند پیش‌نویس را پیش از درج
 * ویرایش کند (یا چیزی در آن paste کند). این تابع لایه‌ی دفاعی دوم است: برچسب‌های اجرایی، ویژگی‌های on*،
 * نشانی‌های javascript: و استایل‌های خطرناک را برمی‌دارد. ذخیره‌ی نهایی باز هم در سرور پاک‌سازی می‌شود.
 */
const DROP_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "BASE", "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "SVG", "MATH", "NOSCRIPT", "TEMPLATE"]);
const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "srcset"]);

export function sanitizeForInsert(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (DROP_TAGS.has(child.tagName.toUpperCase())) {
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.replace(/[\u0000-\u0020\u00a0]+/g, "").toLowerCase();
        if (name.startsWith("on")) child.removeAttribute(attr.name);
        else if (URL_ATTRS.has(name) && /^(javascript|vbscript|data):/.test(value)) child.removeAttribute(attr.name);
        else if (name === "style" && /(url\(|expression|javascript:|@import|behavior)/i.test(attr.value)) child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

/** شمارش تقریبی کلمات یک HTML (برای نمایش حجم متن) */
export function countHtmlWords(html: string): number {
  const text = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim();
  return text ? text.split(/\s+/).length : 0;
}
