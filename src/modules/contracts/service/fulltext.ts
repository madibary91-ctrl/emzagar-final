import { type SQL, sql } from "drizzle-orm";
import { db } from "@/db";
import { CONTRACT_FTS_DOC, FTS_CHARS_FROM, FTS_CHARS_TO } from "@/db/schema/contracts";
import { HL_START, HL_STOP } from "@/lib/highlight";

/**
 * جستجوی متن کامل قراردادها (عنوان + «متن» قرارداد، نه فقط عنوان).
 *
 * - سند جستجو در دیتابیس: CONTRACT_FTS_DOC (HTML پاک، یکسان‌سازی ي/ك/ارقام/نیم‌فاصله) روی ایندکس GIN `contracts_fts_idx`
 *   (to_tsvector('simple', …)) — بدون ستون اضافه و بدون نگرانی از «فراموش‌شدن به‌روزرسانی ایندکس»: هر تغییر متن خودکار ایندکس می‌شود.
 * - عبارت جستجو: هر واژه «پیشوندی» و همه‌ی واژه‌ها با AND (حق فس ← «حق فسخ»). فقط حروف/ارقام می‌ماند؛ هیچ ورودی کاربر مستقیم داخل SQL نمی‌رود.
 * - قطعه‌ی نمایشی (snippet) با ts_headline فقط برای ردیف‌های همان صفحه ساخته می‌شود؛ علامت‌گذاری با ⟦ ⟧ و در UI به <mark> تبدیل می‌شود (بدون HTML خام).
 */
const MAX_TERMS = 8;
const MAP = new Map<string, string>([...FTS_CHARS_FROM].map((ch, i) => [ch, [...FTS_CHARS_TO][i]]));

/** یکسان‌سازی متن جستجو دقیقاً مثل ایندکس */
export function normalizeSearchText(s: string): string {
  return [...s.toLowerCase()].map((ch) => MAP.get(ch) ?? ch).join("");
}

/** واژه‌های جستجو (حداکثر ۸ واژه‌ی حروف/ارقام) */
export function searchTerms(q: string): string[] {
  return normalizeSearchText(q)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .map((t) => t.slice(0, 40))
    .slice(0, MAX_TERMS);
}

/** عبارت to_tsquery: 'حق':* & 'فسخ':* ؛ null اگر واژه‌ی معتبری نباشد */
export function buildTsQuery(q: string): string | null {
  const terms = searchTerms(q);
  return terms.length ? terms.map((t) => `'${t}':*`).join(" & ") : null;
}

const doc = sql.raw(CONTRACT_FTS_DOC);

/** شرط «متن قرارداد شامل عبارت» روی جدول `contracts c` (برای زیرپرس‌وجوهای ادغام‌شده با UNION) */
export function ftsMatch(tsq: string): SQL {
  return sql`to_tsvector('simple', ${doc}) @@ to_tsquery('simple', ${tsq})`;
}

/** قطعه‌ی نمایشی اطراف واژه‌های یافت‌شده برای شناسه‌های داده‌شده */
export async function ftsSnippets(ids: number[], q: string): Promise<Map<number, string>> {
  const tsq = buildTsQuery(q);
  const out = new Map<number, string>();
  if (!tsq || ids.length === 0) return out;
  const idList = sql.join(ids.map((i) => sql`${i}`), sql`, `);
  const res = await db.execute(sql`
    select c.id as id,
           ts_headline('simple', ${doc}, to_tsquery('simple', ${tsq}), ${`StartSel=${HL_START}, StopSel=${HL_STOP}, MaxFragments=2, MaxWords=24, MinWords=8, FragmentDelimiter= … `}) as snippet
      from contracts c
     where c.id in (${idList}) and ${ftsMatch(tsq)}`);
  for (const r of res.rows as { id: number; snippet: string }[]) if (r.snippet) out.set(r.id, r.snippet.replace(/\s+/g, " ").trim().slice(0, 400));
  return out;
}
