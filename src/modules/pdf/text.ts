/**
 * چیدمان متن فارسی/دوطرفه (Bidi) برای PDF.
 *
 * PDFKit هر «قطعه‌ی متن» را درست شکل‌دهی (اتصال حروف) و برای حروف راست‌به‌چپ وارونه می‌کند، اما
 * ترتیب کلمات در یک خط، اعداد فارسی و متن لاتین را خودش مدیریت نمی‌کند. این ماژول خط را به قطعه‌های
 * یک‌جهته می‌شکند و ترتیب بصری را (برای پاراگراف راست‌به‌چپ) برمی‌گرداند.
 */

export type Dir = "R" | "L";
/** یک قطعه‌ی آماده‌ی رسم: متن (در صورت لزوم از پیش وارونه/آینه‌شده) */
export interface Segment {
  text: string;
  /** قطعه‌ی راست‌به‌چپ (فارسی/عربی) یا چپ‌به‌راست (لاتین/عدد) */
  dir: Dir;
}

type Cls = "R" | "L" | "N";

const isArabicDigit = (c: number) => (c >= 0x0660 && c <= 0x0669) || (c >= 0x06f0 && c <= 0x06f9);
const isLatinAlnum = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f);

function classify(ch: string): Cls {
  const c = ch.codePointAt(0)!;
  if (isArabicDigit(c) || isLatinAlnum(c)) return "L"; // اعداد (حتی فارسی) و لاتین چپ‌به‌راست نوشته می‌شوند
  if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) || (c >= 0xfb50 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff) || c === 0x200c || c === 0x200d) return "R";
  return "N";
}

const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "«": "»", "»": "«", "<": ">", ">": "<" };
/** نویسه‌هایی که میان دو عدد/لاتین بخشی از همان عدد/شناسه‌اند: 12:30  1,000  AMZ-2025-1  a/b  3.14 */
const JOINERS = new Set(["-", "/", ":", ".", ",", "٫", "٬", "+", "_", "@", "%", "#", "&", "="]);

/** شکستن یک خط به «ران»های یک‌جهته به ترتیب منطقی */
export function splitRuns(line: string): { dir: Dir; text: string }[] {
  const chars = Array.from(line);
  const cls = chars.map(classify);
  // رفع ابهام نویسه‌های خنثی: میان دو «چپ‌به‌راست» → چپ‌به‌راست (اگر اتصال‌دهنده یا فاصله باشد)، وگرنه راست‌به‌چپ
  const dir: Dir[] = cls.map((c) => (c === "L" ? "L" : "R"));
  for (let i = 0; i < chars.length; i++) {
    if (cls[i] !== "N") continue;
    let j = i;
    while (j < chars.length && cls[j] === "N") j++;
    const prev = i > 0 ? cls[i - 1] : null;
    const next = j < chars.length ? cls[j] : null;
    const gap = chars.slice(i, j);
    const allJoin = gap.every((g) => JOINERS.has(g));
    const onlyJoin = gap.length <= 2 && allJoin;
    const spacesOnly = gap.every((g) => g === " ");
    // «A B» (دو کلمه‌ی لاتین با فاصله) هم یک ران چپ‌به‌راست است
    const inLtr = prev === "L" && next === "L" && (onlyJoin || spacesOnly);
    for (let k = i; k < j; k++) dir[k] = inLtr ? "L" : "R";
    i = j - 1;
  }
  const runs: { dir: Dir; text: string }[] = [];
  for (let i = 0; i < chars.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.dir === dir[i]) last.text += chars[i];
    else runs.push({ dir: dir[i], text: chars[i] });
  }
  return runs;
}

const hasArabicScript = (s: string) => /[\u0600-\u06ff]/.test(s);
const reverseStr = (s: string) => Array.from(s).reverse().join("");

/** آماده‌سازی متن هر قطعه برای PDFKit/fontkit (جبران وارونه‌سازی خودکار حروف عربی‌نویس) */
function prepare(run: { dir: Dir; text: string }): Segment[] {
  if (run.dir === "R") {
    const mirrored = Array.from(run.text).map((ch) => MIRROR[ch] ?? ch).join("");
    return [{ text: mirrored, dir: "R" }];
  }
  // ران چپ‌به‌راست: اگر عدد فارسی دارد، fontkit کل قطعه را وارونه می‌کند؛ پس از پیش آن را برعکس می‌کنیم.
  // قطعه‌های لاتین و فارسی را جدا می‌کنیم تا هر کدام درست رسم شوند.
  const parts: { arabic: boolean; text: string }[] = [];
  for (const ch of Array.from(run.text)) {
    const last = parts[parts.length - 1];
    if (classify(ch) === "N") {
      // اتصال‌دهنده/فاصله به قطعه‌ی قبلی می‌چسبد
      if (last) last.text += ch;
      else parts.push({ arabic: false, text: ch });
      continue;
    }
    const arabic = isArabicDigit(ch.codePointAt(0)!);
    if (last && last.arabic === arabic) last.text += ch;
    else parts.push({ arabic, text: ch });
  }
  return parts.map((p) => ({ dir: "L" as const, text: p.arabic && hasArabicScript(p.text) ? reverseStr(p.text) : p.text }));
}

/**
 * قطعه‌های یک خط به ترتیب «بصری از چپ به راست» برای پاراگراف راست‌به‌چپ.
 * (اولین ران منطقی، سمت راست‌ترین قطعه است.)
 */
export function visualSegments(line: string, baseDir: Dir = "R"): Segment[] {
  const runs = splitRuns(line);
  const ordered = baseDir === "R" ? [...runs].reverse() : runs;
  return ordered.flatMap(prepare);
}

/** آیا متن اساساً راست‌به‌چپ است؟ (برای تعیین جهت پاراگراف) */
export function isRtlText(text: string): boolean {
  let r = 0;
  let l = 0;
  for (const ch of text) {
    const c = classify(ch);
    const cp = ch.codePointAt(0)!;
    if (c === "R") r++;
    else if (c === "L" && !isArabicDigit(cp)) l++;
  }
  return r >= l;
}

const FA = "۰۱۲۳۴۵۶۷۸۹";
export const toFaDigits = (s: string | number) => String(s).replace(/\d/g, (d) => FA[Number(d)]);
