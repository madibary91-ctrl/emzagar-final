import { type Align, BOLD, BOTTOM, type Block, CONTENT_W, INK, MARGIN_X, PAGE_H, type Para, REGULAR, TOP, type Word, clean, nb } from "./layout";
import { type Dir, isRtlText, visualSegments } from "../text";
import PDFDocument from "pdfkit";

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
  constructor(readonly doc: Doc) {}

  setFont(bold: boolean, size: number) {
    this.doc.font(bold ? BOLD : REGULAR).fontSize(size);
  }

  width(text: string, bold: boolean, size: number, base: Dir = "R"): number {
    this.setFont(bold, size);
    let w = 0;
    for (const seg of visualSegments(clean(text), base)) w += this.doc.widthOfString(nb(seg.text));
    return w;
  }

  ensure(h: number) {
    if (this.y + h > PAGE_H - BOTTOM) this.newPage();
  }

  newPage() {
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

  /** شکستن کلمات یک پاراگراف به خطوط */
  wrap(p: Para, maxW: number, base: Dir): { chunks: Chunk[]; natural: number; spaces: number; last: boolean }[] {
    const lines: { words: Word[]; width: number }[] = [];
    let line: Word[] = [];
    let lw = 0;
    const spaceW = this.width(" ", false, p.size) || p.size * 0.25;
    for (const w of p.words) {
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
        this.ensure(14);
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
      else h += b.rows.length * 24;
    }
    return h;
  }

  table(rows: Block[][][], x: number, width: number) {
    const cols = Math.max(...rows.map((r) => r.length));
    const colW = width / cols;
    const pad = 6;
    for (const row of rows) {
      const h = Math.max(...row.map((cell) => this.blocksHeight(cell, colW - pad * 2)), 22) + pad;
      this.ensure(Math.min(h, PAGE_H - TOP - BOTTOM));
      const top = this.y;
      row.forEach((cell, i) => {
        const cx = x + width - (i + 1) * colW; // ستون اول سمت راست
        this.doc.save().lineWidth(0.6).strokeColor("#b7c1c4").rect(cx, top, colW, h).stroke().restore();
        this.y = top + pad / 2;
        this.blocks(cell, cx + pad, colW - pad * 2, false);
      });
      this.y = top + h;
    }
    this.y += 8;
  }

  /** یک برچسب تک‌خطی (راست‌چین) */
  label(text: string, opts: { x?: number; w?: number; size?: number; bold?: boolean; color?: string; align?: Align; y?: number } = {}) {
    const size = opts.size ?? 10;
    const base: Dir = isRtlText(text) ? "R" : "L";
    const align = opts.align ?? (base === "R" ? "right" : "left");
    this.drawChunks([{ text, bold: !!opts.bold, underline: false, strike: false }], opts.x ?? MARGIN_X, opts.w ?? CONTENT_W, opts.y ?? this.y, size, align, base, opts.color ?? INK);
  }
}
