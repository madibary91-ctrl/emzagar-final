import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { kycDocuments, kycSubmissions, users, workspaces } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getSecret } from "@/lib/secret";
import { kycDir } from "@/lib/storage-paths";
import { logAudit } from "@/modules/audit/service";
import { notifyTeam, notifyUsers } from "@/modules/inbox/service";
import { sniffMime } from "@/modules/attachments/service";
import { sha256Buf } from "@/modules/pdf/hash";
import { getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";
import { DEFAULT_KYC_THRESHOLD, KYC_DOC_KINDS, KYC_MAX_FILE_BYTES, isValidNationalCode, normalizeNationalCode, type KycDocKind } from "./rules";

/** صدور قرارداد پرمبلغ بدون احراز هویت تاییدشده؛ API و فرم پیام را مستقیم به کاربر نشان می‌دهند */
export class KycRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KycRequiredError";
  }
}

/* ───────── آستانه ───────── */
/** ارزش قرارداد (تومان) که از آن به بعد احراز هویت لازم است؛ 0 = غیرفعال. اولویت: تنظیم پنل ← KYC_THRESHOLD_TOMAN ← پیش‌فرض */
export async function getKycThreshold(): Promise<number> {
  const raw = (await getGlobalSetting("kyc_threshold")).trim();
  if (raw !== "" && /^\d+$/.test(raw)) return Number(raw);
  const env = (process.env.KYC_THRESHOLD_TOMAN || "").trim();
  if (/^\d+$/.test(env)) return Number(env);
  return DEFAULT_KYC_THRESHOLD;
}
export async function saveKycThreshold(n: number) {
  await saveGlobalSetting("kyc_threshold", String(Math.max(0, Math.min(2_000_000_000, Math.round(n)))));
}

/* ───────── وضعیت ───────── */
export type KycRow = typeof kycSubmissions.$inferSelect;
export type KycState = { status: "none" | "pending" | "approved" | "rejected"; submission: KycRow | null; approvedAt: Date | null };

export async function getKycState(workspaceId: number): Promise<KycState> {
  const rows = await db.select().from(kycSubmissions).where(eq(kycSubmissions.workspaceId, workspaceId)).orderBy(desc(kycSubmissions.id)).limit(10);
  const approved = rows.find((r) => r.status === "approved");
  if (approved) return { status: "approved", submission: approved, approvedAt: approved.reviewedAt };
  const latest = rows[0];
  if (!latest) return { status: "none", submission: null, approvedAt: null };
  return { status: latest.status as KycState["status"], submission: latest, approvedAt: null };
}

/** سد اصلی: قرارداد با ارزش ≥ آستانه فقط با KYC تاییدشده‌ی فضای کاری صادر/منتشر می‌شود */
export async function assertKycForValue(workspaceId: number, contractValue: number | null | undefined): Promise<void> {
  if (!contractValue || contractValue <= 0) return;
  const threshold = await getKycThreshold();
  if (threshold <= 0 || contractValue < threshold) return;
  const st = await getKycState(workspaceId);
  if (st.status === "approved") return;
  const t = threshold.toLocaleString("fa-IR");
  const hint = st.status === "pending" ? "مدارک شما در صف بررسی است؛ پس از تایید می‌توانید ادامه دهید." : st.status === "rejected" ? "درخواست قبلی رد شده؛ مدارک را اصلاح و دوباره ارسال کنید." : "مدارک هویتی را از بخش «احراز هویت» ارسال کنید.";
  throw new KycRequiredError(`صدور قرارداد با ارزش ${t} تومان و بیشتر نیازمند احراز هویت تاییدشده است. ${hint}`);
}

/* ───────── رمزنگاری فایل ───────── */
const fileKey = () => crypto.createHash("sha256").update(`emz-kyc-file-v1:${getSecret()}`).digest();
function encryptBuf(buf: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", fileKey(), iv);
  const data = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}
function decryptBuf(buf: Buffer): Buffer {
  const d = crypto.createDecipheriv("aes-256-gcm", fileKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}
const codeHash = (code: string) => crypto.createHmac("sha256", getSecret()).update(`kyc-nc:${code}`).digest("hex");
const cleanName = (n: string) => path.basename(String(n || "file")).replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, "_").slice(0, 100) || "file";

/* ───────── ارسال مدارک ───────── */
export type KycFile = { kind: KycDocKind; name: string; buffer: Buffer };
export type SubmitResult = { ok: true; id: number } | { ok: false; error: string };

export async function submitKyc(p: { workspaceId: number; userId: number; fullName: string; nationalCode: string; birthDate: string; files: KycFile[] }): Promise<SubmitResult> {
  const fullName = p.fullName.trim().replace(/\s+/g, " ").slice(0, 100);
  if (fullName.length < 5 || !fullName.includes(" ")) return { ok: false, error: "نام و نام خانوادگی کامل را وارد کنید" };
  const code = normalizeNationalCode(p.nationalCode);
  if (!isValidNationalCode(code)) return { ok: false, error: "کد ملی معتبر نیست" };
  const birth = p.birthDate.trim().slice(0, 20);

  const st = await getKycState(p.workspaceId);
  if (st.status === "approved") return { ok: false, error: "هویت این فضای کاری قبلاً تایید شده است" };
  if (st.status === "pending") return { ok: false, error: "درخواست قبلی شما هنوز در حال بررسی است" };

  const kinds = new Set(p.files.map((f) => f.kind));
  for (const d of KYC_DOC_KINDS) if (d.required && !kinds.has(d.kind)) return { ok: false, error: `فایل «${d.label}» الزامی است` };
  const checked: { f: KycFile; mime: string; ext: string }[] = [];
  for (const f of p.files) {
    if (f.buffer.length === 0) return { ok: false, error: "یکی از فایل‌ها خالی است" };
    if (f.buffer.length > KYC_MAX_FILE_BYTES) return { ok: false, error: "حجم هر فایل حداکثر ۵ مگابایت است" };
    const kind = sniffMime(f.buffer);
    // نوع واقعی فایل از روی محتوا تعیین می‌شود؛ فقط «مدرک تکمیلی» می‌تواند PDF باشد
    if (!kind || (kind.mime === "application/pdf" && f.kind !== "other")) return { ok: false, error: "عکس‌های هویتی باید JPG، PNG یا WebP باشند" };
    checked.push({ f, ...kind });
  }

  const [sub] = await db
    .insert(kycSubmissions)
    .values({ workspaceId: p.workspaceId, userId: p.userId, fullName, nationalCodeEnc: encryptSecret(code), nationalCodeHash: codeHash(code), birthDate: birth })
    .returning();
  await fs.mkdir(kycDir(), { recursive: true, mode: 0o700 });
  for (const { f, mime, ext } of checked) {
    const file = `k${sub.id}-${crypto.randomBytes(12).toString("hex")}.${ext}.enc`;
    const target = path.join(kycDir(), file);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, encryptBuf(f.buffer), { mode: 0o600 });
    await fs.rename(tmp, target);
    await db.insert(kycDocuments).values({ submissionId: sub.id, kind: f.kind, originalName: cleanName(f.name), mime, size: f.buffer.length, sha256: sha256Buf(f.buffer), file });
  }
  await logAudit({ action: "kyc.submitted", workspaceId: p.workspaceId, userId: p.userId, detail: `درخواست #${sub.id} — ${checked.length} مدرک` });
  const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
  await notifyUsers(admins.map((a) => a.id), { kind: "action", title: "درخواست احراز هویت جدید", body: `${fullName} — منتظر بررسی`, href: `/platform/kyc/${sub.id}` }).catch(() => 0);
  return { ok: true, id: sub.id };
}

/* ───────── بررسی توسط مدیر ───────── */
export async function listKyc(status?: string) {
  const rows = await db
    .select({ s: kycSubmissions, ws: workspaces.name, email: users.email })
    .from(kycSubmissions)
    .innerJoin(workspaces, eq(workspaces.id, kycSubmissions.workspaceId))
    .innerJoin(users, eq(users.id, kycSubmissions.userId))
    .where(status ? eq(kycSubmissions.status, status) : undefined)
    .orderBy(sql`case when ${kycSubmissions.status} = 'pending' then 0 else 1 end`, desc(kycSubmissions.id))
    .limit(100);
  return rows;
}

export async function getKycForReview(id: number) {
  if (!Number.isInteger(id)) return null;
  const [row] = await db
    .select({ s: kycSubmissions, ws: workspaces.name, email: users.email, mobile: users.mobile, userName: users.name })
    .from(kycSubmissions)
    .innerJoin(workspaces, eq(workspaces.id, kycSubmissions.workspaceId))
    .innerJoin(users, eq(users.id, kycSubmissions.userId))
    .where(eq(kycSubmissions.id, id));
  if (!row) return null;
  const docs = await db.select().from(kycDocuments).where(eq(kycDocuments.submissionId, id)).orderBy(kycDocuments.id);
  // علامت هشدار: همین کد ملی در فضای کاری دیگری هم ارسال شده است
  const [dup] = await db.select({ n: sql<number>`count(distinct ${kycSubmissions.workspaceId})::int` }).from(kycSubmissions).where(and(eq(kycSubmissions.nationalCodeHash, row.s.nationalCodeHash), ne(kycSubmissions.workspaceId, row.s.workspaceId)));
  return { ...row, nationalCode: decryptSecret(row.s.nationalCodeEnc), docs, duplicateWorkspaces: dup?.n ?? 0 };
}

export async function reviewKyc(id: number, adminId: number, decision: "approve" | "reject", reason: string): Promise<{ ok: boolean; error?: string }> {
  const why = reason.trim().slice(0, 300);
  if (decision === "reject" && why.length < 5) return { ok: false, error: "دلیل رد را بنویسید (حداقل ۵ نویسه)" };
  // فقط درخواست در حال بررسی تصمیم می‌گیرد (جلوگیری از تصمیم‌گیری دوباره/هم‌زمان)
  const [row] = await db
    .update(kycSubmissions)
    .set({ status: decision === "approve" ? "approved" : "rejected", rejectReason: decision === "reject" ? why : "", reviewedBy: adminId, reviewedAt: new Date() })
    .where(and(eq(kycSubmissions.id, id), eq(kycSubmissions.status, "pending")))
    .returning();
  if (!row) return { ok: false, error: "این درخواست دیگر در حال بررسی نیست" };
  await logAudit({ action: decision === "approve" ? "kyc.approved" : "kyc.rejected", workspaceId: row.workspaceId, userId: adminId, detail: `درخواست #${id}${decision === "reject" ? ` — ${why}` : ""}` });
  await notifyTeam(
    row.workspaceId,
    decision === "approve"
      ? { kind: "success", title: "هویت شما تایید شد", body: "اکنون می‌توانید قراردادهای پرمبلغ صادر کنید.", href: "/admin/kyc" }
      : { kind: "warning", title: "احراز هویت رد شد", body: why, href: "/admin/kyc" },
    [row.userId],
    ["owner", "admin"],
  ).catch(() => 0);
  return { ok: true };
}

/** خواندن مدرک رمزنگاری‌شده با راستی‌آزمایی هش؛ مغایرت = رویداد امنیتی */
export async function readKycDocument(docId: number) {
  if (!Number.isInteger(docId)) return null;
  const [doc] = await db.select().from(kycDocuments).where(eq(kycDocuments.id, docId));
  if (!doc) return null;
  const [sub] = await db.select().from(kycSubmissions).where(eq(kycSubmissions.id, doc.submissionId));
  if (!sub) return null;
  try {
    const buffer = decryptBuf(await fs.readFile(path.join(kycDir(), path.basename(doc.file))));
    if (sha256Buf(buffer) !== doc.sha256) throw new Error("hash");
    return { doc, sub, buffer };
  } catch {
    await logAudit({ action: "kyc.doc_corrupt", workspaceId: sub.workspaceId, detail: `مدرک #${docId} قابل رمزگشایی یا راستی‌آزمایی نیست`, actor: "system" });
    return null;
  }
}

export async function kycCounts() {
  const rows = await db.select({ status: kycSubmissions.status, n: sql<number>`count(*)::int` }).from(kycSubmissions).groupBy(kycSubmissions.status);
  const m = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  return { pending: m.pending ?? 0, approved: m.approved ?? 0, rejected: m.rejected ?? 0 };
}
