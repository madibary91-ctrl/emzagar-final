import { type Campaign, CollectError, RECEIPT_ALPHABET, RECEIPT_RE, accessKey, rand } from "./core";
import { acceptingState, countSubmissions, docFieldsOf, getCampaignByCode } from "./campaigns";
import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import { cleanGuestName, normalizeMobile } from "@/modules/guests/service";
import { collectCampaigns, collectSubmissions, workspaces } from "@/db/schema";
import { consumeProof } from "@/modules/mobile/otp";
import { db, withTransaction } from "@/db";
import { deleteSignatureFile, readSignatureFile, saveSignatureFile } from "@/modules/signing/storage";
import { logAudit } from "@/modules/audit/service";
import { parseCollectFields, validateCollectValues } from "../schema";
import { parseSignatureDataUrl } from "@/modules/signing/types";
import { prepareDocValues } from "@/modules/docs/service";
import { sha256 } from "@/lib/password";

/* ───────── ثبت امضای عمومی ───────── */

export interface SubmitInput {
  code: string;
  fullName: string;
  mobile: string;
  values?: Record<string, string>;
  proof?: string;
  signature?: string;
  agree: boolean;
  ip: string;
  userAgent: string;
}
export async function submitCollect(input: SubmitInput): Promise<{ receipt: string; key: string; message: string }> {
  const c = await getCampaignByCode(input.code);
  if (!c) throw new CollectError("این فرم پیدا نشد");
  const st = await acceptingState(c);
  if (!st.open) throw new CollectError(st.reason || "دریافت امضا بسته است");
  const fullName = cleanGuestName(input.fullName);
  if (fullName.length < 3) throw new CollectError("نام و نام خانوادگی را کامل وارد کنید");
  const mobile = normalizeMobile(input.mobile);
  if (!mobile) throw new CollectError("شماره‌ی موبایل معتبر نیست؛ به‌صورت 09123456789 وارد کنید");
  if (!input.agree) throw new CollectError("تأیید مطالعه و پذیرش متن الزامی است");

  const defs = parseCollectFields(c.fieldsJson);
  const checked = validateCollectValues(defs, input.values);
  if (!checked.ok) throw new CollectError(checked.error);
  const values = { ...checked.values };
  const docFields = docFieldsOf(c);
  if (docFields.length) {
    const prep = prepareDocValues(docFields.map((f) => ({ key: f.key, kind: f.kind, label: f.label, required: f.required })), fullName, input.values);
    if (!prep.ok) throw new CollectError(prep.error);
    for (const r of prep.rows) values[r.key] = r.value;
  }
  let sigBuf: Buffer | null = null;
  if (c.requireSignature) {
    const parsed = parseSignatureDataUrl(input.signature);
    if ("error" in parsed) throw new CollectError(parsed.error === "امضا معتبر نیست" ? "امضای خود را ثبت کنید" : parsed.error);
    sigBuf = parsed.buffer;
  }
  if (c.requireOtp && !(await consumeProof(String(input.proof || ""), { purpose: "collect", scope: c.code, mobile }))) {
    throw new CollectError("تأیید شماره‌ی موبایل منقضی یا نامعتبر است؛ دوباره کد بگیرید");
  }

  const receipt = rand(RECEIPT_ALPHABET, 10);
  const createdAt = new Date();
  const sigFile = sigBuf ? await saveSignatureFile(`col${c.id}-${receipt}.png`, sigBuf) : null;
  const docHash = fingerprint({ c, name: fullName, mobile, values, sig: sigBuf, at: createdAt, receipt });
  try {
    await withTransaction(async () => {
      // قفل ردیف کمپین: سقف ظرفیت زیر هجوم هم‌زمان رد نشود
      const [locked] = await db.select().from(collectCampaigns).where(eq(collectCampaigns.id, c.id)).for("update");
      if (locked.maxSubmissions && (await countSubmissions(c.id)) >= locked.maxSubmissions) throw new CollectError("ظرفیت این فرم تکمیل شده است");
      await db.insert(collectSubmissions).values({
        campaignId: c.id,
        workspaceId: c.workspaceId,
        receipt,
        fullName,
        mobile,
        mobileVerified: c.requireOtp,
        valuesJson: JSON.stringify(values),
        bodySnapshot: c.bodyHtml,
        signatureFile: sigFile,
        ip: input.ip.slice(0, 64),
        userAgent: input.userAgent.slice(0, 250),
        docHash,
        dedupeKey: c.allowDuplicates ? null : mobile,
        createdAt,
      });
    });
  } catch (e) {
    if (sigFile) await deleteSignatureFile(sigFile);
    const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    if (code === "23505") throw new CollectError("با این شماره‌ی موبایل قبلاً امضا ثبت شده است");
    throw e;
  }
  await logAudit({ action: "collect.submitted", workspaceId: c.workspaceId, detail: `${c.title} — ${fullName} (${mobile.slice(0, 4)}***${mobile.slice(-2)}) — رسید ${receipt}`, actor: "guest" }).catch(() => undefined);
  return { receipt, key: accessKey(receipt), message: c.successMessage || "امضای شما با موفقیت ثبت شد." };
}
function fingerprint(p: { c: Campaign; name: string; mobile: string; values: Record<string, string>; sig: Buffer | null; at: Date; receipt: string }): string {
  const vals = Object.keys(p.values).sort().map((k) => `${k}=${p.values[k]}`).join(";");
  return sha256(["v1", p.c.id, p.c.title, p.c.bodyHtml, p.c.docSha256, p.name, p.mobile, vals, p.sig ? sha256(p.sig.toString("base64")) : "", p.at.toISOString(), p.receipt].join("|"));
}
/* ───────── فهرست، رسید، استعلام ───────── */

export async function listSubmissions(campaignId: number, opts: { q?: string; page?: number; pageSize?: number } = {}) {
  const pageSize = opts.pageSize ?? 25;
  const page = Math.max(1, opts.page ?? 1);
  const q = (opts.q ?? "").trim().replace(/[%_\\]/g, "\\$&");
  const where = and(eq(collectSubmissions.campaignId, campaignId), q ? or(ilike(collectSubmissions.fullName, `%${q}%`), ilike(collectSubmissions.mobile, `%${q}%`), ilike(collectSubmissions.receipt, `%${q}%`)) : undefined);
  const [total] = await db.select({ n: count() }).from(collectSubmissions).where(where);
  const rows = await db.select().from(collectSubmissions).where(where).orderBy(desc(collectSubmissions.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
  return { rows, total: total?.n ?? 0, page, pageSize };
}
export async function getSubmissionById(id: number, workspaceId: number) {
  const [s] = await db.select().from(collectSubmissions).where(and(eq(collectSubmissions.id, id), eq(collectSubmissions.workspaceId, workspaceId)));
  return s ?? null;
}
export async function getSubmissionByReceipt(receipt: string) {
  if (!RECEIPT_RE.test(receipt)) return null;
  const [s] = await db.select().from(collectSubmissions).where(eq(collectSubmissions.receipt, receipt));
  return s ?? null;
}
export async function voidSubmission(id: number, workspaceId: number, userId: number, reason: string) {
  const s = await getSubmissionById(id, workspaceId);
  if (!s || s.voidedAt) return false;
  await db.update(collectSubmissions).set({ voidedAt: new Date(), voidReason: cleanGuestName(reason).slice(0, 200), dedupeKey: null }).where(eq(collectSubmissions.id, id));
  await logAudit({ action: "collect.voided", workspaceId, userId, detail: `${s.fullName} — رسید ${s.receipt}` });
  return true;
}
export type VerifyReceipt = { found: false } | { found: true; title: string; workspaceName: string; signedAt: Date; maskedName: string; intact: boolean; voided: boolean; hash: string };
export function maskPersonName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "—";
  return parts.length === 1 ? `${parts[0].slice(0, 1)}•••` : `${parts[0]} ${parts.slice(1).map((p) => `${p.slice(0, 1)}•••`).join(" ")}`;
}
export async function verifyReceipt(receipt: string): Promise<VerifyReceipt> {
  const s = await getSubmissionByReceipt(receipt);
  if (!s) return { found: false };
  const [c] = await db.select().from(collectCampaigns).where(eq(collectCampaigns.id, s.campaignId));
  if (!c) return { found: false };
  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, c.workspaceId));
  let intact = false;
  try {
    const sig = s.signatureFile ? await readSignatureFile(s.signatureFile) : null;
    const values = JSON.parse(s.valuesJson) as Record<string, string>;
    intact = fingerprint({ c: { ...c, bodyHtml: s.bodySnapshot }, name: s.fullName, mobile: s.mobile, values, sig, at: s.createdAt, receipt: s.receipt }) === s.docHash;
  } catch {
    intact = false;
  }
  return { found: true, title: c.title, workspaceName: ws?.name ?? "", signedAt: s.createdAt, maskedName: maskPersonName(s.fullName), intact, voided: !!s.voidedAt, hash: s.docHash };
}
