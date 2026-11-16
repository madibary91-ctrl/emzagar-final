import { asciiDigits, normalizeFa } from "./normalize";

/* ───────────── قطعه‌بندی ───────────── */

export type Chunk = { docId: number; docTitle: string; kind: string; index: number; text: string };
const TARGET = 900;
const HARD_MAX = 1500;
/** قطعه‌بندی بر اساس «ماده/بند» و پاراگراف؛ هر قطعه ≈ ۹۰۰ نویسه (هرگز وسط کلمه بریده نمی‌شود) */
export function chunkText(text: string): string[] {
  const blocks = text
    .split(/\n{2,}|\n(?=\s*(?:ماده|بند|فصل|تبصره)\s*[\d۰-۹]*)/)
    .map((b) => b.trim())
    .filter(Boolean);
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const b of blocks) {
    if (b.length > HARD_MAX) {
      flush();
      for (let i = 0; i < b.length; ) {
        let end = Math.min(b.length, i + TARGET);
        if (end < b.length) {
          const sp = b.lastIndexOf(" ", end);
          if (sp > i + TARGET / 2) end = sp;
        }
        out.push(b.slice(i, end).trim());
        i = end;
      }
      continue;
    }
    if (cur && cur.length + b.length > TARGET) flush();
    cur += (cur ? "\n" : "") + b;
  }
  flush();
  return out.filter((c) => c.length >= 20);
}
/* ───────────── توکن‌سازی و BM25 ───────────── */

export const STOP = new Set(
  "ها های و در به از که این آن را با برای است شد شود می بر یا تا هر همه یک دو سه کرد کند باید بود بوده نیز اما اگر هم پس خود ما شما او آنها آنان ایشان طرف طرفین بین مورد موضوع بند ماده قرارداد مطابق طبق مذکور فوق ذیل چنانچه صورت مدت".split(" "),
);
/** ریشه‌یابی سبک: حذف «ها/های/ان/ات» پایانی (برای تطابق «پرداخت‌ها» با «پرداخت») */
function stem(t: string): string {
  if (t.length > 5 && t.endsWith("های")) return t.slice(0, -3);
  if (t.length > 4 && (t.endsWith("ها") || t.endsWith("ان") || t.endsWith("ات"))) return t.slice(0, -2);
  return t;
}
export function tokenize(s: string): string[] {
  return asciiDigits(normalizeFa(s))
    .toLowerCase()
    // «پرداخت‌ها» → «پرداخت» (پسوند جمع بعد از نیم‌فاصله)، سپس نیم‌فاصله‌های باقی‌مانده فاصله می‌شوند
    .replace(/\u200c(?:ها|های|ان|ات)(?![\p{L}])/gu, "")
    .replace(/[\u200c_]/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .map(stem)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}
export type Scored = { chunk: Chunk; score: number };
/** BM25 استاندارد (k1=1.4, b=0.75) روی قطعه‌ها؛ بدون هیچ سرویس بیرونی یا embedding */
export function rankChunks(chunks: Chunk[], query: string, k1 = 1.4, b = 0.75): Scored[] {
  const q = [...new Set(tokenize(query))];
  if (chunks.length === 0) return [];
  const docs = chunks.map((c) => tokenize(c.text));
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  return chunks
    .map((chunk, i) => {
      const d = docs[i];
      const tf = new Map<string, number>();
      for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
      let score = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const n = df.get(t) || 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.length) / avg));
      }
      return { chunk, score };
    })
    .sort((a, b2) => b2.score - a.score || a.chunk.index - b2.chunk.index);
}
