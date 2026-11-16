import { assuranceForContract } from "@/modules/identity/service";
import { assuranceText } from "@/modules/identity/rules";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contractDocuments, contracts, contractSigners, users } from "@/db/schema";
import { sanitizeHtml } from "@/lib/html";
import { fa, faTime } from "@/lib/jalali";
import { getOrigin } from "@/lib/request";
import { documentsDir } from "@/lib/storage-paths";
import { sha256Buf as _sha256Buf } from "./hash";
import { createSemaphore, envInt } from "@/lib/semaphore";
import { logAudit } from "@/modules/audit/service";
import { getAllSettings } from "@/modules/settings/service";
import { readSignatureFile } from "@/modules/signing/storage";
import { renderContractPdf, type PdfInput } from "./render";
import { toFaDigits } from "./text";
import { groupByStage, hasParallelStage, stageOf } from "@/modules/signing/stages";
import { renderContractBody } from "@/modules/fields/service";
import { composeSourcePdf } from "@/modules/docs/service";

export class PdfNotReadyError extends Error {
  constructor() {
    super("سند هنوز توسط همه‌ی طرفین امضا نشده است");
    this.name = "PdfNotReadyError";
  }
}

/** فایل ذخیره‌شده با هش ثبت‌شده مطابقت ندارد (دستکاری یا خرابی دیسک) */
export class PdfTamperedError extends Error {
  constructor() {
    super("یکپارچگی فایل PDF تأیید نشد");
    this.name = "PdfTamperedError";
  }
}

/** صف رندر بیش از حد شلوغ است (نه خطای دائمی؛ صف کار بعداً دوباره تلاش می‌کند) */
export class PdfBusyError extends Error {
  constructor() {
    super("صف ساخت PDF شلوغ است؛ کمی بعد دوباره تلاش کنید");
    this.name = "PdfBusyError";
  }
}

/** خطای رندر که تکرارش نتیجه‌ی دیگری نمی‌دهد (سقف صفحه، نبود قلم) — صف کار نباید retry کند */
export const isPermanentPdfError = (e: unknown): boolean => !!e && typeof e === "object" && (e as { permanent?: unknown }).permanent === true;

const safeFile = (n: string) => path.basename(n).replace(/[^a-zA-Z0-9._-]/g, "");
const sha256Buf = _sha256Buf;

export type StoredPdf = { buffer: Buffer; sha256: string; size: number; file: string; createdAt: Date };

async function baseUrl(workspaceId: number): Promise<string> {
  const cfg = await getAllSettings(workspaceId);
  if (cfg.app_url) return cfg.app_url.replace(/\/+$/, "");
  try {
    return await getOrigin();
  } catch {
    return (process.env.APP_URL || "").replace(/\/+$/, "");
  }
}

/** گردآوری داده‌های سند از دیتابیس و پوشه‌ی امضاها */
export async function buildPdfInput(contractId: number): Promise<PdfInput | null> {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  if (!c) return null;
  if (c.status !== "signed" || !c.docHash) throw new PdfNotReadyError();
  const cfg = await getAllSettings(c.workspaceId);
  const [customer] = await db.select({ name: users.name }).from(users).where(eq(users.id, c.customerId));
  const rows = await db
    .select({ s: contractSigners, name: users.name })
    .from(contractSigners)
    .innerJoin(users, eq(users.id, contractSigners.userId))
    .where(eq(contractSigners.contractId, contractId))
    .orderBy(asc(contractSigners.position));
  const base = await baseUrl(c.workspaceId);
  const assurance = await assuranceForContract(contractId);
  return {
    siteName: cfg.site_name,
    number: c.number,
    title: c.title,
    customerName: customer?.name ?? "—",
    issuedAtText: fa(c.issuedAt),
    completedAtText: fa(c.signedAt),
    bodyHtml: await renderContractBody(c.id, sanitizeHtml(c.bodyHtml), "pdf"),
    docHash: c.docHash,
    verifyUrl: base ? `${base}/verify/${c.docHash}` : "",
    signers: await Promise.all(
      rows.map(async ({ s, name }) => ({
        label: s.label,
        name,
        mobileMasked: s.mobile && s.mobile.length >= 8 ? `${s.mobile.slice(0, 4)}***${s.mobile.slice(-4)}` : "",
        signedAtText: faTime(s.signedAt),
        ip: s.ip ?? "",
        methodText: s.signatureMethod === "upload" ? "آپلود تصویر" : "ترسیم",
        otpVerified: !!s.otpVerifiedAt,
        identityText: assurance.has(s.id) ? assuranceText(assurance.get(s.id)!.assurance, { sandbox: assurance.get(s.id)!.sandbox }) : undefined,
        identitySeal: assurance.get(s.id)?.seal || undefined,
        signature: s.signatureFile ? await readSignatureFile(s.signatureFile) : null,
        role: s.role,
        stageText: stageText(s, rows.map((r) => r.s)),
        companyName: s.signerType === "legal" && s.role !== "witness" ? s.companyName : undefined,
        companyNationalId: s.signerType === "legal" && s.role !== "witness" ? s.companyNationalId : undefined,
        signatoryTitle: s.signerType === "legal" && s.role !== "witness" ? s.signatoryTitle : undefined,
        seal: s.sealFile ? await readSignatureFile(s.sealFile) : null,
        sealSha: s.sealSha256 ?? undefined,
        initials: s.initialsFile ? await readSignatureFile(s.initialsFile) : null,
        initialsSha: s.initialsSha256 ?? undefined,
      })),
    ),
  };
}

/** «مرحله‌ی ۲ از ۳» فقط وقتی سند چندمرحله‌ای/هم‌زمان است (برای اسناد ترتیبیِ ساده چیزی اضافه نمی‌شود) */
function stageText(s: { position: number; stage: number }, all: { position: number; stage: number }[]): string | undefined {
  const groups = groupByStage(all);
  if (!hasParallelStage(all)) return undefined;
  const g = groups.find((x) => x.stage === stageOf(s));
  return g ? `مرحله‌ی ${toFaDigits(g.index)} از ${toFaDigits(groups.length)}${g.items.length > 1 ? " (هم‌زمان)" : ""}` : undefined;
}

const inflight = new Map<number, Promise<StoredPdf>>();
/**
 * P-05/P-06: رندر PDF سنگین و CPU‌محور است. صف کارها اکنون هم‌زمان است؛ این سقف تضمین می‌کند حتی با چند کار finalize و چند دانلودِ
 * «اولین‌بار» همزمان، فقط تعداد محدودی PDF هم‌زمان ساخته شود (PDF_RENDER_CONCURRENCY، پیش‌فرض ۲).
 */
const renderSlots = createSemaphore(envInt("PDF_RENDER_CONCURRENCY", 2, 1, 8));
/** PDF-02: سقف «صف انتظار» (پیش‌تر نامحدود بود و هر کار منتظر یک اتصال/بافر زنده نگه می‌داشت) */
const renderQueueMax = () => envInt("PDF_RENDER_QUEUE_MAX", 100, 1, 10_000);

/** PDF-02: فایل‌های موقت `.tmp` یتیم (کرش/قطع برق بین نوشتن و rename) و پاک‌سازی دوره‌ای */
const TMP_MAX_AGE_MS = 60 * 60_000;
let lastTmpSweep = 0;
export async function sweepStalePdfTemps(now = Date.now(), maxAgeMs = TMP_MAX_AGE_MS): Promise<number> {
  let removed = 0;
  let names: string[] = [];
  try {
    names = await fs.readdir(documentsDir());
  } catch {
    return 0;
  }
  for (const n of names) {
    if (!n.endsWith(".tmp")) continue;
    const f = path.join(documentsDir(), n);
    try {
      const st = await fs.stat(f);
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
        await fs.unlink(f);
        removed++;
      }
    } catch {
      /* فایل همزمان حذف/جابه‌جا شد */
    }
  }
  return removed;
}

/** ساخت PDF نهایی روی سرور، ذخیره در پوشه‌ی محافظت‌شده و ثبت SHA-256 فایل. اجرای هم‌زمان یک قرارداد یک‌بار انجام می‌شود. */
export function generateContractPdf(contractId: number): Promise<StoredPdf> {
  const running = inflight.get(contractId);
  if (running) return running;
  const p = doGenerate(contractId).finally(() => inflight.delete(contractId));
  inflight.set(contractId, p);
  return p;
}

async function doGenerate(contractId: number): Promise<StoredPdf> {
  const existing = await readStored(contractId);
  if (existing) return existing;
  const input = await buildPdfInput(contractId);
  if (!input) throw new Error("قرارداد یافت نشد");
  // فاز ۲: قرارداد روی فایل بارگذاری‌شده → همان فایل اصلی + امضاها + گواهی؛ وگرنه PDF متنی قبلی
  if (renderSlots.waiting >= renderQueueMax()) throw new PdfBusyError();
  const buffer = await renderSlots.run(async () => (await composeSourcePdf(contractId, input)) ?? (await renderContractPdf(input)));
  const hash = sha256Buf(buffer);
  const file = safeFile(`${input.number}-${hash.slice(0, 10)}.pdf`);
  await fs.mkdir(documentsDir(), { recursive: true, mode: 0o700 });
  // نوشتن اتمیک: ابتدا فایل موقت، سپس rename
  const target = path.join(documentsDir(), file);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  if (Date.now() - lastTmpSweep > 10 * 60_000) {
    lastTmpSweep = Date.now();
    void sweepStalePdfTemps().catch(() => undefined);
  }
  try {
    await fs.writeFile(tmp, buffer, { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (e) {
    // دیسک پر/خطای نوشتن: فایل نیمه‌نوشته نباید برای همیشه بماند
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
  const inserted = await db
    .insert(contractDocuments)
    .values({ contractId, file, sha256: hash, size: buffer.length })
    .onConflictDoNothing()
    .returning({ createdAt: contractDocuments.createdAt });
  if (inserted.length === 0) {
    // پردازه‌ی دیگری همزمان ساخته است؛ نسخه‌ی او معتبر است (فایل او را پاک نکن اگر نام یکسان است)
    const again = await readStored(contractId);
    if (!again || again.file !== file) await fs.unlink(target).catch(() => undefined);
    if (again) return again;
  }
  await logAudit({ action: "document.generated", contractId, detail: `PDF — SHA-256: ${hash.slice(0, 16)}… — ${Math.round(buffer.length / 1024)}KB`, actor: "system" });
  return { buffer, sha256: hash, size: buffer.length, file, createdAt: inserted[0]?.createdAt ?? new Date() };
}

/** خواندن PDF ذخیره‌شده؛ در صورت مغایرت هش، PdfTamperedError می‌دهد */
async function readStored(contractId: number): Promise<StoredPdf | null> {
  const [doc] = await db.select().from(contractDocuments).where(eq(contractDocuments.contractId, contractId));
  if (!doc) return null;
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(path.join(documentsDir(), safeFile(doc.file)));
  } catch {
    // فایل از دیسک رفته (مثلاً بازیابی ناقص): ردیف را پاک می‌کنیم تا دوباره ساخته شود
    await db.delete(contractDocuments).where(eq(contractDocuments.id, doc.id));
    return null;
  }
  if (sha256Buf(buffer) !== doc.sha256) {
    await logAudit({ action: "document.tampered", contractId, detail: `هش فایل ${doc.file} با مقدار ثبت‌شده نمی‌خواند`, actor: "system" });
    throw new PdfTamperedError();
  }
  return { buffer, sha256: doc.sha256, size: doc.size, file: doc.file, createdAt: doc.createdAt };
}

/** PDF قرارداد امضاشده؛ اگر هنوز ساخته نشده (قراردادهای قدیمی) همین حالا ساخته می‌شود */
export async function getContractPdf(contractId: number): Promise<StoredPdf> {
  return (await readStored(contractId)) ?? generateContractPdf(contractId);
}

export async function getStoredPdfInfo(contractId: number): Promise<{ sha256: string; size: number } | null> {
  const [doc] = await db.select({ sha256: contractDocuments.sha256, size: contractDocuments.size }).from(contractDocuments).where(eq(contractDocuments.contractId, contractId));
  return doc ?? null;
}

export async function deleteContractDocument(contractId: number) {
  const [doc] = await db.select().from(contractDocuments).where(eq(contractDocuments.contractId, contractId));
  if (!doc) return;
  await fs.unlink(path.join(documentsDir(), safeFile(doc.file))).catch(() => undefined);
  await db.delete(contractDocuments).where(eq(contractDocuments.id, doc.id));
}

/* ───────────────────────── P-05: دانلود جریانی با راستی‌آزمایی هش ───────────────────────── */

/** PDF راستی‌آزمایی‌شده برای پاسخ HTTP: بدون بارگذاری کل فایل در حافظه */
export type VerifiedPdf = {
  sha256: string;
  size: number;
  file: string;
  createdAt: Date;
  /** بدنه‌ی پاسخ؛ `range` (شامل دو سر) برای دانلود ادامه‌دار. دانلود کامل هم‌زمان با ارسال دوباره هش می‌شود. */
  stream(range?: { start: number; end: number }): ReadableStream<Uint8Array>;
};

/** هش SHA-256 یک فایل با خواندن جریانی (حافظه‌ی ثابت، بدون Buffer کامل) */
export async function hashFileStreaming(file: string): Promise<{ sha256: string; size: number }> {
  const h = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: h.digest("hex"), size };
}

function toVerified(contractId: number, v: { sha256: string; size: number; file: string; createdAt: Date }): VerifiedPdf {
  const target = path.join(documentsDir(), safeFile(v.file));
  return {
    ...v,
    stream(range) {
      if (range) return Readable.toWeb(createReadStream(target, { start: range.start, end: range.end })) as ReadableStream<Uint8Array>;
      async function* chunks() {
        const h = crypto.createHash("sha256");
        for await (const chunk of createReadStream(target)) {
          h.update(chunk as Buffer);
          yield chunk as Buffer;
        }
        // فایل بین «راستی‌آزمایی» و «ارسال» عوض شده؟ ثبت در ممیزی و قطع پاسخ (دانلود ناقص = رد شدن در کلاینت)
        if (h.digest("hex") !== v.sha256) {
          await logAudit({ action: "document.tampered", contractId, detail: `هش فایل ${v.file} هنگام ارسال با مقدار ثبت‌شده نخواند`, actor: "system" });
          throw new PdfTamperedError();
        }
      }
      return Readable.toWeb(Readable.from(chunks())) as ReadableStream<Uint8Array>;
    },
  };
}

async function verifyStoredStreaming(contractId: number): Promise<VerifiedPdf | null> {
  const [doc] = await db.select().from(contractDocuments).where(eq(contractDocuments.contractId, contractId));
  if (!doc) return null;
  let hashed: { sha256: string; size: number };
  try {
    hashed = await hashFileStreaming(path.join(documentsDir(), safeFile(doc.file)));
  } catch {
    // فایل از دیسک رفته (مثلاً بازیابی ناقص): ردیف را پاک می‌کنیم تا دوباره ساخته شود
    await db.delete(contractDocuments).where(eq(contractDocuments.id, doc.id));
    return null;
  }
  if (hashed.sha256 !== doc.sha256) {
    await logAudit({ action: "document.tampered", contractId, detail: `هش فایل ${doc.file} با مقدار ثبت‌شده نمی‌خواند`, actor: "system" });
    throw new PdfTamperedError();
  }
  return toVerified(contractId, { sha256: doc.sha256, size: hashed.size, file: doc.file, createdAt: doc.createdAt });
}

/**
 * PDF قرارداد امضاشده برای «دانلود HTTP». همان تضمین قبلی (هر دانلود هش فایل را با مقدار ثبت‌شده می‌سنجد؛ دستکاری/خرابی دیسک
 * ⇒ PdfTamperedError) ولی با حافظه‌ی ثابت: فایل به‌صورت جریانی هش و سپس جریانی ارسال می‌شود، نه یک Buffer کامل (برای PDFهای
 * چندده‌مگابایتیِ «سند بارگذاری‌شده + امضا» حافظه‌ی پروسه با هر دانلود هم‌زمان باد نمی‌کند). اگر هنوز ساخته نشده، همین حالا ساخته می‌شود.
 */
export async function openContractPdf(contractId: number): Promise<VerifiedPdf> {
  const stored = await verifyStoredStreaming(contractId);
  if (stored) return stored;
  const fresh = await generateContractPdf(contractId);
  // تازه ساخته (هش همین لحظه محاسبه شده) — بدون خواندن دوباره
  return toVerified(contractId, { sha256: fresh.sha256, size: fresh.size, file: fresh.file, createdAt: fresh.createdAt });
}
