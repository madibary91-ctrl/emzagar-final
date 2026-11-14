import { type ChildNode, type Element } from "domhandler";
import path from "node:path";
import { toFaDigits } from "../text";

/* ═════════════ تنظیمات صفحه و قلم ═════════════ */

const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const MARGIN_X = 54;
export const TOP = 92;
export const BOTTOM = 64;
export const CONTENT_W = PAGE_W - MARGIN_X * 2;
export const RIGHT = PAGE_W - MARGIN_X;
export const INK = "#102c31";
export const MUTED = "#6b7280";
export const fontDir = () => process.env.PDF_FONT_DIR || path.join(process.cwd(), "assets", "fonts");
export const REGULAR = "Vazir";
export const BOLD = "Vazir-Bold";
/** حذف نویسه‌های کنترلی جهت (Intl فارسی آن‌ها را می‌گذارد) که در قلم گلیف ندارند */
export const clean = (s: string) => s.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
/**
 * PDFKit/fontkit در قطعه‌های راست‌به‌چپ، فاصله‌ی معمولی (U+0020) را جابه‌جا می‌کند و کلمات می‌چسبند؛
 * فاصله‌ی ناشکن (U+00A0) درست رسم می‌شود. بنابراین هنگام اندازه‌گیری و رسم، فاصله‌ها NBSP می‌شوند.
 */
export const nb = (s: string) => s.replace(/ /g, "\u00a0");
/* ═════════════ تبدیل HTML قرارداد به بلوک‌ها ═════════════ */

export interface Word {
  text: string;
  /** پیش از این کلمه فاصله هست؟ (کلمه‌های چسبیده مثل <b>ab</b>c فاصله نمی‌گیرند) */
  sp: boolean;
  bold: boolean;
  underline: boolean;
  strike: boolean;
}
export type Align = "right" | "left" | "center" | "justify";
export interface Para {
  words: Word[];
  align?: Align;
  size: number;
  indent: number;
  bullet?: string;
  before: number;
  after: number;
  quote?: boolean;
  forceLtr?: boolean;
  endsSpace: boolean;
}
export type Block = { type: "para"; para: Para } | { type: "hr" } | { type: "table"; rows: Block[][][] };
interface Ctx {
  bold: boolean;
  underline: boolean;
  strike: boolean;
  align?: Align;
  indent: number;
  quote: boolean;
  ltr: boolean;
}
const BASE = 11;
const HEAD: Record<string, number> = { h1: 18, h2: 15, h3: 13, h4: 12 };
function styleAlign(el: Element): Align | undefined {
  const m = /text-align\s*:\s*(left|right|center|justify)/i.exec(el.attribs?.style ?? "");
  return m ? (m[1].toLowerCase() as Align) : undefined;
}
export function htmlToBlocks(nodes: ChildNode[], base: Partial<Ctx> = {}): Block[] {
  const blocks: Block[] = [];
  let cur: Para | null = null;

  const flush = () => {
    if (cur && cur.words.length) blocks.push({ type: "para", para: cur });
    cur = null;
  };
  const open = (ctx: Ctx, extra: Partial<Para> = {}) => {
    flush();
    cur = { words: [], align: ctx.align, size: BASE, indent: ctx.indent, before: 0, after: 7, quote: ctx.quote, forceLtr: ctx.ltr, endsSpace: true, ...extra };
  };
  const addText = (raw: string, ctx: Ctx) => {
    const text = clean(raw);
    if (!cur) open(ctx);
    const p = cur as Para;
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      if (/\s/.test(text)) p.endsSpace = true;
      return;
    }
    const leading = /^\s/.test(text);
    tokens.forEach((t, i) => p.words.push({ text: t, sp: p.words.length > 0 && (i > 0 || leading || p.endsSpace), bold: ctx.bold, underline: ctx.underline, strike: ctx.strike }));
    p.endsSpace = /\s$/.test(text);
  };

  const walk = (list: ChildNode[], ctx: Ctx, listState?: { ordered: boolean; n: number }) => {
    for (const node of list) {
      if (node.type === "text") {
        addText((node as unknown as { data: string }).data, ctx);
        continue;
      }
      if (node.type !== "tag") continue;
      const el = node as Element;
      const tag = el.name.toLowerCase();
      const align = styleAlign(el) ?? ctx.align;
      const ltr = el.attribs?.dir === "ltr" ? true : el.attribs?.dir === "rtl" ? false : ctx.ltr;
      const next: Ctx = { ...ctx, align, ltr };

      if (tag === "br") {
        // خط جدید داخل همان پاراگراف: پاراگراف جدید بدون فاصله
        const keep = cur;
        if (keep) {
          const { align: a, size, indent, quote, forceLtr } = keep;
          flush();
          cur = { words: [], align: a, size, indent, before: 0, after: 0, quote, forceLtr, endsSpace: true };
          // پاراگراف قبلی بدون فاصله‌ی پایانی ثبت می‌شود
          const last = blocks[blocks.length - 1];
          if (last && last.type === "para") last.para.after = 0;
        }
        continue;
      }
      if (tag === "hr") {
        flush();
        blocks.push({ type: "hr" });
        continue;
      }
      if (tag === "table") {
        flush();
        const rows: Block[][][] = [];
        const collectRows = (kids: ChildNode[]) => {
          for (const k of kids) {
            if (k.type !== "tag") continue;
            const e = k as Element;
            if (e.name === "tr") {
              const cells: Block[][] = [];
              for (const c of e.children) {
                if (c.type === "tag" && ((c as Element).name === "td" || (c as Element).name === "th")) {
                  const ce = c as Element;
                  cells.push(htmlToBlocks(ce.children, { ...next, bold: ce.name === "th" || next.bold, align: styleAlign(ce) ?? next.align }));
                }
              }
              if (cells.length) rows.push(cells);
            } else collectRows(e.children);
          }
        };
        collectRows(el.children);
        if (rows.length) blocks.push({ type: "table", rows });
        continue;
      }
      if (HEAD[tag]) {
        open({ ...next, bold: true }, { size: HEAD[tag], before: 6, after: 8 });
        walk(el.children, { ...next, bold: true });
        flush();
        continue;
      }
      if (tag === "ul" || tag === "ol") {
        flush();
        const st = { ordered: tag === "ol", n: 0 };
        walk(el.children, { ...next, indent: ctx.indent + 18 }, st);
        flush();
        continue;
      }
      if (tag === "li") {
        const n = listState ? ++listState.n : 0;
        open(next, { bullet: listState?.ordered ? `${toFaDigits(n)}.` : "•", after: 4 });
        walk(el.children, next);
        flush();
        continue;
      }
      if (tag === "blockquote") {
        flush();
        walk(el.children, { ...next, indent: ctx.indent + 14, quote: true });
        flush();
        continue;
      }
      if (tag === "p" || tag === "div") {
        open(next);
        walk(el.children, next);
        flush();
        continue;
      }
      const inline: Ctx = {
        ...next,
        bold: next.bold || tag === "strong" || tag === "b",
        underline: next.underline || tag === "u" || tag === "a",
        strike: next.strike || tag === "s",
      };
      walk(el.children, inline);
    }
  };

  walk(nodes, { bold: false, underline: false, strike: false, indent: 0, quote: false, ltr: false, ...base });
  flush();
  return blocks;
}
