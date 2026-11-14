import { assuranceForContract } from "@/modules/identity/service";
import { assuranceText } from "@/modules/identity/rules";
import fs from "node:fs/promises";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contractDocuments, contracts, contractSigners, users } from "@/db/schema";
import { sanitizeHtml } from "@/lib/html";
import { fa, faTime } from "@/lib/jalali";
import { getOrigin } from "@/lib/request";
import { documentsDir } from "@/lib/storage-paths";
import { sha256Buf as _sha256Buf } from "./hash";
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
  const buffer = (await composeSourcePdf(contractId, input)) ?? (await renderContractPdf(input));
  const hash = sha256Buf(buffer);
  const file = safeFile(`${input.number}-${hash.slice(0, 10)}.pdf`);
  await fs.mkdir(documentsDir(), { recursive: true, mode: 0o700 });
  // نوشتن اتمیک: ابتدا فایل موقت، سپس rename
  const target = path.join(documentsDir(), file);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, buffer, { mode: 0o600 });
  await fs.rename(tmp, target);
  const inserted = await db
    .insert(contractDocuments)
    .values({ contractId, file, sha256: hash, size: buffer.length })
    .onConflictDoNothing()
    .returning({ createdAt: contractDocuments.createdAt });
  if (inserted.length === 0) {
    // پردازه‌ی دیگری همزمان ساخته است؛ نسخه‌ی او معتبر است
    await fs.unlink(target).catch(() => undefined);
    const again = await readStored(contractId);
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
