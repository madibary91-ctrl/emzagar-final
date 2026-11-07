/**
 * مقایسه‌ی دو نسخه‌ی متن قرارداد (در سطح کلمه) — بدون وابستگی خارجی.
 * ورودی HTML است؛ ابتدا به متن ساده (با حفظ شکست پاراگراف‌ها) تبدیل می‌شود.
 */

const ENTITIES: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };

export function htmlToText(html: string): string {
  return (html || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|ul|ol|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function countWords(html: string): number {
  const t = htmlToText(html);
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}

export type DiffType = "same" | "add" | "del";
export interface DiffPart {
  type: DiffType;
  text: string;
}

const MAX_CELLS = 16_000_000;

function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

function pushPart(out: DiffPart[], type: DiffType, text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.type === type) last.text += text;
  else out.push({ type, text });
}

/** تفاوت کلمه‌به‌کلمه (LCS)؛ برای متن‌های خیلی بزرگ پس از حذف بخش مشترک ابتدا/انتها، بخش میانی کامل جایگزین‌شده حساب می‌شود */
export function diffText(a: string, b: string): DiffPart[] {
  const A = tokenize(a);
  const B = tokenize(b);
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffPart[] = [];
  pushPart(out, "same", A.slice(0, start).join(""));

  const midA = A.slice(start, endA);
  const midB = B.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) {
    pushPart(out, "del", midA.join(""));
    pushPart(out, "add", midB.join(""));
  } else {
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = midA[i] === midB[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        pushPart(out, "same", midA[i]);
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        pushPart(out, "del", midA[i++]);
      } else {
        pushPart(out, "add", midB[j++]);
      }
    }
    while (i < n) pushPart(out, "del", midA[i++]);
    while (j < m) pushPart(out, "add", midB[j++]);
  }
  pushPart(out, "same", A.slice(endA).join(""));
  return out;
}

export function diffHtml(oldHtml: string, newHtml: string): DiffPart[] {
  return diffText(htmlToText(oldHtml), htmlToText(newHtml));
}

export function diffStats(parts: DiffPart[]): { added: number; removed: number; unchanged: number; changed: boolean } {
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const p of parts) {
    if (p.type === "add") added += words(p.text);
    else if (p.type === "del") removed += words(p.text);
    else unchanged += words(p.text);
  }
  return { added, removed, unchanged, changed: added + removed > 0 };
}
