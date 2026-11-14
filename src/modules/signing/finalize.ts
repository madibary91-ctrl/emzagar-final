import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { contracts, contractSigners, orders } from "@/db/schema";
import { getFieldValues, saveFieldValues, type PreparedFields } from "@/modules/fields/service";
import { notifyTeam, notifyUser, notifyUsers } from "@/modules/inbox/service";
import { termEndFor } from "@/modules/renewals/service";
import { docFingerprint } from "./fingerprint";
import { escapeHtml } from "@/lib/html";
import { fa, faTime } from "@/lib/jalali";
import { getRequestInfo } from "@/lib/request";
import { logAudit } from "@/modules/audit/service";
import { currentSigner, getSigners, type Contract, type SignerRow } from "@/modules/contracts/service";
import { sendMail } from "@/modules/mail";
import { generateContractPdf, type StoredPdf } from "@/modules/pdf/service";
import { getAllSettings } from "@/modules/settings/service";
import { emitEvent } from "@/modules/webhooks/service";
import { markSigningLinkUsed, revokeSigningLinks } from "./links";
import { enqueueJob } from "@/modules/jobs/queue";
import { gateMessage } from "@/modules/contract-pay/gate";
import { identityGate, sealIdentityAtSigning } from "@/modules/identity/service";
import { deleteSignatureFile, saveSignatureFile } from "./storage";
import { checkEvidence, deleteEvidence, saveEvidence, type EvidenceInput, type SavedEvidence } from "./evidence";
import { stageJustCompleted, stageOf } from "./stages";
import type { ActionResult } from "./types";

export type SigningVia = "account" | "link";

export interface ApplySignatureParams {
  contract: Contract;
  signer: { id: number; label: string };
  user: { id: number; name: string; mobile: string };
  buffer: Buffer;
  method: "draw" | "upload";
  via: SigningVia;
  /** مقدار فیلدهای پرشده‌ی همین امضاکننده (قبلاً با prepareFieldValues اعتبارسنجی شده) */
  fieldValues?: PreparedFields["rows"];
  /** مهر شرکتی و پاراف (data URL از نوع PNG)؛ الزام‌ها سمت سرور از روی ردیف امضاکننده سنجیده می‌شود */
  evidence?: EvidenceInput;
}

type Committed =
  | { duplicate: true }
  | { duplicate: false; completed: boolean; signers: SignerRow[]; fingerprint: string; termEndsAt: Date | null };

/** کار جانبیِ پس از commit؛ خطای آن هرگز امضای ثبت‌شده را باطل یا «ناموفق» گزارش نمی‌کند */
async function bestEffort(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.error(`[sign:${label}]`, e);
  }
}

/**
 * ثبت نهایی یک امضا (هر دو مسیر: حساب کاربری و لینک بدون ثبت‌نام).
 * پیش‌شرط: هویت امضاکننده (نوبت + OTP) پیش‌تر راستی‌آزمایی شده است.
 *
 * اتمی بودن: «امضای این نفر»، مصرف لینک، مقدار فیلدها، لاگ‌های ممیزی و ــ اگر آخرین امضاکننده باشد ــ
 * «نهایی‌شدن قرارداد» (status/docHash/termEndsAt/سفارش) همگی در یک تراکنش دیتابیس انجام می‌شوند.
 * هر خطایی در میانه، همه را برمی‌گرداند؛ پس حالت «آخرین نفر امضا کرده ولی قرارداد هنوز sent است» هرگز پدید نمی‌آید.
 * ردیف قرارداد زیر قفل می‌ماند تا دو امضای همزمان یکدیگر را «ندیده» نگیرند (هیچ‌کدام نهایی‌کننده نشود).
 * اعلان‌ها، وب‌هوک، PDF و ایمیل (کارهای شبکه‌ای و غیرقابل‌برگشت) فقط پس از commit اجرا می‌شوند.
 */
export async function applySignature(p: ApplySignatureParams): Promise<ActionResult> {
  const { contract, signer, user } = p;
  const contractId = contract.id;
  // امضا و پرداخت: اگر بیعانه/قسطِ «پیش‌شرط امضا» پرداخت نشده باشد، امضا ثبت نمی‌شود (سمت سرور؛ مستقل از رابط کاربری)
  const gate = await gateMessage(contractId, signer.id);
  if (gate) return { ok: false, error: gate };
  // احراز هویت اختیاری: اگر صادرکننده برای این امضاکننده سطح هویت تعیین کرده باشد، بدون شواهد کافی امضا ثبت نمی‌شود (سمت سرور، مستقل از رابط)
  // برای سطح «عادی» فقط یک خوانش سبک است و هیچ مرحله‌ی اضافه‌ای اجرا نمی‌شود.
  const idGate = await identityGate(signer.id, user.mobile);
  if (idGate.error) return { ok: false, error: idGate.error };
  // مهر شرکتی / پاراف: الزام‌های صادرکننده برای «همین» امضاکننده (قبل از ذخیره‌ی هر فایل)
  const [signerRow] = await db.select().from(contractSigners).where(eq(contractSigners.id, signer.id));
  if (!signerRow) return { ok: false, error: "امضاکننده یافت نشد" };
  const ev = checkEvidence(signerRow, p.evidence);
  if (!ev.ok) return { ok: false, error: ev.error };
  const { ip, userAgent } = await getRequestInfo();
  const now = new Date();
  const file = await saveSignatureFile(`c${contractId}-s${signer.id}-${Date.now()}.png`, p.buffer);
  let savedEv: SavedEvidence = { sealFile: null, sealSha256: null, initialsFile: null, initialsSha256: null };
  try {
    savedEv = await saveEvidence(contractId, signer.id, ev.evidence);
  } catch (e) {
    await deleteSignatureFile(file).catch(() => undefined);
    throw e;
  }

  let committed: Committed;
  try {
    committed = await withTransaction(async (): Promise<Committed> => {
      // سریال‌سازی امضاهای هم‌زمانِ یک قرارداد (بدون مسدودکردن درج‌های وابسته)
      await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, contractId)).for("no key update");

      // شرط status='pending' از ثبت امضای تکراری در درخواست‌های همزمان جلوگیری می‌کند
      const claimed = await db
        .update(contractSigners)
        .set({ status: "signed", signedAt: now, ip, userAgent, signatureFile: file, signatureMethod: p.method, otpVerifiedAt: now, mobile: user.mobile, identityAssurance: idGate.req, ...savedEv })
        .where(and(eq(contractSigners.id, signer.id), eq(contractSigners.status, "pending")))
        .returning({ id: contractSigners.id });
      if (claimed.length === 0) return { duplicate: true };
      await markSigningLinkUsed(signer.id);
      // مهر یکپارچگی: شواهد هویتی همراه همین امضا (و در همین تراکنش) بسته می‌شود
      if (idGate.req !== "none") await sealIdentityAtSigning({ contractId, signerId: signer.id, userId: user.id, label: signer.label, mobile: user.mobile, req: idGate.req });
      if (p.fieldValues?.length) {
        await saveFieldValues(contractId, signer.id, p.fieldValues);
        await logAudit({ action: "fields.filled", contractId, userId: user.id, detail: `${signer.label}: ${p.fieldValues.map((f) => f.label).join("، ")}` });
      }
      await logAudit({
        action: "contract.signed",
        contractId,
        userId: user.id,
        detail: `${signer.label}${signerRow.role === "witness" ? " (شاهد)" : ""} — ${faTime(now)} — روش: ${p.method === "upload" ? "آپلود تصویر" : "ترسیم"} — ${p.via === "link" ? "از لینک امن (بدون ثبت‌نام)" : "از حساب کاربری"}${savedEv.sealSha256 ? ` — مهر شرکتی ${signerRow.companyName ? `«${signerRow.companyName}» ` : ""}ثبت شد (${savedEv.sealSha256.slice(0, 12)}…)` : ""}${savedEv.initialsSha256 ? ` — پاراف صفحات ثبت شد (${savedEv.initialsSha256.slice(0, 12)}…)` : ""}`,
      });

      const signers = await getSigners(contractId);
      emitEvent({
        event: "contract.signed",
        contractId,
        text: `✍️ ${signer.label} (${user.name}) قرارداد ${contract.number} را امضا کرد.`,
        data: { number: contract.number, signer: signer.label },
      });

      if (!signers.every((s) => s.status === "signed")) {
        // نوبت جدید: شمارنده‌ی یادآوری برای امضاکننده‌ی بعدی از صفر شروع می‌شود
        // (در امضای هم‌زمان فقط وقتی کل مرحله کامل شد)
        if (stageJustCompleted(signers, stageOf(signerRow))) await db.update(contracts).set({ reminderCount: 0, lastReminderAt: null }).where(eq(contracts.id, contractId));
        // PERF-03: اعلان‌ها و اطلاع‌رسانی نوبت بعدی (ایمیل/پیامک) بیرون از مسیر پاسخ؛ درج در همین تراکنش (Outbox)
        await enqueueJob("sign.notify", { contractId, signerLabel: signer.label, userName: user.name, completed: false, stage: stageOf(signerRow) }, { dedupeKey: `sign-notify:${signer.id}` });
        return { duplicate: false, completed: false, signers, fingerprint: "", termEndsAt: null };
      }

      const fieldRows = await getFieldValues(contractId);
      const fingerprint = docFingerprint(contract.bodyHtml, signers, fieldRows);
      const termEndsAt = termEndFor(now, contract.termDays);
      await db.update(contracts).set({ status: "signed", signedAt: now, docHash: fingerprint, ...(termEndsAt ? { termEndsAt } : {}) }).where(eq(contracts.id, contractId));
      if (contract.orderId) await db.update(orders).set({ status: "completed" }).where(eq(orders.id, contract.orderId));
      // لینک‌ها باطل نمی‌شوند: همه «مصرف‌شده»اند و صفحه‌ی «امضا شد» + دانلود PDF تا پایان نشست OTP در دسترس می‌ماند
      await logAudit({ action: "contract.completed", contractId, userId: user.id, detail: `اثر انگشت سند: ${fingerprint.slice(0, 16)}…` });
      emitEvent({
        event: "contract.completed",
        contractId,
        text: `✅ قرارداد ${contract.number} — «${contract.title}» توسط همه‌ی طرفین امضا و نهایی شد.`,
        data: { number: contract.number, title: contract.title },
      });
      // PERF-03: تولید PDF (pdfkit)، هش، ایمیل نسخه‌ی نهایی و اعلان‌ها دیگر پیش از پاسخ به امضاکننده اجرا نمی‌شوند.
      // کارها همراه امضا «اتمی» در صف ماندگار درج می‌شوند؛ پس از commit بیرون از درخواست اجرا و در صورت شکست تکرار می‌شوند.
      await enqueueJob("sign.notify", { contractId, signerLabel: signer.label, userName: user.name, completed: true, stage: stageOf(signerRow) }, { dedupeKey: `sign-notify:${signer.id}` });
      await enqueueJob("contract.finalize", { contractId }, { dedupeKey: `finalize:${contractId}` });
      return { duplicate: false, completed: true, signers, fingerprint, termEndsAt };
    });
  } catch (e) {
    // تراکنش برگشت خورده؛ فایل امضای بی‌صاحب هم پاک می‌شود
    await deleteSignatureFile(file).catch(() => undefined);
    await deleteEvidence(savedEv);
    throw e;
  }

  if (committed.duplicate) {
    await deleteSignatureFile(file).catch(() => undefined);
    await deleteEvidence(savedEv);
    return { ok: false, error: "این قرارداد قبلاً توسط شما امضا شده است" };
  }

  // پس از commit، پردازشگر صف (jobs) بیرون از این درخواست بیدار می‌شود؛ اینجا فقط پاسخ سریع برمی‌گردد.
  revalidatePath("/dashboard");
  revalidatePath("/admin");
  revalidatePath(`/contracts/${contractId}`);
  return { ok: true, completed: committed.completed };
}

/** رد قرارداد توسط امضاکننده‌ی فعلی (مشترک بین حساب کاربری و لینک امن) */
export async function applyRejection(p: { contract: Contract; signer: { id: number; label: string }; user: { id: number; name: string }; reason: string }): Promise<ActionResult> {
  const { contract, signer, user } = p;
  const claimed = await db
    .update(contractSigners)
    .set({ status: "rejected" })
    .where(and(eq(contractSigners.id, signer.id), eq(contractSigners.status, "pending")))
    .returning({ id: contractSigners.id });
  if (claimed.length === 0) return { ok: false, error: "این قرارداد دیگر قابل رد کردن نیست" };
  await db.update(contracts).set({ status: "rejected" }).where(and(eq(contracts.id, contract.id), eq(contracts.status, "sent")));
  await revokeSigningLinks({ contractId: contract.id });
  await notifyTeam(contract.workspaceId, { kind: "warning", title: `${signer.label} قرارداد ${contract.number} را رد کرد`, body: p.reason.slice(0, 200) || user.name, href: `/contracts/${contract.id}` }, [contract.createdBy]);
  await logAudit({ action: "contract.rejected", contractId: contract.id, userId: user.id, detail: `${signer.label}: ${p.reason.slice(0, 300)}` });
  emitEvent({
    event: "contract.rejected",
    contractId: contract.id,
    text: `❌ ${signer.label} (${user.name}) قرارداد ${contract.number} را رد کرد.`,
    data: { number: contract.number },
  });
  revalidatePath("/dashboard");
  revalidatePath("/admin");
  revalidatePath(`/contracts/${contract.id}`);
  return { ok: true };
}
