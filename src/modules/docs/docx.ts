import { strFromU8 } from "fflate";
import { safeUnzipSync } from "@/lib/safe-unzip";
import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { escapeHtml } from "@/lib/html";

/**
 * مبدل سبک Word (.docx) ← HTML ایمن، بدون نیاز به LibreOffice.
 * پشتیبانی: پاراگراف، عنوان‌ها، پررنگ/کج/زیرخط/خط‌خورده، فهرست، جدول (ساده)، خط جدید، تب.
 * تصویرها و جعبه‌های متن منتقل نمی‌شوند (تعداد آن‌ها برای هشدار به کاربر برمی‌گردد).
 */
const MAX_XML = 25 * 1024 * 1024;
/** M-02: سقف «واقعی» مجموع بایت‌های بازشده (همه‌ی بخش‌های XML یک سند) */
const MAX_XML_TOTAL = 40 * 1024 * 1024;
const unzipPick = (buf: Uint8Array, pick: (name: string) => boolean, onSkip?: (name: string, declared: number) => void) =>
  safeUnzipSync(buf, { filter: (f) => pick(f.name), onSkip: onSkip ? (f) => onSkip(f.name, f.declaredSize) : undefined, maxFileBytes: MAX_XML, maxTotalBytes: MAX_XML_TOTAL });

export interface DocxResult {
  html: string;
  textLength: number;
  skippedImages: number;
}

const kids = (n: ChildNode): ChildNode[] => ((n as Element).children ?? []) as ChildNode[];
const isEl = (n: ChildNode): n is Element => n.type === "tag";
const name = (n: Element) => n.name.toLowerCase();
const attr = (n: Element, k: string) => n.attribs?.[k] ?? n.attribs?.[k.toLowerCase()];
const find = (n: Element, tag: string) => kids(n).find((c): c is Element => isEl(c) && name(c) === tag);
const flagOn = (n: Element | undefined) => !!n && !["0", "false", "off", "none"].includes(String(attr(n, "w:val") ?? "").toLowerCase());

export function isDocxBuffer(buf: Buffer): boolean {
  if (buf.length < 4 || buf.subarray(0, 4).toString("hex") !== "504b0304") return false;
  try {
    const files = unzipPick(new Uint8Array(buf), (n) => n === "word/document.xml");
    return !!files["word/document.xml"];
  } catch {
    return false;
  }
}

export interface DocxInspection {
  /** تصویر، مهر/امضای اسکن‌شده، لوگو، شکل، جعبه‌ی متن یا شیء جاسازی‌شده — در هر بخش فایل (بدنه، سرصفحه، پاصفحه، پانویس…) */
  hasVisuals: boolean;
  /** فایل‌های تصویری/شیء داخل بسته‌ی docx (word/media و word/embeddings) */
  mediaFiles: number;
  /** بخش‌هایی که شیء گرافیکی دارند (برای پیام دقیق‌تر) */
  visualParts: string[];
  /** متن در سرصفحه/پاصفحه/پانویس/یادداشت پایانی — مبدل داخلی آن‌ها را به PDF منتقل نمی‌کند */
  hasUnconvertedText: boolean;
}

const MEDIA_RE = /^word\/(media|embeddings)\/[^/]+$/i;
const XML_PART_RE = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/i;
const SIDE_PART_RE = /^word\/(header\d*|footer\d*|footnotes|endnotes)\.xml$/i;
// هر نشانه‌ی شیء گرافیکی در OOXML (DrawingML / VML / OLE / جعبه‌ی متن)
const VISUAL_RE = /<(w:drawing|w:pict|w:object|a:blip|v:imagedata|v:shape|v:rect|v:oval|wps:wsp|w:txbxContent|pic:pic|mc:AlternateContent)[\s>/]/;

/**
 * بررسی «بدون تبدیل» فایل Word: آیا چیزی دارد که مبدل داخلی آن را از سند حذف می‌کند؟
 * مهر و امضای اسکن‌شده در Word تصویر است؛ حذف بی‌صدای آن سند را از نظر حقوقی ناقص می‌کند.
 * بررسی دو لایه است (فهرست فایل‌های ZIP + اسکن XML همه‌ی بخش‌های سند) تا تصویر در سرصفحه/پاصفحه،
 * AlternateContent، جعبه‌ی متن و تصاویر پیوندی هم از چشم نیفتد.
 */
export function inspectDocx(buf: Buffer): DocxInspection {
  let mediaFiles = 0;
  const files = unzipPick(
    new Uint8Array(buf),
    (n) => XML_PART_RE.test(n),
    (n, declared) => {
      if (MEDIA_RE.test(n) && declared > 0) mediaFiles++; // محتوای تصویر لازم نیست؛ فقط وجودش (بدون اینفلیت)
    },
  );
  const visualParts: string[] = [];
  let hasUnconvertedText = false;
  for (const [file, data] of Object.entries(files)) {
    const xml = strFromU8(data);
    if (VISUAL_RE.test(xml)) visualParts.push(file.replace(/^word\//, "").replace(/\.xml$/i, ""));
    if (SIDE_PART_RE.test(file) && /<w:t(\s[^>]*)?>[^<]*\S[^<]*<\/w:t>/.test(xml)) hasUnconvertedText = true;
  }
  return { hasVisuals: mediaFiles > 0 || visualParts.length > 0, mediaFiles, visualParts, hasUnconvertedText };
}

export function docxToHtml(buf: Buffer): DocxResult {
  const files = unzipPick(new Uint8Array(buf), (n) => n === "word/document.xml");
  const xml = files["word/document.xml"];
  if (!xml) throw new Error("فایل Word معتبر نیست");
  const root = parseDocument(strFromU8(xml), { xmlMode: true });
  let textLength = 0;
  let skippedImages = 0;

  const runHtml = (r: Element): string => {
    const rPr = find(r, "w:rpr");
    const b = rPr && flagOn(find(rPr, "w:b"));
    const i = rPr && flagOn(find(rPr, "w:i"));
    const uEl = rPr && find(rPr, "w:u");
    const u = !!uEl && String(attr(uEl, "w:val") ?? "single") !== "none";
    const s = rPr && flagOn(find(rPr, "w:strike"));
    let out = "";
    for (const c of kids(r)) {
      if (!isEl(c)) continue;
      const t = name(c);
      if (t === "w:t") {
        const txt = kids(c).map((x) => (x.type === "text" ? (x as unknown as { data: string }).data : "")).join("");
        textLength += txt.trim().length;
        out += escapeHtml(txt);
      } else if (t === "w:tab") out += "&nbsp;&nbsp;&nbsp;&nbsp;";
      else if (t === "w:br" || t === "w:cr") out += "<br>";
      else if (t === "w:nobreakhyphen") out += "-";
      else if (t === "w:drawing" || t === "w:pict" || t === "w:object") skippedImages++;
    }
    if (!out) return "";
    if (b) out = `<b>${out}</b>`;
    if (i) out = `<i>${out}</i>`;
    if (u) out = `<u>${out}</u>`;
    if (s) out = `<s>${out}</s>`;
    return out;
  };

  const inline = (n: Element): string => {
    let out = "";
    for (const c of kids(n)) {
      if (!isEl(c)) continue;
      const t = name(c);
      if (t === "w:r") out += runHtml(c);
      else if (t === "w:hyperlink" || t === "w:ins" || t === "w:smarttag" || t === "w:sdt" || t === "w:sdtcontent" || t === "w:fldsimple") out += inline(c);
    }
    return out;
  };

  const paragraph = (p: Element): { html: string; list: boolean } => {
    const pPr = find(p, "w:ppr");
    const style = String(attr(find(pPr ?? p, "w:pstyle") ?? ({ attribs: {} } as Element), "w:val") ?? "").toLowerCase();
    const jc = pPr ? String(attr(find(pPr, "w:jc") ?? ({ attribs: {} } as Element), "w:val") ?? "") : "";
    const list = !!pPr && !!find(pPr, "w:numpr");
    let content = inline(p);
    const h = /^(heading|عنوان)\s*([1-4])$/.exec(style);
    const isTitle = style === "title";
    if (!content.trim() && !list) return { html: "<p>&nbsp;</p>", list: false };
    const align = jc === "center" ? ' style="text-align:center"' : "";
    if (list) return { html: `<li>${content}</li>`, list: true };
    if (h || isTitle) {
      content = content.replace(/<\/?b>/g, "");
      return { html: `<h${h ? h[2] : 1}${align}>${content}</h${h ? h[2] : 1}>`, list: false };
    }
    return { html: `<p${align}>${content}</p>`, list: false };
  };

  const blocks = (container: Element): string => {
    let out = "";
    let inList = false;
    const closeList = () => {
      if (inList) out += "</ul>";
      inList = false;
    };
    for (const c of kids(container)) {
      if (!isEl(c)) continue;
      const t = name(c);
      if (t === "w:p") {
        const r = paragraph(c);
        if (r.list && !inList) {
          out += "<ul>";
          inList = true;
        } else if (!r.list) closeList();
        out += r.html;
      } else if (t === "w:tbl") {
        closeList();
        let rows = "";
        for (const tr of kids(c)) {
          if (!isEl(tr) || name(tr) !== "w:tr") continue;
          let cells = "";
          for (const tc of kids(tr)) if (isEl(tc) && name(tc) === "w:tc") cells += `<td>${blocks(tc) || "&nbsp;"}</td>`;
          if (cells) rows += `<tr>${cells}</tr>`;
        }
        if (rows) out += `<table>${rows}</table>`;
      } else if (t === "w:sdt" || t === "w:sdtcontent" || t === "w:body") {
        closeList();
        out += blocks(c);
      }
    }
    closeList();
    return out;
  };

  const body = root.children.flatMap((n) => (isEl(n) ? [n] : [])).flatMap((d) => kids(d).filter(isEl)).find((n) => name(n) === "w:body");
  const html = body ? blocks(body) : "";
  return { html, textLength, skippedImages };
}
