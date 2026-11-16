import { type Align, BOLD, BOTTOM, type Block, CONTENT_W, INK, MARGIN_X, PAGE_H, type Para, REGULAR, TOP, type Word, clean, nb } from "./layout";
import { type Dir, isRtlText, visualSegments } from "../text";
import PDFDocument from "pdfkit";
import { PdfPageLimitError } from "./types";

/* ═════════════ نویسنده‌ی PDF ═════════════ */

type Doc = InstanceType<typeof PDFDocument>;
interface Chunk {
  text: string;
  bold: boolean;
  underline: boolean;
  strike: boolean;
}
export class Writer {
  y = TOP;
  /** PDF-04: سقف صفحه‌ها (۰ = بی‌سقف)؛ لحظه‌ی افزودن صفحه‌ی بعد از سقف، رندر با PdfPageLimitError قطع می‌شود */
  maxPages = 0;
  /** عمق سلول جدول: داخل سلول صفحه‌بندی ممنوع است (جدول تودرتو نباید وسط سلول صفحه بسازد) */
  private nested = 0;
  /** پنجره‌ی برش عمودی هنگام رسم «برشیِ» سلول‌های ردیف بلند؛ خطوط بیرون پنجره رسم نمی‌شوند */
  private win: { y0: number; y1: number } | null = null;
  constructor(readonly doc: Doc) {}

  setFont(bold: boolean, size: number) {
    this.doc.font(bold ? BOLD : REGULAR).fontSize(size);
  }

  /** حافظه‌ی عرض کلمه‌ها (اندازه‌گیری bidi/fontkit گران است و هر کلمه چندین بار اندازه‌گیری می‌شد) */
  private widthCache = new Map<string, number>();
  /** حافظه‌ی شکستن خط هر پاراگراف (رسم برشیِ ردیف‌های بلند یک پاراگراف را چندین بار می‌شکست) */
  private wrapCache = new WeakMap<Para, Map<string, ReturnType<Writer["wrap"]>>>();

  width(text: string, bold: boolean, size: number, base: Dir = "R"): number {
    const key = `${bold ? 1 : 0}|${size}|${base}|${text}`;
    const hit = this.widthCache.get(key);
    if (hit !== undefined) return hit;
    this.setFont(bold, size);
    let w = 0;
    for (const seg of visualSegments(clean(text), base)) w += this.doc.widthOfString(nb(seg.text));
    if (this.widthCache.size > 40_000) this.widthCache.clear();
    this.widthCache.set(key, w);
    return w;
  }

  ensure(h: number) {
    if (this.y + h > PAGE_H - BOTTOM) this.newPage();
  }

  newPage() {
    if (this.maxPages > 0 && this.doc.bufferedPageRange().count >= this.maxPages) throw new PdfPageLimitError(this.maxPages);
    this.doc.addPage();
    this.y = TOP;
  }

  /** رسم یک خط شامل چند قطعه‌ی استایل‌دار در محدوده‌ی [x, x+w] */
  drawChunks(chunks: Chunk[], x: number, w: number, y: number, size: number, align: Align, base: Dir, color = INK, extraSpace = 0) {
    const doc = this.doc;
    const ordered = base === "R" ? [...chunks].reverse() : chunks;
    type Piece = { text: string; bold: boolean; width: number; underline: boolean; strike: boolean };
    const pieces: Piece[] = [];
    for (const ch of ordered) {
      this.setFont(ch.bold, size);
      const segs = visualSegments(clean(ch.text), base);
      segs.forEach((seg, i) => {
        pieces.push({ text: nb(seg.text), bold: ch.bold, width: doc.widthOfString(nb(seg.text)), underline: ch.underline && i >= 0, strike: ch.strike });
      });
    }
    const total = pieces.reduce((a, p) => a + p.width, 0);
    let cx = align === "left" ? x : align === "center" ? x + (w - total) / 2 : x + w - total;
    if (align === "justify") cx = base === "R" ? x + w - total : x;
    doc.fillColor(color);
    for (const p of pieces) {
      this.setFont(p.bold, size);
      doc.text(p.text, cx, y, { lineBreak: false });
      if (p.underline) doc.save().lineWidth(0.5).strokeColor(color).moveTo(cx, y + size * 1.12).lineTo(cx + p.width, y + size * 1.12).stroke().restore();
      if (p.strike) doc.save().lineWidth(0.5).strokeColor(color).moveTo(cx, y + size * 0.55).lineTo(cx + p.width, y + size * 0.55).stroke().restore();
      cx += p.width;
    }
  }

  /**
   * PDF-03: کلمه‌ی بلندتر از عرض خط (URL، هش، شماره‌ی بلند در سلول باریک جدول) پیش‌تر از کادر بیرون می‌زد و روی ستون
   * مجاور/حاشیه نوشته می‌شد. چنین کلمه‌ای به تکه‌هایی (به ترتیب منطقی) شکسته می‌شود که هر کدام در یک خط جا شوند.
   */
  private breakLongWords(words: Word[], maxW: number, size: number, base: Dir): Word[] {
    if (maxW <= 0) return words;
    const out: Word[] = [];
    for (const w of words) {
      if (w.text.length < 2 || this.width(w.text, w.bold, size, base) <= maxW) {
        out.push(w);
        continue;
      }
      let cur = "";
      let first = true;
      for (const ch of Array.from(w.text)) {
        const t = cur + ch;
        if (cur && this.width(t, w.bold, size, base) > maxW) {
          out.push({ ...w, text: cur, sp: first ? w.sp : false });
          first = false;
          cur = ch;
        } else cur = t;
      }
      if (cur) out.push({ ...w, text: cur, sp: first ? w.sp : false });
    }
    return out;
  }

  /** شکستن کلمات یک پاراگراف به خطوط */
  wrap(p: Para, maxW: number, base: Dir): { chunks: Chunk[]; natural: number; spaces: number; last: boolean }[] {
    const ck = `${maxW.toFixed(2)}|${base}`;
    let per = this.wrapCache.get(p);
    if (!per) this.wrapCache.set(p, (per = new Map()));
    const cached = per.get(ck);
    if (cached) return cached;
    const res = this.wrapUncached(p, maxW, base);
    per.set(ck, res);
    return res;
  }

  private wrapUncached(p: Para, maxW: number, base: Dir): { chunks: Chunk[]; natural: number; spaces: number; last: boolean }[] {
    const lines: { words: Word[]; width: number }[] = [];
    let line: Word[] = [];
    let lw = 0;
    const spaceW = this.width(" ", false, p.size) || p.size * 0.25;
    for (const w of this.breakLongWords(p.words, maxW, p.size, base)) {
      const ww = this.width(w.text, w.bold, p.size, base);
      const add = line.length ? ww + (w.sp ? spaceW : 0) : ww;
      if (line.length && lw + add > maxW) {
        lines.push({ words: line, width: lw });
        line = [w];
        lw = ww;
      } else {
        line.push(w);
        lw += add;
      }
    }
    if (line.length) lines.push({ words: line, width: lw });
    return lines.map((l, idx) => {
      const chunks: Chunk[] = [];
      let spaces = 0;
      l.words.forEach((w, i) => {
        const lead = i > 0 && w.sp ? " " : "";
        if (lead) spaces++;
        const prev = chunks[chunks.length - 1];
        if (prev && prev.bold === w.bold && prev.underline === w.underline && prev.strike === w.strike) prev.text += lead + w.text;
        else chunks.push({ text: lead + w.text, bold: w.bold, underline: w.underline, strike: w.strike });
      });
      return { chunks, natural: l.width, spaces, last: idx === lines.length - 1 };
    });
  }

  paraHeight(p: Para, width: number): number {
    const base: Dir = p.forceLtr || !isRtlText(p.words.map((w) => w.text).join(" ")) ? "L" : "R";
    const lines = this.wrap(p, width - p.indent - (p.bullet ? 14 : 0), base);
    return p.before + lines.length * p.size * 1.85 + p.after;
  }

  drawPara(p: Para, x: number, width: number, breakPages = true) {
    const text = p.words.map((w) => w.text).join(" ");
    const base: Dir = p.forceLtr || !isRtlText(text) ? "L" : "R";
    const align: Align = p.align ?? (base === "R" ? "right" : "left");
    const bulletW = p.bullet ? 14 : 0;
    const innerW = width - p.indent - bulletW;
    const innerX = base === "R" ? x : x + p.indent + bulletW;
    const lh = p.size * 1.85;
    const lines = this.wrap(p, innerW, base);
    this.y += p.before;
    lines.forEach((l, i) => {
      // رسم برشی سلول: خطوطی که کاملاً بیرون پنجره‌ی همین برش‌اند فقط جا را می‌گیرند
      if (this.win && (this.y + lh <= this.win.y0 + 0.01 || this.y >= this.win.y1 - 0.01)) {
        this.y += lh;
        return;
      }
      if (breakPages) this.ensure(lh);
      const y = this.y;
      const extra = 0; // تراز justify به‌صورت تراز ابتدای خط (راست/چپ) اجرا می‌شود
      if (p.quote) {
        const qx = base === "R" ? x + width - p.indent + 6 : x + p.indent - 8;
        this.doc.save().lineWidth(1.6).strokeColor("#c9d3d6").moveTo(qx, y).lineTo(qx, y + lh).stroke().restore();
      }
      if (i === 0 && p.bullet) {
        const bx = base === "R" ? x + width - p.indent - bulletW : x + p.indent;
        this.drawChunks([{ text: p.bullet, bold: false, underline: false, strike: false }], bx, bulletW, y, p.size, base === "R" ? "right" : "left", base);
      }
      const area = base === "R" ? { x, w: width - p.indent - bulletW } : { x: innerX, w: innerW };
      this.drawChunks(l.chunks, area.x, area.w, y, p.size, align, base, INK, extra);
      this.y += lh;
    });
    this.y += p.after;
  }

  blocks(blocks: Block[], x: number, width: number, breakPages = true) {
    for (const b of blocks) {
      if (b.type === "hr") {
        if (breakPages) this.ensure(14);
        this.doc.save().lineWidth(0.6).strokeColor("#cfd6d8").moveTo(x, this.y + 4).lineTo(x + width, this.y + 4).stroke().restore();
        this.y += 14;
      } else if (b.type === "para") {
        // پاراگراف را کامل در صفحه نگه می‌داریم تا عنوان‌ها تنها نمانند
        if (breakPages && b.para.size >= 12) this.ensure(b.para.size * 1.85 * 3);
        this.drawPara(b.para, x, width, breakPages);
      } else {
        this.table(b.rows, x, width);
      }
    }
  }

  blocksHeight(blocks: Block[], width: number): number {
    let h = 0;
    for (const b of blocks) {
      if (b.type === "hr") h += 14;
      else if (b.type === "para") h += this.paraHeight(b.para, width);
      else h += this.tableHeight(b.rows, width);
    }
    return h;
  }

  /** ارتفاع واقعی جدول (پیش‌تر برای جدول تودرتو ۲۴ واحد به‌ازای هر ردیف فرض می‌شد) */
  tableHeight(rows: Block[][][], width: number): number {
    const cols = maxCols(rows);
    const colW = width / cols;
    let h = 8;
    for (const row of rows) h += this.rowHeight(row, colW);
    return h;
  }

  private rowHeight(row: Block[][], colW: number): number {
    let m = 22;
    for (const cell of row) m = Math.max(m, this.blocksHeight(cell, colW - TABLE_PAD * 2));
    return m + TABLE_PAD;
  }

  /** نقاط مجاز برش (ارتفاع تجمعی انتهای هر خط) برای شکستن ردیف‌های بلندتر از یک صفحه */
  private breakpoints(blocks: Block[], width: number): number[] {
    const pts: number[] = [];
    let off = 0;
    for (const b of blocks) {
      if (b.type === "hr") {
        off += 14;
        pts.push(off);
      } else if (b.type === "para") {
        const p = b.para;
        const base: Dir = p.forceLtr || !isRtlText(p.words.map((w) => w.text).join(" ")) ? "L" : "R";
        const n = this.wrap(p, width - p.indent - (p.bullet ? 14 : 0), base).length;
        const lh = p.size * 1.85;
        off += p.before;
        for (let i = 0; i < n; i++) {
          off += lh;
          if (i < n - 1) pts.push(off);
        }
        off += p.after;
        pts.push(off);
      } else {
        off += this.tableHeight(b.rows, width);
        pts.push(off);
      }
    }
    return pts;
  }

  table(rows: Block[][][], x: number, width: number) {
    const cols = maxCols(rows);
    const colW = width / cols;
    const pad = TABLE_PAD;
    const pageH = PAGE_H - TOP - BOTTOM;
    const paginate = this.nested === 0;
    for (const row of rows) {
      const h = this.rowHeight(row, colW);
      // PDF-03: ردیفی بلندتر از «یک صفحه‌ی کامل» دیگر از پایین صفحه بیرون نمی‌زند؛ برش‌برش در صفحه‌های پیاپی رسم می‌شود
      if (paginate && h > pageH) {
        this.splitRow(row, x, width, colW);
        continue;
      }
      if (paginate) this.ensure(Math.min(h, pageH));
      const top = this.y;
      this.drawRowBand(row, x, width, colW, top, h, null);
      this.y = top + h;
    }
    this.y += 8;
  }

  /** یک نوار از ردیف: کادر سلول‌ها + محتوا (در حالت برشی، محتوا با پنجره‌ی برش و انتقال عمودی رسم می‌شود) */
  private drawRowBand(row: Block[][], x: number, width: number, colW: number, top: number, bandH: number, slice: { consumed: number[]; cuts: number[] } | null) {
    const pad = TABLE_PAD;
    row.forEach((cell, i) => {
      const cx = x + width - (i + 1) * colW; // ستون اول سمت راست
      this.doc.save().lineWidth(0.6).strokeColor("#b7c1c4").rect(cx, top, colW, bandH).stroke().restore();
      if (slice && slice.cuts[i] <= slice.consumed[i]) return;
      this.nested++;
      if (slice) {
        this.doc.save().rect(cx, top, colW, bandH).clip();
        this.win = { y0: top + pad / 2, y1: top + pad / 2 + (slice.cuts[i] - slice.consumed[i]) };
        this.y = top + pad / 2 - slice.consumed[i];
      } else this.y = top + pad / 2;
      try {
        this.blocks(cell, cx + pad, colW - pad * 2, false);
      } finally {
        this.nested--;
        if (slice) {
          this.win = null;
          this.doc.restore();
        }
      }
    });
  }

  private splitRow(row: Block[][], x: number, width: number, colW: number) {
    const pad = TABLE_PAD;
    const inner = colW - pad * 2;
    const bps = row.map((c) => this.breakpoints(c, inner));
    const totals = bps.map((b) => (b.length ? b[b.length - 1] : 0));
    let consumed = row.map(() => 0);
    const EPS = 0.01;
    let guard = 0;
    while (consumed.some((c, i) => c < totals[i] - EPS)) {
      if (++guard > 5000) break; // قطع‌کننده‌ی ایمنی؛ هر دور دست‌کم یک خط پیش می‌رود
      const nextBreak = (i: number) => bps[i].find((b) => b > consumed[i] + EPS) ?? totals[i];
      let avail = PAGE_H - BOTTOM - this.y - pad;
      const minStep = Math.min(...row.map((_, i) => (consumed[i] >= totals[i] - EPS ? Infinity : nextBreak(i) - consumed[i])));
      if (avail < minStep && this.y > TOP + 1) {
        this.newPage();
        avail = PAGE_H - BOTTOM - this.y - pad;
      }
      const cuts = row.map((_, i) => {
        if (consumed[i] >= totals[i] - EPS) return consumed[i];
        let cut = consumed[i];
        for (const b of bps[i]) if (b > consumed[i] + EPS && b - consumed[i] <= avail) cut = b;
        return cut > consumed[i] + EPS ? cut : nextBreak(i); // پیشروی اجباری (مثلاً جدول تودرتوی بزرگ‌تر از صفحه)
      });
      const content = Math.max(...cuts.map((c, i) => c - consumed[i]));
      const bandH = content + pad;
      const top = this.y;
      this.drawRowBand(row, x, width, colW, top, bandH, { consumed, cuts });
      consumed = cuts;
      this.y = top + bandH;
    }
  }

  /**
   * PDF-06: کوتاه‌کردن با «…» تا متن در عرض موجود جا شود (برچسب تک‌خطی هرگز از کادر/ستون مجاور بیرون نمی‌زند).
   * برش روی «متن منطقی» انجام می‌شود (نه روی خروجی bidi) و «…» به انتهای منطقی می‌چسبد.
   */
  fitText(text: string, bold: boolean, size: number, maxW: number, base: Dir): string {
    if (maxW <= 0 || this.width(text, bold, size, base) <= maxW) return text;
    const chars = Array.from(text);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.width(`${chars.slice(0, mid).join("").trimEnd()}…`, bold, size, base) <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return `${chars.slice(0, lo).join("").trimEnd()}…`;
  }

  /** یک برچسب تک‌خطی (راست‌چین). `minSize`: پیش از کوتاه‌کردن، اندازه‌ی قلم تا این حد کوچک می‌شود (برای عنوان‌ها) */
  label(text: string, opts: { x?: number; w?: number; size?: number; bold?: boolean; color?: string; align?: Align; y?: number; minSize?: number } = {}) {
    let size = opts.size ?? 10;
    const base: Dir = isRtlText(text) ? "R" : "L";
    const align = opts.align ?? (base === "R" ? "right" : "left");
    const avail = opts.w ?? CONTENT_W;
    const bold = !!opts.bold;
    let shown = text;
    if (opts.minSize && opts.minSize < size) while (size > opts.minSize && this.width(shown, bold, size, base) > avail) size -= 0.5;
    shown = this.fitText(shown, bold, size, avail, base);
    this.drawChunks([{ text: shown, bold, underline: false, strike: false }], opts.x ?? MARGIN_X, avail, opts.y ?? this.y, size, align, base, opts.color ?? INK);
  }
}

const TABLE_PAD = 6;
const maxCols = (rows: Block[][][]): number => {
  let m = 1;
  for (const r of rows) if (r.length > m) m = r.length;
  return m;
};
