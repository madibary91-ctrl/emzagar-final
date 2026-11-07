import path from "node:path";
import PDFDocument from "pdfkit";
import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import QRCode from "qrcode";
import { inspectPng } from "@/lib/png";
import { isRtlText, toFaDigits, visualSegments, type Dir } from "./text";

/* ═════════════ مدل داده‌ی ورودی ═════════════ */

export interface PdfSigner {
  label: string;
  name: string;
  mobileMasked: string;
  signedAtText: string;
  ip: string;
  methodText: string;
  otpVerified: boolean;
  signature: Buffer | null;
}

export interface PdfInput {
  siteName: string;
  number: string;
  title: string;
  customerName: string;
  issuedAtText: string;
  completedAtText: string;
  bodyHtml: string;
  signers: PdfSigner[];
  docHash: string;
  verifyUrl: string;
}

/* ═════════════ تنظیمات صفحه و قلم ═════════════ */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 54;
const TOP = 92;
const BOTTOM = 64;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const RIGHT = PAGE_W - MARGIN_X;
const INK = "#102c31";
const MUTED = "#6b7280";

const fontDir = () => process.env.PDF_FONT_DIR || path.join(process.cwd(), "assets", "fonts");
const REGULAR = "Vazir";
const BOLD = "Vazir-Bold";

/** حذف نویسه‌های کنترلی جهت (Intl فارسی آن‌ها را می‌گذارد) که در قلم گلیف ندارند */
const clean = (s: string) => s.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
/**
 * PDFKit/fontkit در قطعه‌های راست‌به‌چپ، فاصله‌ی معمولی (U+0020) را جابه‌جا می‌کند و کلمات می‌چسبند؛
 * فاصله‌ی ناشکن (U+00A0) درست رسم می‌شود. بنابراین هنگام اندازه‌گیری و رسم، فاصله‌ها NBSP می‌شوند.
 */
const nb = (s: string) => s.replace(/ /g, "\u00a0");

/* ═════════════ تبدیل HTML قرارداد به بلوک‌ها ═════════════ */

interface Word {
  text: string;
  /** پیش از این کلمه فاصله هست؟ (کلمه‌های چسبیده مثل <b>ab</b>c فاصله نمی‌گیرند) */
  sp: boolean;
  bold: boolean;
  underline: boolean;
  strike: boolean;
}
type Align = "right" | "left" | "center" | "justify";
interface Para {
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
type Block = { type: "para"; para: Para } | { type: "hr" } | { type: "table"; rows: Block[][][] };

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

function htmlToBlocks(nodes: ChildNode[], base: Partial<Ctx> = {}): Block[] {
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

/* ═════════════ نویسنده‌ی PDF ═════════════ */

type Doc = InstanceType<typeof PDFDocument>;

interface Chunk {
  text: string;
  bold: boolean;
  underline: boolean;
  strike: boolean;
}

class Writer {
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

/* ═════════════ ساخت سند ═════════════ */

export async function renderContractPdf(input: PdfInput): Promise<Buffer> {
  const dir = fontDir();
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: TOP, bottom: BOTTOM, left: MARGIN_X, right: MARGIN_X },
    bufferPages: true,
    font: path.join(dir, "Vazirmatn-Regular.ttf"),
    info: {
      Title: clean(`${input.title} — ${input.number}`),
      Author: clean(input.siteName),
      Subject: "قرارداد امضاشده",
      Keywords: `contract:${input.number}; sha256:${input.docHash}`,
      Creator: "Emzagar",
      Producer: "Emzagar PDF Engine",
    },
  });
  doc.registerFont(REGULAR, path.join(dir, "Vazirmatn-Regular.ttf"));
  doc.registerFont(BOLD, path.join(dir, "Vazirmatn-Bold.ttf"));

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const w = new Writer(doc);

  // عنوان
  w.label(input.title, { size: 19, bold: true });
  w.y += 19 * 1.85;
  w.label(`مشتری: ${input.customerName}   |   تاریخ صدور: ${input.issuedAtText}   |   تاریخ تکمیل: ${input.completedAtText}`, { size: 9, color: MUTED });
  w.y += 22;
  doc.save().lineWidth(1).strokeColor(INK).moveTo(MARGIN_X, w.y).lineTo(RIGHT, w.y).stroke().restore();
  w.y += 14;

  // متن قرارداد
  const root = parseDocument(input.bodyHtml || "");
  w.blocks(htmlToBlocks(root.children), MARGIN_X, CONTENT_W);

  // بخش امضاها
  w.y += 8;
  w.ensure(110);
  w.label("امضاکنندگان و شناسنامه‌ی دیجیتال", { size: 13, bold: true });
  w.y += 13 * 1.85 + 4;
  for (const s of input.signers) {
    const boxH = 92;
    w.ensure(boxH + 8);
    const top = w.y;
    doc.save().lineWidth(0.8).strokeColor("#b7c1c4").roundedRect(MARGIN_X, top, CONTENT_W, boxH, 6).stroke().restore();
    const tx = MARGIN_X + 150;
    const tw = CONTENT_W - 150 - 10;
    w.label(`${s.label} — ${s.name}`, { x: tx, w: tw, y: top + 8, size: 11, bold: true });
    w.label(`زمان امضا: ${s.signedAtText}`, { x: tx, w: tw, y: top + 28, size: 9, color: MUTED });
    w.label(`تأیید هویت: ${s.otpVerified ? "کد یکبارمصرف پیامکی" : "—"}   |   موبایل: ${s.mobileMasked || "—"}`, { x: tx, w: tw, y: top + 44, size: 9, color: MUTED });
    w.label(`روش امضا: ${s.methodText}   |   IP: ${s.ip || "—"}`, { x: tx, w: tw, y: top + 60, size: 9, color: MUTED });
    // تصویر امضا پیش از رمزگشایی ساختاری سنجیده می‌شود (فایل‌های قدیمی/دست‌کاری‌شده روی دیسک هم بمب فشرده‌سازی نمی‌شوند)
    if (s.signature && inspectPng(s.signature).ok) {
      try {
        doc.image(s.signature, MARGIN_X + 12, top + 12, { fit: [124, 64], align: "center", valign: "center" });
      } catch {
        /* تصویر خراب: فقط جای امضا خالی می‌ماند */
      }
    }
    w.y = top + boxH + 8;
  }

  // اثر انگشت و QR
  w.ensure(104);
  const top = w.y + 4;
  doc.save().lineWidth(0.8).strokeColor("#b7c1c4").roundedRect(MARGIN_X, top, CONTENT_W, 92, 6).stroke().restore();
  const qr = input.verifyUrl ? await QRCode.toBuffer(input.verifyUrl, { type: "png", margin: 1, width: 240, errorCorrectionLevel: "M" }) : null;
  if (qr) doc.image(qr, MARGIN_X + 10, top + 8, { fit: [76, 76] });
  const ix = MARGIN_X + 96;
  const iw = CONTENT_W - 96 - 10;
  w.label("اثر انگشت سند (SHA-256 محتوای قرارداد و امضاها)", { x: ix, w: iw, y: top + 10, size: 10, bold: true });
  w.label(input.docHash, { x: ix, w: iw, y: top + 32, size: 7.5, align: "left" });
  w.label("برای استعلام اصالت، QR را اسکن کنید یا آدرس زیر را باز کنید:", { x: ix, w: iw, y: top + 50, size: 8.5, color: MUTED });
  w.label(input.verifyUrl || "—", { x: ix, w: iw, y: top + 68, size: 7.5, align: "left", color: MUTED });
  w.y = top + 100;

  // سرصفحه و پاورقی همه‌ی صفحه‌ها (پس از دانستن تعداد صفحات)
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const m = doc.page.margins;
    doc.page.margins = { top: 0, bottom: 0, left: m.left, right: m.right }; // رسم در حاشیه، صفحه‌ی جدید نمی‌سازد
    const hw = new Writer(doc);
    hw.label(input.siteName, { y: 30, size: 12, bold: true });
    hw.label(input.number, { y: 32, size: 9, align: "left", color: MUTED });
    doc.save().lineWidth(0.6).strokeColor("#cfd6d8").moveTo(MARGIN_X, 56).lineTo(RIGHT, 56).stroke().restore();
    doc.save().lineWidth(0.6).strokeColor("#cfd6d8").moveTo(MARGIN_X, PAGE_H - 46).lineTo(RIGHT, PAGE_H - 46).stroke().restore();
    hw.label(`صفحه ${toFaDigits(i + 1)} از ${toFaDigits(range.count)}`, { y: PAGE_H - 38, size: 8.5, color: MUTED, align: "center" });
    hw.label(`SHA-256: ${input.docHash.slice(0, 32)}…`, { y: PAGE_H - 38, size: 7, color: MUTED, align: "left" });
    hw.label("سند الکترونیکی معتبر", { y: PAGE_H - 38, size: 8.5, color: MUTED });
    doc.page.margins = m;
  }

  doc.end();
  return done;
}
