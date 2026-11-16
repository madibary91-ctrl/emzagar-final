/**
 * AI-05: ابزارهای خالصِ «پاک‌سازی متن» پیش و پس از تماس با مدل (بدون وابستگی به دیتابیس/شبکه؛ قابل آزمون).
 */

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", zwnj: "\u200c", laquo: "«", raquo: "»", hellip: "…", ndash: "–", mdash: "—" };

/** رمزگشایی نهادهای HTML (&nbsp; &amp; &#1574; &#x62E; …) */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, e: string) => {
    if (e[0] === "#") {
      const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

/**
 * HTML → متن ساده برای ارسال به مدل.
 * پیش‌تر هر `<…>` با فاصله جایگزین می‌شد: ساختار پاراگراف/ماده از بین می‌رفت، `&nbsp;`/`&amp;` به‌صورت خام به مدل می‌رسید و
 * عبارت «کمتر از <5 درصد> …» تا اولین `>` بلعیده می‌شد. اکنون فقط «تگ واقعی» (با حرف/اسلش بعد از `<`) حذف می‌شود،
 * پایان بلوک‌ها خط جدید می‌گیرد و نهادها رمزگشایی می‌شوند.
 */
export function htmlToPlainText(html: string): string {
  return decodeEntities(
    String(html ?? "")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote)\s*>/gi, "\n")
      .replace(/<\/(td|th)\s*>/gi, " | ")
      .replace(/<\/?[A-Za-z][^>]*>/g, " "),
  )
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * خروجی مدل → HTML خام (پیش از sanitizeHtml):
 *  - حصار کد در «هر جای» پاسخ (نه فقط ابتدا/انتها)، حتی بدون حصار بستن (پاسخ نیمه‌تمام)
 *  - مقدمه‌ی گفتاری پیش از اولین تگ («حتماً! این هم قرارداد:») حذف می‌شود تا به‌صورت متن بی‌تگ وارد قرارداد نشود
 */
export function extractModelHtml(raw: string): string {
  let t = String(raw ?? "").trim();
  const fenced = /```[a-z]*\s*\n?([\s\S]*?)```/i.exec(t);
  if (fenced) t = fenced[1];
  else t = t.replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "");
  t = t.trim();
  const firstTag = t.search(/<(h[1-6]|p|div|ul|ol|table|blockquote)\b/i);
  if (firstTag > 0 && firstTag < 400 && !/<[a-z]/i.test(t.slice(0, firstTag))) t = t.slice(firstTag);
  return t;
}

const MARKER_RE = /\[\[\s*[A-Za-z]+[_\s-]?\d+\s*\]\]/g;

/**
 * نشانگرهای حریم خصوصی که بعد از بازگردانی هنوز مانده‌اند (مدل نشانگر ساختگی/اشتباه ساخته) داخل قرارداد نباید بمانند:
 * با «……» (جای خالی استاندارد سامانه) عوض می‌شوند و تعدادشان گزارش می‌شود.
 */
export function blankUnresolvedMarkers(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(MARKER_RE, () => {
    count++;
    return "……";
  });
  return { text: out, count };
}

/** برش بی‌خطر روی مرز کلمه/جمله (نه وسط کلمه یا جفت‌جانشین ایموجی) */
export function clipAtBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf("."), cut.lastIndexOf("؛"), cut.lastIndexOf("!"), cut.lastIndexOf("؟"));
  if (lastBreak > max * 0.6) cut = cut.slice(0, lastBreak + 1);
  else {
    const sp = cut.lastIndexOf(" ");
    if (sp > max * 0.6) cut = cut.slice(0, sp);
  }
  // جفت‌جانشین ناقص (ایموجی) در انتها
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}
