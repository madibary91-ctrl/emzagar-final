import { safeUnzipSync, UnzipError } from "@/lib/safe-unzip";
import { Parser } from "htmlparser2";

/**
 * خواندن CSV و XLSX بدون وابستگی خارجی سنگین (فقط fflate + htmlparser2 که پیش‌تر در پروژه بودند).
 * خروجی: ردیف اول = سرستون‌ها. همه‌ی مقدارها رشته‌اند؛ ارقام فارسی دست‌نخورده می‌مانند.
 * محدودیت‌ها (ضد سوءاستفاده): حجم فایل، تعداد ردیف/ستون، طول سلول و حجم باز‌شده‌ی zip.
 */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 2000;
export const MAX_COLS = 60;
const MAX_CELL = 2000;
const MAX_UNZIPPED = 40 * 1024 * 1024;

export class SheetError extends Error {}
export interface ParsedSheet {
  headers: string[];
  rows: string[][];
  truncated: boolean;
}

const clean = (s: string) => s.replace(/\u0000/g, "").replace(/[\u200e\u200f\u202a-\u202e]/g, "").trim().slice(0, MAX_CELL);

/* ───────── CSV ───────── */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestN = -1;
  for (const d of [",", ";", "\t", "|", "،"]) {
    let n = 0;
    let q = false;
    for (const ch of firstLine) {
      if (ch === '"') q = !q;
      else if (!q && ch === d) n++;
    }
    if (n > bestN) {
      bestN = n;
      best = d;
    }
  }
  return best;
}

export function parseCsvText(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const d = detectDelimiter(text);
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    if (row.some((c) => c.trim() !== "")) out.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") q = true;
    else if (ch === d) pushCell();
    else if (ch === "\n") pushRow();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow();
    } else cell += ch;
    if (out.length > MAX_ROWS + 5) break;
  }
  if (cell !== "" || row.length) pushRow();
  return out;
}

/* ───────── XLSX ───────── */
const colIndex = (ref: string): number => {
  const m = /^([A-Z]+)/i.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  let inSi = false;
  let inT = false;
  let skip = 0; // rPh (آوانگاری) نادیده گرفته می‌شود
  let cur = "";
  const p = new Parser(
    {
      onopentag(name) {
        if (name === "si") {
          inSi = true;
          cur = "";
        } else if (name === "rPh") skip++;
        else if (name === "t" && inSi && skip === 0) inT = true;
      },
      ontext(t) {
        if (inT) cur += t;
      },
      onclosetag(name) {
        if (name === "t") inT = false;
        else if (name === "rPh") skip = Math.max(0, skip - 1);
        else if (name === "si") {
          out.push(cur);
          inSi = false;
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  p.write(xml);
  p.end();
  return out;
}

function numText(v: string): string {
  const s = v.trim();
  if (/^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && Math.abs(n) < 1e15) return String(Math.round(n * 1e6) / 1e6);
  }
  return s;
}

export function parseXlsxBuffer(buf: Uint8Array): string[][] {
  let files: Record<string, Uint8Array>;
  try {
    // M-02: سقف روی بایت‌های «واقعی» اینفلیت‌شده است (نه اندازه‌ی اعلام‌شده‌ی هدر) و CPU محدود می‌ماند
    files = safeUnzipSync(buf, {
      filter: (f) => f.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name),
      maxFileBytes: MAX_UNZIPPED,
      maxTotalBytes: MAX_UNZIPPED,
    });
  } catch (e) {
    if (e instanceof SheetError) throw e;
    if (e instanceof UnzipError && e.code === "too_large") throw new SheetError("فایل اکسل بیش از حد بزرگ است");
    throw new SheetError("فایل اکسل معتبر نیست یا آسیب دیده است (فقط فرمت .xlsx پشتیبانی می‌شود)");
  }
  const dec = new TextDecoder("utf-8");
  const sheetName = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")))[0];
  if (!sheetName) throw new SheetError("هیچ برگه‌ای در فایل اکسل پیدا نشد");
  const shared = files["xl/sharedStrings.xml"] ? parseSharedStrings(dec.decode(files["xl/sharedStrings.xml"])) : [];

  const rows: string[][] = [];
  let curRow: string[] | null = null;
  let type = "";
  let col = -1;
  let inV = false;
  let inT = false;
  let val = "";
  let rowsSeen = 0;
  const p = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "row") {
          curRow = [];
          rowsSeen++;
        } else if (name === "c" && curRow) {
          type = attrs.t ?? "n";
          col = attrs.r ? colIndex(attrs.r) : curRow.length;
          val = "";
        } else if (name === "v") inV = true;
        else if (name === "t" && type === "inlineStr") inT = true;
      },
      ontext(t) {
        if (inV || inT) val += t;
      },
      onclosetag(name) {
        if (name === "v") inV = false;
        else if (name === "t") inT = false;
        else if (name === "c" && curRow && col >= 0 && col < MAX_COLS) {
          let text = val;
          if (type === "s") text = shared[Number(val)] ?? "";
          else if (type === "b") text = val === "1" ? "TRUE" : "FALSE";
          else if (type === "n") text = numText(val);
          while (curRow.length < col) curRow.push("");
          curRow[col] = text;
        } else if (name === "row" && curRow) {
          if (curRow.some((c) => (c ?? "").trim() !== "")) rows.push(curRow.map((c) => c ?? ""));
          curRow = null;
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  const xml = dec.decode(files[sheetName]);
  p.write(xml);
  p.end();
  void rowsSeen;
  return rows;
}

/** تشخیص نوع از «امضای فایل» (نه فقط پسوند) و خواندن */
export function parseSpreadsheet(buf: Uint8Array, fileName: string): ParsedSheet {
  if (buf.byteLength === 0) throw new SheetError("فایل خالی است");
  if (buf.byteLength > MAX_FILE_BYTES) throw new SheetError("حجم فایل بیش از ۵ مگابایت است");
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  const isOldXls = buf[0] === 0xd0 && buf[1] === 0xcf;
  if (isOldXls) throw new SheetError("فرمت قدیمی .xls پشتیبانی نمی‌شود؛ فایل را به .xlsx یا CSV ذخیره کنید");
  let raw: string[][];
  if (isZip) {
    if (!/\.xlsx$/i.test(fileName) && !/\.xlsm$/i.test(fileName)) throw new SheetError("فقط فایل‌های xlsx ،csv پذیرفته می‌شوند");
    raw = parseXlsxBuffer(buf);
  } else {
    if (!/\.(csv|txt|tsv)$/i.test(fileName)) throw new SheetError("فقط فایل‌های xlsx ،csv پذیرفته می‌شوند");
    const head = buf.subarray(0, 4096);
    if (head.includes(0)) throw new SheetError("این فایل متنی/CSV معتبر نیست");
    raw = parseCsvText(new TextDecoder("utf-8").decode(buf));
  }
  if (raw.length < 2) throw new SheetError("فایل باید دست‌کم یک سطر سرستون و یک سطر داده داشته باشد");
  const width = Math.min(MAX_COLS, Math.max(...raw.slice(0, 50).map((r) => r.length)));
  const headers = Array.from({ length: width }, (_, i) => clean(raw[0][i] ?? "") || `ستون ${i + 1}`);
  // سرستون‌های تکراری یکتا می‌شوند
  const seen = new Map<string, number>();
  const uniq = headers.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h} (${n})`;
  });
  const dataRows = raw.slice(1);
  const truncated = dataRows.length > MAX_ROWS;
  const rows = dataRows.slice(0, MAX_ROWS).map((r) => uniq.map((_, i) => clean(r[i] ?? "")));
  return { headers: uniq, rows, truncated };
}
