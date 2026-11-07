import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { contracts, contractSigners, users, templates, auditLogs, otpCodes, shortLinks, signingLinks, workspaceMembers, workspaces, contractFieldValues, contractAmendments, amendmentSigners, contractRevisions, contractComments, contractApprovals } from "@/db/schema";
import { deleteAllAttachments } from "@/modules/attachments/service";
import { notifyUser } from "@/modules/inbox/service";
import type { SessionUser } from "@/modules/auth/session";
import { logAudit } from "@/modules/audit/service";
import { renderVariables } from "@/modules/variables";
import { sanitizeHtml, escapeHtml } from "@/lib/html";
import { fa, faNum } from "@/lib/jalali";
import { getAllSettings } from "@/modules/settings/service";
import { deleteSignatureFile } from "@/modules/signing/storage";
import { notifySigner, revokeSigningLinks } from "@/modules/signing/links";
import { deleteContractDocument } from "@/modules/pdf/service";
import { ensureShortLink, shortUrl } from "@/modules/links/service";
import { emitEvent } from "@/modules/webhooks/service";
import { assertUsersInWorkspace } from "@/modules/tenancy/service";
import { acquireIssueQuota } from "@/modules/billing/service";
import { qualifyReferralForWorkspace } from "@/modules/referral/service";
import { assertKycForValue } from "@/modules/kyc/service";
import { can, isTeamRole, type TeamRole } from "@/modules/tenancy/roles";
import { snapshotRevision } from "./revisions";
import { assertApprovalsClear, invalidateApprovals } from "./approvals";

export type Contract = typeof contracts.$inferSelect;
export type Signer = typeof contractSigners.$inferSelect;

export const STATUS_LABELS: Record<string, string> = {
  draft: "پیش‌نویس",
  sent: "ارسال شده",
  signed: "امضا شده",
  rejected: "رد شده",
  expired: "منقضی شده",
  cancelled: "لغو شده",
};
export const ADMIN_STATUSES = ["draft", "sent", "signed", "rejected", "expired", "cancelled"];

/** مهلت امضا: مقدار صریح، یا پیش‌فرض تنظیمات؛ صفر یعنی بدون انقضا */
export async function resolveExpiry(days: number | null | undefined, workspaceId: number): Promise<Date | null> {
  let d = days;
  if (d === undefined || d === null || Number.isNaN(d)) {
    d = Number((await getAllSettings(workspaceId)).default_expiry_days) || 0;
  }
  if (d <= 0) return null;
  return new Date(Date.now() + Math.min(d, 3650) * 86400000);
}

export interface IssueParams {
  /** فضای کاری مالک قرارداد (الزامی؛ همه‌ی کاربران باید عضو آن باشند) */
  workspaceId: number;
  title: string;
  bodyHtml: string;
  templateId?: number | null;
  customerId: number;
  /** امضاکنندگان قبل از مشتری، به ترتیب */
  extraSigners?: { label: string; userId: number }[];
  source?: "admin" | "shop";
  createdBy?: number | null;
  orderId?: number | null;
  productName?: string;
  amount?: number;
  customerLabel?: string;
  /** پیش‌نویس: ذخیره می‌شود اما برای هیچ‌کس ارسال نمی‌شود */
  draft?: boolean;
  expiryDays?: number | null;
  /** مدت اعتبار قرارداد (روز از لحظه‌ی امضای نهایی) برای یادآوری تمدید */
  termDays?: number | null;
  renewalNoticeDays?: number | null;
  /** ارزش مالی قرارداد (تومان) — اختیاری */
  contractValue?: number | null;
  /** برچسب‌ها (جداشده با ویرگول) — اختیاری */
  tags?: string;
}

/** برچسب‌ها: حداکثر ۸ مورد، هرکدام تا ۲۴ نویسه، بدون تکرار و بدون ویرگول داخلی */
export function normalizeTags(raw: string): string {
  const seen = new Set<string>();
  for (const part of String(raw || "").split(/[,،\n]/)) {
    const t = part.replace(/\s+/g, " ").trim().slice(0, 24);
    if (t) seen.add(t);
    if (seen.size >= 8) break;
  }
  return [...seen].join(",");
}

export function parseTags(raw: string | null | undefined): string[] {
  return (raw ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

type Cfg = Awaited<ReturnType<typeof getAllSettings>>;

function varsFor(customer: { name: string; email: string; mobile: string }, number: string, cfg: Cfg, extra?: { productName?: string; amount?: number }) {
  return {
    USER_NAME: customer.name,
    USER_EMAIL: customer.email,
    USER_MOBILE: customer.mobile,
    CONTRACT_NUMBER: number,
    DATE: fa(new Date()),
    SITE_NAME: cfg.site_name,
    PRODUCT_NAME: extra?.productName ?? "",
    AMOUNT: extra?.amount !== undefined ? faNum(extra.amount) : "",
  };
}

/** پس از انتشار: لینک کوتاه + ایمیل به اولین امضاکننده + رویداد وب‌هوک */
export async function announceContract(contractId: number) {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  if (!c) return;
  const cfg = await getAllSettings(c.workspaceId);
  const signers = await getSigners(contractId);
  const first = signers[0];
  const link = await ensureShortLink(contractId, c.createdBy);
  const url = await shortUrl(link.code);
  // لینک امضای اختصاصی (بدون نیاز به ثبت‌نام) به‌جای لینک ورود به حساب
  if (first) await notifySigner(contractId, first.id, "issue").catch(() => null);
  if (first) await notifyUser(first.userId, { kind: "action", title: `قرارداد جدید برای امضا: ${c.number}`, body: `«${c.title}» منتظر امضای شماست.`, href: `/contracts/${contractId}` });
  emitEvent({
    event: "contract.issued",
    contractId,
    text: `📄 قرارداد جدید صادر شد\n${c.number} — ${c.title}\nنوبت امضا: ${first ? `${first.label} (${first.userName})` : "—"}${cfg.app_url ? `\n${url}` : ""}`,
    data: { number: c.number, title: c.title },
  });
}

/**
 * صدور قرارداد؛ کاملاً اتمی.
 *
 * همه‌ی نوشتن‌های دیتابیس (مصرف سهمیه/اعتبار کیف پول، ردیف قرارداد، متن نهایی، نسخه‌ی اول، امضاکنندگان، لاگ ممیزی)
 * در «یک» تراکنش انجام می‌شود. اگر هر مرحله شکست بخورد، PostgreSQL همه را برمی‌گرداند:
 *  - ردیف نیمه‌کاره‌ی «TMP-… با متن خالی و وضعیت sent» هرگز باقی نمی‌ماند،
 *  - اعتبار کیف پول مصرف‌شده خودکار (با همان rollback) برمی‌گردد، بدون نیاز به «release» دستی،
 *  - وب‌هوک‌های صدور فقط پس از commit ارسال می‌شوند.
 * اعلان به اولین امضاکننده (ایمیل/لینک/پیامک) و پاداش دعوت، کارهای شبکه‌ای پس از commit هستند؛
 * شکست آن‌ها قرارداد صادرشده را باطل نمی‌کند و در لاگ ممیزی ثبت می‌شود (یادآوری خودکار دوباره تلاش می‌کند).
 */
export async function issueContract(p: IssueParams): Promise<number> {
  const [customer] = await db.select().from(users).where(eq(users.id, p.customerId));
  if (!customer) throw new Error("کاربر یافت نشد");
  // ایزولاسیون مستاجر: مشتری و همه‌ی امضاکنندگان باید عضو همین فضای کاری باشند
  await assertUsersInWorkspace(p.workspaceId, [p.customerId, ...(p.extraSigners ?? []).map((x) => x.userId)]);

  const cfg = await getAllSettings(p.workspaceId);
  const expiresAt = p.draft ? null : await resolveExpiry(p.expiryDays, p.workspaceId);

  const createdId = await withTransaction(async () => {
    // سقف ماهانه‌ی طرح (یا اعتبار قرارداد کیف پول) و احراز هویت قراردادهای پرمبلغ؛ پیش‌نویس‌ها سهمیه مصرف نمی‌کنند.
    // مصرف اعتبار داخل همین تراکنش است: با شکست مراحل بعد، خودبه‌خود برگردانده می‌شود.
    if (!p.draft) await acquireIssueQuota(p.workspaceId, 1, { contractValue: p.contractValue });

    const [created] = await db
      .insert(contracts)
      .values({
        workspaceId: p.workspaceId,
        number: `TMP-${Math.random().toString(36).slice(2, 10)}`,
        title: p.title,
        templateId: p.templateId ?? null,
        customerId: customer.id,
        bodyHtml: "",
        source: p.source ?? "admin",
        orderId: p.orderId ?? null,
        createdBy: p.createdBy ?? null,
        status: p.draft ? "draft" : "sent",
        contractValue: p.contractValue && p.contractValue > 0 ? Math.min(Math.round(p.contractValue), 2_000_000_000) : null,
        tags: normalizeTags(p.tags ?? ""),
        termDays: p.termDays && p.termDays > 0 ? Math.min(Math.round(p.termDays), 36500) : null,
        renewalNoticeDays: p.renewalNoticeDays && p.renewalNoticeDays > 0 ? Math.min(Math.round(p.renewalNoticeDays), 365) : 30,
        publishedAt: p.draft ? null : new Date(),
        expiresAt,
      })
      .returning();

    const number = `AMZ-${new Date().getFullYear()}-${String(created.id).padStart(5, "0")}`;
    const body = renderVariables(sanitizeHtml(p.bodyHtml), varsFor(customer, number, cfg, { productName: p.productName, amount: p.amount }));
    await db.update(contracts).set({ number, bodyHtml: body }).where(eq(contracts.id, created.id));
    await snapshotRevision(created.id, { title: p.title, bodyHtml: body, kind: p.draft ? "initial" : "publish", userId: p.createdBy ?? null });

    const steps = [
      ...(p.extraSigners ?? []),
      { label: p.customerLabel ?? "مشتری", userId: customer.id },
    ];
    const signerUsers = await db
      .select()
      .from(users)
      .where(inArray(users.id, steps.map((s) => s.userId)));
    await db.insert(contractSigners).values(
      steps.map((s, i) => ({
        contractId: created.id,
        position: i + 1,
        label: s.label,
        userId: s.userId,
        mobile: signerUsers.find((u) => u.id === s.userId)?.mobile ?? "",
      })),
    );

    await logAudit({
      action: p.draft ? "contract.draft_saved" : "contract.issued",
      workspaceId: p.workspaceId,
      contractId: created.id,
      userId: p.createdBy ?? customer.id,
      detail: `${number} — ${steps.map((s, i) => `${i + 1}. ${s.label}`).join(" ← ")}`,
    });
    return created.id;
  });

  // ───── پس از commit: اعلان به امضاکننده‌ی اول و پاداش دعوت (شبکه‌ای؛ جدا از اتمی بودن صدور) ─────
  if (!p.draft) {
    try {
      await announceContract(createdId);
    } catch (e) {
      console.error("[contract:announce]", e);
      await logAudit({ action: "contract.announce_failed", workspaceId: p.workspaceId, contractId: createdId, detail: (e instanceof Error ? e.message : "خطای ناشناخته").slice(0, 300), actor: "system" }).catch(() => undefined);
    }
    await qualifyReferralForWorkspace(p.workspaceId).catch(() => undefined);
  }
  return createdId;
}

/** ذخیره‌ی تغییرات پیش‌نویس (نسخه‌ی نهایی هرگز قابل ویرایش نیست) */
export async function saveDraft(id: number, adminId: number, input: { title: string; bodyHtml: string }, workspaceId: number) {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId)));
  if (!c || c.status !== "draft") throw new Error("فقط پیش‌نویس قابل ویرایش است");
  const body = sanitizeHtml(input.bodyHtml);
  await db.update(contracts).set({ title: input.title, bodyHtml: body }).where(eq(contracts.id, id));
  // نسخه‌ی جدید فقط وقتی ثبت می‌شود که چیزی تغییر کرده باشد؛ هر تغییر، تأییدهای داخلی قبلی را بی‌اعتبار می‌کند
  const created = await snapshotRevision(id, { title: input.title, bodyHtml: body, kind: "draft", userId: adminId });
  if (created) await invalidateApprovals(id, adminId, "ویرایش متن پیش‌نویس");
  await logAudit({ action: "contract.draft_saved", contractId: id, userId: adminId, detail: `${c.number}${created ? ` — نسخه‌ی ${created}` : ""}` });
}

/** انتشار پیش‌نویس: متغیرها جایگزین، نسخه قفل و برای امضاکننده‌ی اول ارسال می‌شود */
export async function publishDraft(id: number, adminId: number, input: { title: string; bodyHtml: string; expiryDays?: number | null }, workspaceId: number) {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId)));
  if (!c || c.status !== "draft") throw new Error("این قرارداد پیش‌نویس نیست");
  const quota = await acquireIssueQuota(workspaceId, 1, { contractValue: c.contractValue });
  try {
    const [customer] = await db.select().from(users).where(eq(users.id, c.customerId));
    if (!customer) throw new Error("مشتری یافت نشد");
    const cfg = await getAllSettings(workspaceId);
    const cleanIncoming = sanitizeHtml(input.bodyHtml);
    // اگر همزمان با انتشار متن تغییر کرده، ابتدا ثبت نسخه و ابطال تأییدها؛ سپس سد تأیید داخلی
    if (cleanIncoming !== c.bodyHtml || input.title !== c.title) {
      const created = await snapshotRevision(id, { title: input.title, bodyHtml: cleanIncoming, kind: "draft", userId: adminId });
      if (created) await invalidateApprovals(id, adminId, "ویرایش هم‌زمان با انتشار");
    }
    await assertApprovalsClear(id);
    const body = renderVariables(cleanIncoming, varsFor(customer, c.number, cfg));
    const now = new Date();
    const expiresAt = await resolveExpiry(input.expiryDays, workspaceId);
    // شرط status='draft' از انتشار دوباره‌ی همزمان جلوگیری می‌کند
    const updated = await db
      .update(contracts)
      .set({ title: input.title, bodyHtml: body, status: "sent", publishedAt: now, issuedAt: now, expiresAt, reminderCount: 0, lastReminderAt: null })
      .where(and(eq(contracts.id, id), eq(contracts.status, "draft")))
      .returning({ id: contracts.id });
    if (updated.length === 0) throw new Error("این قرارداد قبلاً منتشر شده است");
    await snapshotRevision(id, { title: input.title, bodyHtml: body, kind: "publish", userId: adminId });
    await logAudit({ action: "contract.published", contractId: id, userId: adminId, detail: `${c.number}${expiresAt ? ` — مهلت: ${fa(expiresAt)}` : ""}` });
    await announceContract(id);
    await qualifyReferralForWorkspace(workspaceId).catch(() => undefined);
  } catch (e) {
    await quota.release();
    throw e;
  }
}

/**
 * کپی قرارداد به‌صورت «پیش‌نویس» جدید (صدور مجدد پس از رد، انقضا یا لغو؛ یا ساخت قرارداد مشابه).
 * مشتری، ترتیب و برچسب امضاکنندگان و متن حفظ می‌شود؛ شماره‌ی قدیمی و تاریخ صدور داخل متن دوباره
 * به متغیر تبدیل می‌شوند تا هنگام انتشار با شماره و تاریخ جدید جایگزین شوند. پیش‌نویس سقف ماهانه‌ی طرح را مصرف نمی‌کند.
 */
export async function duplicateContract(id: number, actorId: number, workspaceId: number): Promise<number> {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId)));
  if (!c) throw new Error("قرارداد یافت نشد");
  const signers = await getSigners(id);
  // در صدور، مشتری همیشه آخرین امضاکننده است؛ بقیه «امضاکننده‌ی اضافه» هستند
  const customerStep = signers[signers.length - 1];
  const extraSigners = signers.slice(0, -1).map((s) => ({ label: s.label, userId: s.userId }));
  const body = c.bodyHtml.split(c.number).join("[CONTRACT_NUMBER]").split(fa(c.issuedAt)).join("[DATE]");
  const newId = await issueContract({
    workspaceId,
    title: c.title,
    bodyHtml: body,
    templateId: c.templateId,
    customerId: c.customerId,
    customerLabel: customerStep?.label,
    extraSigners,
    source: "admin",
    createdBy: actorId,
    draft: true,
  });
  await logAudit({ action: "contract.duplicated", contractId: newId, userId: actorId, workspaceId, detail: `کپی از ${c.number}` });
  return newId;
}

/** لغو توسط مدیر (فقط قراردادهای در جریان) */
export async function cancelContract(id: number, adminId: number, reason: string, workspaceId: number) {
  const updated = await db
    .update(contracts)
    .set({ status: "cancelled" })
    .where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId), eq(contracts.status, "sent")))
    .returning({ number: contracts.number });
  if (updated.length === 0) throw new Error("فقط قراردادهای در انتظار امضا قابل لغو هستند");
  await revokeSigningLinks({ contractId: id });
  await logAudit({ action: "contract.cancelled", contractId: id, userId: adminId, detail: `${updated[0].number}${reason ? ` — ${reason.slice(0, 200)}` : ""}` });
  emitEvent({ event: "contract.cancelled", contractId: id, text: `🚫 قرارداد ${updated[0].number} لغو شد.${reason ? `\nدلیل: ${reason.slice(0, 200)}` : ""}`, data: { number: updated[0].number } });
}

export async function getSigners(contractId: number) {
  return db
    .select({
      id: contractSigners.id,
      contractId: contractSigners.contractId,
      position: contractSigners.position,
      label: contractSigners.label,
      userId: contractSigners.userId,
      status: contractSigners.status,
      signedAt: contractSigners.signedAt,
      ip: contractSigners.ip,
      userAgent: contractSigners.userAgent,
      signatureFile: contractSigners.signatureFile,
      signatureMethod: contractSigners.signatureMethod,
      otpVerifiedAt: contractSigners.otpVerifiedAt,
      mobile: contractSigners.mobile,
      userName: users.name,
      userEmail: users.email,
    })
    .from(contractSigners)
    .innerJoin(users, eq(users.id, contractSigners.userId))
    .where(eq(contractSigners.contractId, contractId))
    .orderBy(asc(contractSigners.position));
}
export type SignerRow = Awaited<ReturnType<typeof getSigners>>[number];

/** نوبت امضا: اولین امضاکننده‌ای که هنوز امضا نکرده */
export function currentSigner(signers: SignerRow[]) {
  return signers.find((s) => s.status === "pending") ?? null;
}

/**
 * جداسازی کاربران: فقط مدیر، مشتری و امضاکنندگان همین قرارداد دسترسی دارند.
 * در غیر این صورت null برمی‌گردد (و تلاش در لاگ ثبت می‌شود).
 */
export async function getContractForUser(user: SessionUser, id: number) {
  if (!Number.isInteger(id)) return null;
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, id));
  if (!contract) return null;
  // نقش کاربر در فضای کاری همین قرارداد (نه فضای کاری فعال او!)
  const [m] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, contract.workspaceId), eq(workspaceMembers.userId, user.id)));
  const teamRole: TeamRole | null = m && isTeamRole(m.role) ? m.role : null;
  // پیش‌نویس فقط برای تیم قابل مشاهده است
  if (contract.status === "draft" && !teamRole) return null;
  const signers = await getSigners(id);
  const allowed = !!teamRole || contract.customerId === user.id || signers.some((s) => s.userId === user.id);
  if (!allowed) {
    await logAudit({ action: "access.denied", contractId: id, userId: user.id });
    return null;
  }
  const [customer] = await db.select().from(users).where(eq(users.id, contract.customerId));
  return { contract, signers, customer, teamRole };
}

export type UserFilter = "all" | "pending" | "signed";

export async function listContractsForUser(userId: number, filter: UserFilter) {
  const rows = await db
    .select({
      id: contracts.id,
      number: contracts.number,
      title: contracts.title,
      status: contracts.status,
      issuedAt: contracts.issuedAt,
      signedAt: contracts.signedAt,
      mySignerStatus: contractSigners.status,
      myLabel: contractSigners.label,
      myPosition: contractSigners.position,
      workspaceName: workspaces.name,
    })
    .from(contractSigners)
    .innerJoin(contracts, eq(contracts.id, contractSigners.contractId))
    .innerJoin(workspaces, eq(workspaces.id, contracts.workspaceId))
    .where(and(eq(contractSigners.userId, userId), ne(contracts.status, "draft")))
    .orderBy(desc(contracts.issuedAt));

  // محاسبه‌ی «نوبت من» برای هر قرارداد
  const ids = rows.map((r) => r.id);
  const pendingSigners = ids.length
    ? await db
        .select({ contractId: contractSigners.contractId, position: contractSigners.position })
        .from(contractSigners)
        .where(and(inArray(contractSigners.contractId, ids), eq(contractSigners.status, "pending")))
    : [];
  const minPending = new Map<number, number>();
  for (const s of pendingSigners) {
    const cur = minPending.get(s.contractId);
    if (cur === undefined || s.position < cur) minPending.set(s.contractId, s.position);
  }

  const mapped = rows.map((r) => {
    let state: "my_turn" | "waiting" | "signed" | "rejected" | "expired" | "cancelled" = "waiting";
    if (r.mySignerStatus === "signed") state = "signed";
    else if (r.status === "rejected") state = "rejected";
    else if (r.status === "expired") state = "expired";
    else if (r.status === "cancelled") state = "cancelled";
    else if (minPending.get(r.id) === r.myPosition) state = "my_turn";
    return { ...r, state };
  });

  if (filter === "pending") return mapped.filter((r) => r.state === "my_turn" || r.state === "waiting");
  if (filter === "signed") return mapped.filter((r) => r.state === "signed");
  return mapped;
}

export interface ContractFilters {
  status?: string;
  q?: string;
  /** YYYY-MM-DD (بازه‌ی تاریخ صدور) */
  from?: string;
  to?: string;
  templateId?: number;
  source?: string;
  /** فقط قراردادهای در آستانه‌ی انقضا (۳ روز) */
  expiring?: boolean;
  sort?: string;
  page?: number;
  pageSize?: number;
  /** برای خروجی فقط موارد انتخاب‌شده */
  ids?: number[];
  /** true = فقط بایگانی‌شده‌ها؛ در غیر این صورت بایگانی‌شده‌ها از لیست حذف می‌شوند */
  archived?: boolean;
  /** فیلتر برچسب */
  tag?: string;
  /** فقط قراردادهایی که درخواست اصلاح بازِ طرف مقابل دارند */
  openRequests?: boolean;
}

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** سقف شمارش کل نتایج جستجو (فقط برای صفحه‌بندی؛ بیش از آن «+۱۰۰۰۰» است و کاربر باید فیلتر را دقیق‌تر کند) */
const COUNT_CAP = 10_000;

export const SORTS: Record<string, string> = {
  newest: "جدیدترین صدور",
  oldest: "قدیمی‌ترین صدور",
  signed: "آخرین امضا",
  title: "عنوان (الفبایی)",
};

/** جستجوی پیشرفته‌ی قراردادهای یک فضای کاری (فیلتر، مرتب‌سازی، صفحه‌بندی) */
export async function queryContracts(workspaceId: number, f: ContractFilters) {
  const conds = [eq(contracts.workspaceId, workspaceId)];
  if (f.status && ADMIN_STATUSES.includes(f.status)) conds.push(eq(contracts.status, f.status));
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    // PERF-02: OR روی ستون‌های دو جدول (contracts و users) هیچ ایندکسی را نمی‌گیرد. جستجو به دو زیرپرس‌وجوی جدا (هرکدام روی
    // یک جدول با BitmapOr روی ایندکس‌های trigram) شکسته و با UNION ادغام می‌شود؛ ILIKE '%q%' دیگر اسکن کامل نیست.
    conds.push(sql`${contracts.id} in (
      select c.id from contracts c
        where c.workspace_id = ${workspaceId} and (c.number ilike ${like} or c.title ilike ${like} or c.tags ilike ${like})
      union
      select c.id from contracts c
        where c.workspace_id = ${workspaceId} and c.customer_id in (select u.id from users u where u.name ilike ${like} or u.email ilike ${like})
    )`);
  }
  if (f.from && DATE_RE.test(f.from)) conds.push(gte(contracts.issuedAt, new Date(`${f.from}T00:00:00`)));
  if (f.to && DATE_RE.test(f.to)) conds.push(lt(contracts.issuedAt, new Date(new Date(`${f.to}T00:00:00`).getTime() + 86400000)));
  if (f.templateId) conds.push(eq(contracts.templateId, f.templateId));
  if (f.source === "admin" || f.source === "shop") conds.push(eq(contracts.source, f.source));
  if (f.expiring) conds.push(sql`${contracts.status} = 'sent' and ${contracts.expiresAt} is not null and ${contracts.expiresAt} < now() + interval '3 days'`);
  if (f.ids && f.ids.length) conds.push(inArray(contracts.id, f.ids.slice(0, 1000)));
  conds.push(f.archived ? sql`${contracts.archivedAt} is not null` : sql`${contracts.archivedAt} is null`);
  if (f.tag) conds.push(sql`(',' || ${contracts.tags} || ',') ilike ${`%,${escapeLike(f.tag.slice(0, 24))},%`}`);
  if (f.openRequests) conds.push(sql`exists (select 1 from contract_comments cc where cc.contract_id = ${contracts.id} and cc.kind = 'change_request' and cc.status = 'open' and cc.parent_id is null)`);
  const where = and(...conds);

  const pageSize = Math.min(Math.max(f.pageSize ?? 20, 1), 5000);
  const order =
    f.sort === "oldest" ? asc(contracts.issuedAt) : f.sort === "signed" ? sql`${contracts.signedAt} desc nulls last` : f.sort === "title" ? asc(contracts.title) : desc(contracts.issuedAt);

  const fetchPage = (pg: number) =>
    db
      .select({
        id: contracts.id,
        number: contracts.number,
        title: contracts.title,
        status: contracts.status,
        source: contracts.source,
        issuedAt: contracts.issuedAt,
        signedAt: contracts.signedAt,
        expiresAt: contracts.expiresAt,
        userName: users.name,
        userEmail: users.email,
        templateTitle: templates.title,
        tags: contracts.tags,
        contractValue: contracts.contractValue,
        archivedAt: contracts.archivedAt,
      })
      .from(contracts)
      .innerJoin(users, eq(users.id, contracts.customerId))
      .leftJoin(templates, eq(templates.id, contracts.templateId))
      .where(where)
      .orderBy(order, desc(contracts.id))
      .limit(pageSize)
      .offset((pg - 1) * pageSize);

  // PERF-02: شمارش کامل در هر نمایش صفحه حذف شد.
  //  • صفحه‌ی ناقص (رایج‌ترین حالت) خودش تعداد کل را می‌گوید → هیچ count اجرا نمی‌شود.
  //  • فقط وقتی صفحه پر است، شمارش «سقف‌دار» (حداکثر COUNT_CAP ردیف خوانده می‌شود، نه کل جدول) اجرا می‌شود.
  let page = Math.max(f.page ?? 1, 1);
  let rows = await fetchPage(page);
  let total: number;
  let totalCapped = false;
  const needCount = rows.length === pageSize || (rows.length === 0 && page > 1);
  if (!needCount) total = (page - 1) * pageSize + rows.length;
  else {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sql`(select 1 from ${contracts} inner join ${users} on ${users.id} = ${contracts.customerId} where ${where} limit ${COUNT_CAP + 1}) as capped`);
    totalCapped = n > COUNT_CAP;
    total = Math.min(n, COUNT_CAP);
  }
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (page > pages) {
    page = pages;
    rows = await fetchPage(page);
  }

  // PERF-02: به‌جای یک زیرپرس‌وجوی count(*) برای «هر ردیف»، یک GROUP BY دسته‌ای فقط برای ردیف‌های همین صفحه (با ایندکس جزئی)
  const open = new Map<number, number>();
  if (rows.length) {
    const agg = await db
      .select({ id: contractComments.contractId, n: sql<number>`count(*)::int` })
      .from(contractComments)
      .where(and(inArray(contractComments.contractId, rows.map((r) => r.id)), eq(contractComments.kind, "change_request"), eq(contractComments.status, "open"), isNull(contractComments.parentId)))
      .groupBy(contractComments.contractId);
    for (const a of agg) open.set(a.id, a.n);
  }
  return { rows: rows.map((r) => ({ ...r, openRequests: open.get(r.id) ?? 0 })), total, totalCapped, page, pages, pageSize };
}

export async function adminCounts(workspaceId: number) {
  const rows = await db
    .select({ status: contracts.status, archived: sql<boolean>`(${contracts.archivedAt} is not null)`, n: sql<number>`count(*)::int` })
    .from(contracts)
    .where(eq(contracts.workspaceId, workspaceId))
    .groupBy(contracts.status, sql`(${contracts.archivedAt} is not null)`);
  // all = همه (سازگار با API)، active = بدون بایگانی (نمایش پیش‌فرض لیست)، archived = بایگانی‌شده
  const c = { all: 0, active: 0, archived: 0, draft: 0, sent: 0, signed: 0, rejected: 0, expired: 0, cancelled: 0 } as Record<string, number>;
  for (const r of rows) {
    c.all += r.n;
    if (r.archived) c.archived += r.n;
    else {
      c.active += r.n;
      c[r.status] = (c[r.status] ?? 0) + r.n;
    }
  }
  return c;
}

/** برچسب‌های پرکاربرد فضای کاری (برای فیلتر و پیشنهاد) */
export async function listTags(workspaceId: number): Promise<{ tag: string; n: number }[]> {
  const rows = await db.select({ tags: contracts.tags }).from(contracts).where(and(eq(contracts.workspaceId, workspaceId), ne(contracts.tags, "")));
  const m = new Map<string, number>();
  for (const r of rows) for (const t of parseTags(r.tags)) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m.entries()].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).slice(0, 40);
}

const ARCHIVABLE = ["signed", "rejected", "expired", "cancelled"];

/** انتقال به بایگانی یا بازگردانی؛ فقط قراردادهای پایان‌یافته. بایگانی چیزی را حذف نمی‌کند و همه‌ی سوابق می‌ماند. */
export async function setArchived(id: number, workspaceId: number, userId: number, archived: boolean): Promise<boolean> {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId)));
  if (!c) return false;
  if (archived && (!ARCHIVABLE.includes(c.status) || c.archivedAt)) return false;
  if (!archived && !c.archivedAt) return false;
  await db.update(contracts).set({ archivedAt: archived ? new Date() : null }).where(eq(contracts.id, id));
  await logAudit({ action: archived ? "contract.archived" : "contract.unarchived", contractId: id, userId, workspaceId, detail: c.number });
  return true;
}

/** ویرایش برچسب‌ها و ارزش مالی (متن قرارداد را تغییر نمی‌دهد؛ در هر وضعیتی مجاز است) */
export async function updateContractMeta(id: number, workspaceId: number, userId: number, input: { tags: string; value: number | null }): Promise<boolean> {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId)));
  if (!c) return false;
  const tags = normalizeTags(input.tags);
  const value = input.value && input.value > 0 ? Math.min(Math.round(input.value), 2_000_000_000) : null;
  // بالا بردن ارزش قرارداد منتشرشده نباید راهی برای دور زدن احراز هویت باشد
  if (c.status !== "draft" && value && value > (c.contractValue ?? 0)) await assertKycForValue(workspaceId, value);
  await db.update(contracts).set({ tags, contractValue: value }).where(eq(contracts.id, id));
  await logAudit({ action: "contract.meta_updated", contractId: id, userId, workspaceId, detail: `${c.number} — برچسب‌ها: ${tags || "—"}${value ? ` • ارزش: ${value.toLocaleString("fa-IR")} تومان` : ""}` });
  return true;
}

export async function removeContract(id: number, adminId: number, workspaceId: number): Promise<boolean> {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId)));
  if (!c) return false;
  const signers = await db.select().from(contractSigners).where(eq(contractSigners.contractId, id));
  for (const s of signers) if (s.signatureFile) await deleteSignatureFile(s.signatureFile);
  await db.delete(otpCodes).where(eq(otpCodes.contractId, id));
  await deleteContractDocument(id);
  await deleteAllAttachments(id);
  await db.delete(contractFieldValues).where(eq(contractFieldValues.contractId, id));
  await db.delete(contractRevisions).where(eq(contractRevisions.contractId, id));
  await db.delete(contractComments).where(eq(contractComments.contractId, id));
  await db.delete(contractApprovals).where(eq(contractApprovals.contractId, id));
  const ams = await db.select({ id: contractAmendments.id }).from(contractAmendments).where(eq(contractAmendments.contractId, id));
  if (ams.length) await db.delete(amendmentSigners).where(inArray(amendmentSigners.amendmentId, ams.map((a) => a.id)));
  await db.delete(contractAmendments).where(eq(contractAmendments.contractId, id));
  await db.delete(signingLinks).where(eq(signingLinks.contractId, id));
  await db.delete(shortLinks).where(eq(shortLinks.contractId, id));
  await db.delete(contractSigners).where(eq(contractSigners.contractId, id));
  await db.delete(contracts).where(eq(contracts.id, id));
  // لاگ‌های قبلی حفظ می‌شوند تا قابل پیگیری بمانند
  await db.update(auditLogs).set({ detail: sql`${auditLogs.detail} || ' [قرارداد حذف شد]'` }).where(and(eq(auditLogs.contractId, id), eq(auditLogs.action, "contract.issued")));
  await logAudit({ action: "contract.deleted", workspaceId, contractId: id, userId: adminId, detail: c.number });
  return true;
}

/** آمار تجاری برای داشبورد مدیر: نرخ تکمیل، میانگین زمان امضا، قراردادهای در آستانه‌ی انقضا */
export async function adminStats(workspaceId: number) {
  const [row] = await db
    .select({
      total: sql<number>`count(*) filter (where ${contracts.status} <> 'draft')::int`,
      signed: sql<number>`count(*) filter (where ${contracts.status} = 'signed')::int`,
      pending: sql<number>`count(*) filter (where ${contracts.status} = 'sent')::int`,
      avgHours: sql<number | null>`avg(extract(epoch from (${contracts.signedAt} - ${contracts.issuedAt})) / 3600) filter (where ${contracts.status} = 'signed')`,
      expiringSoon: sql<number>`count(*) filter (where ${contracts.status} = 'sent' and ${contracts.expiresAt} is not null and ${contracts.expiresAt} < now() + interval '3 days')::int`,
      reminders: sql<number>`coalesce(sum(${contracts.reminderCount}), 0)::int`,
    })
    .from(contracts)
    .where(eq(contracts.workspaceId, workspaceId));
  return {
    total: row?.total ?? 0,
    signed: row?.signed ?? 0,
    pending: row?.pending ?? 0,
    rate: row && row.total > 0 ? Math.round((row.signed / row.total) * 100) : 0,
    avgHours: row?.avgHours ? Number(row.avgHours) : null,
    expiringSoon: row?.expiringSoon ?? 0,
    reminders: row?.reminders ?? 0,
  };
}

/** گزارش ماهانه‌ی ۶ ماه اخیر + عملکرد قالب‌ها (برای صفحه‌ی گزارش‌ها) */
export async function reportData(workspaceId: number) {
  const monthly = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${contracts.issuedAt}), 'YYYY-MM')`,
      issued: sql<number>`count(*)::int`,
      signed: sql<number>`count(*) filter (where ${contracts.status} = 'signed')::int`,
      rejected: sql<number>`count(*) filter (where ${contracts.status} in ('rejected','expired','cancelled'))::int`,
    })
    .from(contracts)
    .where(and(eq(contracts.workspaceId, workspaceId), ne(contracts.status, "draft"), sql`${contracts.issuedAt} >= date_trunc('month', now()) - interval '5 months'`))
    .groupBy(sql`date_trunc('month', ${contracts.issuedAt})`)
    .orderBy(sql`date_trunc('month', ${contracts.issuedAt})`);
  const byTemplate = await db
    .select({
      title: sql<string>`coalesce(${templates.title}, 'بدون قالب')`,
      total: sql<number>`count(*)::int`,
      signed: sql<number>`count(*) filter (where ${contracts.status} = 'signed')::int`,
      avgHours: sql<number | null>`avg(extract(epoch from (${contracts.signedAt} - ${contracts.issuedAt})) / 3600) filter (where ${contracts.status} = 'signed')`,
    })
    .from(contracts)
    .leftJoin(templates, eq(templates.id, contracts.templateId))
    .where(and(eq(contracts.workspaceId, workspaceId), ne(contracts.status, "draft")))
    .groupBy(templates.title)
    .orderBy(sql`count(*) desc`)
    .limit(10);
  const slowest = await db
    .select({ id: contracts.id, number: contracts.number, title: contracts.title, issuedAt: contracts.issuedAt, userName: users.name })
    .from(contracts)
    .innerJoin(users, eq(users.id, contracts.customerId))
    .where(and(eq(contracts.workspaceId, workspaceId), eq(contracts.status, "sent")))
    .orderBy(asc(contracts.issuedAt))
    .limit(8);
  return { monthly, byTemplate, slowest };
}

/** نام فضای کاری (برای نمایش به مشتری) */
export async function workspaceName(workspaceId: number): Promise<string> {
  const [w] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return w?.name ?? "";
}
