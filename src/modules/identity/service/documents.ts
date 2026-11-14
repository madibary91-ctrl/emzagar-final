import { IDENTITY_FILE_MAX_BYTES, type IdentityReq, assuranceText, isValidNationalCode, maskNc, needsDocs, normalizeNationalCode, parseIdentityReq } from "../rules";
import { type Result, decryptBuf, encryptBuf, getIdentity, ncHash } from "./core";
import { type SignerCtx } from "./shahkar";
import { and, eq, sql } from "drizzle-orm";
import { contractSigners, contracts, signerIdentities } from "@/db/schema";
import crypto from "node:crypto";
import { db } from "@/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import fs from "node:fs/promises";
import { identityDir } from "@/lib/storage-paths";
import { logAudit } from "@/modules/audit/service";
import { notifyTeam } from "@/modules/inbox/service";
import path from "node:path";
import { refreshVerified } from "./config";
import { sha256Buf } from "@/modules/pdf/hash";
import { sniffMime } from "@/modules/attachments/service";

/* ───────── مدارک هویتی ───────── */

export type DocFile = { name: string; buffer: Buffer };
async function saveEncrypted(prefix: string, f: DocFile, mime: string, ext: string) {
  await fs.mkdir(identityDir(), { recursive: true, mode: 0o700 });
  const file = `${prefix}-${crypto.randomBytes(12).toString("hex")}.${ext}.enc`;
  const target = path.join(identityDir(), file);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, encryptBuf(f.buffer), { mode: 0o600 });
  await fs.rename(tmp, target);
  return { file, mime, sha: sha256Buf(f.buffer) };
}
const safeUnlink = (file: string | null | undefined) => (file ? fs.unlink(path.join(identityDir(), path.basename(file))).catch(() => undefined) : Promise.resolve());
export async function submitDocuments(ctx: SignerCtx, input: { nationalCode: string; idCard: DocFile; selfie: DocFile }): Promise<Result> {
  const [s] = await db.select({ req: contractSigners.identityReq }).from(contractSigners).where(eq(contractSigners.id, ctx.signerId));
  if (!needsDocs(parseIdentityReq(s?.req))) return { ok: false, error: "برای این قرارداد ارسال مدارک لازم نیست" };
  const row = await getIdentity(ctx.signerId);
  if (!row) return { ok: false, error: "تنظیمات هویت این امضاکننده کامل نیست؛ با صادرکننده تماس بگیرید" };
  if (row.docStatus === "approved") return { ok: true };
  if (row.docStatus === "pending") return { ok: false, error: "مدارک شما قبلاً ارسال شده و در انتظار بررسی صادرکننده است" };
  // اگر در مرحله‌ی شاهکار کد ملی تأیید شده، همان به‌کار می‌رود (نیازی به ورود دوباره نیست)
  const reuse = !input.nationalCode.trim() && row.shahkarStatus === "matched" && row.checkedMobile === ctx.mobile && row.ncEnc ? decryptSecret(row.ncEnc) : "";
  const nc = reuse || normalizeNationalCode(input.nationalCode);
  if (!isValidNationalCode(nc)) return { ok: false, error: "کد ملی معتبر نیست (۱۰ رقم)" };
  if (row.expectedNcHash && row.expectedNcHash !== ncHash(nc)) {
    await logAudit({ action: "identity.mismatch", contractId: ctx.contractId, workspaceId: ctx.workspaceId, userId: ctx.userId, detail: `${ctx.signerLabel}: کد ملی واردشده (${maskNc(nc)}) با کد ملی مورد انتظار قرارداد نمی‌خواند (ارسال مدارک)` });
    return { ok: false, error: "کد ملی با اطلاعات این قرارداد مطابقت ندارد" };
  }
  // اگر پیش‌تر در شاهکار تأیید شده، کد ملیِ مدارک باید همان باشد (دو هویت متفاوت در یک پرونده ممنوع)
  if (row.shahkarStatus === "matched" && row.ncHash && row.ncHash !== ncHash(nc)) return { ok: false, error: "کد ملی با کدی که در تطبیق شماره تأیید شد یکی نیست" };

  const checked: { f: DocFile; mime: string; ext: string; prefix: string }[] = [];
  for (const [f, prefix] of [[input.idCard, "id"], [input.selfie, "selfie"]] as const) {
    if (!f.buffer.length) return { ok: false, error: "یکی از فایل‌ها خالی است" };
    if (f.buffer.length > IDENTITY_FILE_MAX_BYTES) return { ok: false, error: "حجم هر عکس حداکثر ۵ مگابایت است" };
    const k = sniffMime(f.buffer); // نوع واقعی از روی محتوا، نه نام/نوع اعلامی
    if (!k || k.mime === "application/pdf") return { ok: false, error: "عکس‌ها باید JPG، PNG یا WebP باشند" };
    checked.push({ f, ...k, prefix: `s${ctx.signerId}-${prefix}` });
  }
  const [a, b] = await Promise.all(checked.map((c) => saveEncrypted(c.prefix, c.f, c.mime, c.ext)));
  const old = [row.idFile, row.selfieFile];
  const claimed = await db
    .update(signerIdentities)
    .set({
      docStatus: "pending",
      idFile: a.file, idMime: a.mime, idSha256: a.sha, selfieFile: b.file, selfieMime: b.mime, selfieSha256: b.sha,
      docSubmittedAt: new Date(), docRejectReason: "", docReviewedBy: null, docReviewedAt: null,
      ncEnc: row.ncEnc ?? encryptSecret(nc), ncHash: row.ncHash ?? ncHash(nc), updatedAt: new Date(),
    })
    .where(and(eq(signerIdentities.signerId, ctx.signerId), sql`${signerIdentities.docStatus} in ('none','rejected')`))
    .returning({ id: signerIdentities.id });
  if (claimed.length === 0) {
    await Promise.all([safeUnlink(a.file), safeUnlink(b.file)]);
    return { ok: false, error: "مدارک شما قبلاً ثبت شده است" };
  }
  await Promise.all(old.map(safeUnlink));
  await logAudit({ action: "identity.docs_submitted", contractId: ctx.contractId, workspaceId: ctx.workspaceId, userId: ctx.userId, detail: `${ctx.signerLabel}: کارت ملی + سلفی (کد ملی ${maskNc(nc)})` });
  await notifyTeam(ctx.workspaceId, { kind: "action", title: `مدارک هویتی منتظر بررسی شماست — ${ctx.contractNumber}`, body: `${ctx.signerLabel} مدارک هویتی‌اش را فرستاد. بررسی و تأیید کنید تا بتواند امضا کند`, href: `/contracts/${ctx.contractId}#identity` }).catch(() => 0);
  return { ok: true };
}
export async function reviewDocuments(p: { signerId: number; contractId: number; workspaceId: number; reviewerId: number; decision: "approve" | "reject"; reason?: string }): Promise<Result> {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, p.contractId), eq(contracts.workspaceId, p.workspaceId)));
  if (!c) return { ok: false, error: "قرارداد یافت نشد" };
  if (c.status !== "sent" && c.status !== "draft") return { ok: false, error: "این قرارداد دیگر باز نیست" };
  const row = await getIdentity(p.signerId);
  if (!row || row.contractId !== p.contractId) return { ok: false, error: "پرونده‌ی هویتی یافت نشد" };
  if (row.docStatus !== "pending") return { ok: false, error: "مدارکی برای بررسی وجود ندارد" };
  const reason = (p.reason ?? "").trim().slice(0, 300);
  if (p.decision === "reject" && reason.length < 3) return { ok: false, error: "دلیل رد را بنویسید تا امضاکننده بتواند اصلاح کند" };
  const done = await db
    .update(signerIdentities)
    .set({ docStatus: p.decision === "approve" ? "approved" : "rejected", docReviewedBy: p.reviewerId, docReviewedAt: new Date(), docRejectReason: p.decision === "reject" ? reason : "", updatedAt: new Date() })
    .where(and(eq(signerIdentities.signerId, p.signerId), eq(signerIdentities.docStatus, "pending")))
    .returning({ id: signerIdentities.id });
  if (done.length === 0) return { ok: false, error: "این درخواست قبلاً بررسی شده است" };
  await refreshVerified(p.signerId);
  await logAudit({ action: p.decision === "approve" ? "identity.docs_approved" : "identity.docs_rejected", contractId: p.contractId, workspaceId: p.workspaceId, userId: p.reviewerId, detail: `امضاکننده #${p.signerId}${reason ? ": " + reason : ""}` });
  return { ok: true };
}
/** بازنشانی سقف تلاش و وضعیت شکست (تصمیم صادرکننده، مثلاً پس از اصلاح شماره‌ی موبایل) */
export async function resetAttempts(p: { signerId: number; contractId: number; workspaceId: number; actorId: number }): Promise<Result> {
  const row = await getIdentity(p.signerId);
  if (!row || row.contractId !== p.contractId || row.workspaceId !== p.workspaceId) return { ok: false, error: "پرونده‌ی هویتی یافت نشد" };
  await db.update(signerIdentities).set({ attempts: 0, shahkarStatus: row.shahkarStatus === "matched" ? "matched" : "none", updatedAt: new Date() }).where(eq(signerIdentities.signerId, p.signerId));
  await logAudit({ action: "identity.reset", contractId: p.contractId, workspaceId: p.workspaceId, userId: p.actorId, detail: `سقف تلاش امضاکننده #${p.signerId} بازنشانی شد` });
  return { ok: true };
}
/** خواندن تصویر رمزگشایی‌شده برای بازبین (فقط از مسیر احراز هویت‌شده‌ی تیم) */
export async function readDocument(signerId: number, workspaceId: number, kind: "id" | "selfie"): Promise<{ buffer: Buffer; mime: string } | null> {
  const row = await getIdentity(signerId);
  if (!row || row.workspaceId !== workspaceId) return null;
  const file = kind === "id" ? row.idFile : row.selfieFile;
  const mime = kind === "id" ? row.idMime : row.selfieMime;
  if (!file || !mime) return null;
  try {
    return { buffer: decryptBuf(await fs.readFile(path.join(identityDir(), path.basename(file)))), mime };
  } catch {
    return null;
  }
}
/* ───────── مهر یکپارچگی در لحظه‌ی امضا ───────── */

/** شواهد هویتی را همراه امضا «می‌بندد»: هش شواهد در پرونده و لاگ ممیزی ثبت می‌شود (داخل تراکنش امضا) */
export async function sealIdentityAtSigning(p: { contractId: number; signerId: number; userId: number; label: string; mobile: string; req: IdentityReq }): Promise<string> {
  const row = await getIdentity(p.signerId);
  if (!row) return "";
  const evidence = [p.contractId, p.signerId, p.mobile, p.req, row.ncHash ?? "", row.shahkarStatus, row.shahkarProvider, row.shahkarRef, row.idSha256 ?? "", row.selfieSha256 ?? "", row.docReviewedAt?.toISOString() ?? ""].join("|");
  const seal = crypto.createHash("sha256").update(evidence).digest("hex");
  await db.update(signerIdentities).set({ sealHash: seal, updatedAt: new Date() }).where(eq(signerIdentities.signerId, p.signerId));
  await logAudit({
    action: "identity.bound",
    contractId: p.contractId,
    userId: p.userId,
    detail: `${p.label}: امضا به هویت تأییدشده گره خورد (${assuranceText(p.req, { sandbox: row.shahkarProvider === "sandbox" }) || p.req}) — مهر ${seal.slice(0, 16)}…`,
  });
  return seal;
}
