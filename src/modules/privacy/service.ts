import crypto from "node:crypto";
import { deleteUserChats, exportUserChats } from "@/modules/chat/service";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import {
  amendmentSigners, auditLogs, contractApprovals, contractAttachments, contractComments, contractFieldValues, contracts, contractSigners, emailVerifications, passwordResets,
  kycDocuments, kycSubmissions, ticketMessages, tickets, userNotifications, userSessions, userTotp, users, workspaceInvites, workspaceMembers, workspaces,
} from "@/db/schema";
import { logAudit } from "@/modules/audit/service";
import { enqueueJob } from "@/modules/jobs/queue";
import { revokeSigningLinks } from "@/modules/signing/links";

/**
 * خروجی کامل داده‌های شخصی کاربر (حق دسترسی به داده). رمز، راز TOTP، توکن‌ها و هش‌های امنیتی هرگز در خروجی نیستند.
 */
export async function buildUserExport(userId: number) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) return null;
  const memberships = await db
    .select({ workspace: workspaces.name, role: workspaceMembers.role, since: workspaceMembers.createdAt })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));
  const asSigner = await db
    .select({
      contractNumber: contracts.number,
      title: contracts.title,
      contractStatus: contracts.status,
      issuedAt: contracts.issuedAt,
      completedAt: contracts.signedAt,
      docHash: contracts.docHash,
      role: contractSigners.label,
      position: contractSigners.position,
      signerStatus: contractSigners.status,
      signedAt: contractSigners.signedAt,
      ip: contractSigners.ip,
      userAgent: contractSigners.userAgent,
      signatureMethod: contractSigners.signatureMethod,
      contractId: contracts.id,
      signerId: contractSigners.id,
    })
    .from(contractSigners)
    .innerJoin(contracts, eq(contracts.id, contractSigners.contractId))
    .where(eq(contractSigners.userId, userId))
    .orderBy(desc(contracts.issuedAt));
  const signerIds = asSigner.map((s) => s.signerId);
  const fields = signerIds.length ? await db.select().from(contractFieldValues).where(inArray(contractFieldValues.signerId, signerIds)) : [];
  const amendments = await db.select({ amendmentId: amendmentSigners.amendmentId, status: amendmentSigners.status, decidedAt: amendmentSigners.decidedAt, ip: amendmentSigners.ip }).from(amendmentSigners).where(eq(amendmentSigners.userId, userId));
  const attachments = await db
    .select({ contractId: contractAttachments.contractId, name: contractAttachments.originalName, mime: contractAttachments.mime, size: contractAttachments.size, sha256: contractAttachments.sha256, uploadedAt: contractAttachments.createdAt })
    .from(contractAttachments)
    .where(eq(contractAttachments.uploadedBy, userId));
  const audit = await db
    .select({ at: auditLogs.createdAt, action: auditLogs.action, detail: auditLogs.detail, ip: auditLogs.ip, userAgent: auditLogs.userAgent, contractId: auditLogs.contractId })
    .from(auditLogs)
    .where(eq(auditLogs.userId, userId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(5000);
  const inbox = await db.select({ at: userNotifications.createdAt, kind: userNotifications.kind, title: userNotifications.title, body: userNotifications.body, readAt: userNotifications.readAt }).from(userNotifications).where(eq(userNotifications.userId, userId));
  const sessions = await db.select({ createdAt: userSessions.createdAt, lastSeenAt: userSessions.lastSeenAt, ip: userSessions.ip, userAgent: userSessions.userAgent, revokedAt: userSessions.revokedAt }).from(userSessions).where(eq(userSessions.userId, userId));
  const myTickets = await db.select({ id: tickets.id, number: tickets.number, subject: tickets.subject, status: tickets.status, createdAt: tickets.createdAt }).from(tickets).where(eq(tickets.userId, userId));
  const messages = await db.select({ ticketId: ticketMessages.ticketId, body: ticketMessages.body, isStaff: ticketMessages.isStaff, createdAt: ticketMessages.createdAt }).from(ticketMessages).where(eq(ticketMessages.userId, userId));
  const liveChats = await exportUserChats(userId);
  const negotiation = await db
    .select({ contractId: contractComments.contractId, body: contractComments.body, kind: contractComments.kind, visibility: contractComments.visibility, createdAt: contractComments.createdAt })
    .from(contractComments)
    .where(eq(contractComments.authorUserId, userId));
  const [totp] = await db.select({ enabledAt: userTotp.enabledAt }).from(userTotp).where(eq(userTotp.userId, userId));

  return {
    exportedAt: new Date().toISOString(),
    format: "emzagar-personal-data/1",
    note: "این فایل شامل همه‌ی داده‌های شخصی ثبت‌شده از شماست. رمز عبور، کلید TOTP و توکن‌های امنیتی عمداً در آن نیست.",
    profile: { id: u.id, name: u.name, email: u.email, mobile: u.mobile, role: u.role, emailVerifiedAt: u.emailVerifiedAt, createdAt: u.createdAt, twoFactorEnabled: !!totp?.enabledAt },
    workspaces: memberships,
    contractsAsSigner: asSigner.map(({ signerId, ...rest }) => ({ ...rest, filledFields: fields.filter((f) => f.signerId === signerId).map((f) => ({ key: f.key, label: f.label, value: f.value, filledAt: f.filledAt })) })),
    amendmentDecisions: amendments,
    attachmentsUploaded: attachments,
    negotiationMessages: negotiation,
    activityLog: audit,
    inboxNotifications: inbox,
    sessions,
    supportTickets: { tickets: myTickets, messages },
    liveChats,
  };
}

export type DeleteResult = { ok: true; cancelled: number } | { ok: false; error: string };

/**
 * حذف حساب = «ناشناس‌سازی» برگشت‌ناپذیر: مشخصات، نشست‌ها، 2FA، عضویت‌ها و اعلان‌ها پاک می‌شوند؛
 * قراردادهای امضاشده برای حفظ اعتبار حقوقی طرف مقابل (و هش اسناد) با هویت ناشناس‌شده نگهداری می‌شوند.
 * قراردادهای در جریان لغو می‌شوند. مالک فضای کاری‌ای که عضو تیمی دیگر دارد باید ابتدا مالکیت را منتقل کند.
 */
export async function deleteAccount(userId: number): Promise<DeleteResult> {
  // DB-04: کل ناشناس‌سازی «یک تراکنش» است (پیش‌تر ۱۰ دستور جدا بود و شکست میانه، حساب را نیمه‌پاک رها می‌کرد).
  // فایل‌های دیسک (امضا/KYC) داخل تراکنش فقط «برنامه‌ریزی» می‌شوند (Outbox) و پس از commit موفق، ماندگار و تکرارپذیر پاک می‌شوند.
  return withTransaction(async (): Promise<DeleteResult> => {
    // قفل ردیف کاربر: دو درخواست هم‌زمان حذف، یکدیگر را نمی‌شکنند
    const [u] = await db.select().from(users).where(eq(users.id, userId)).for("update");
    if (!u) return { ok: false, error: "حساب یافت نشد" };

    const owned = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(eq(workspaces.ownerId, userId));
    for (const w of owned) {
      const others = await db
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, w.id), ne(workspaceMembers.userId, userId), ne(workspaceMembers.role, "client")))
        .limit(1);
      if (others.length) return { ok: false, error: `شما مالک فضای کاری «${w.name}» هستید که عضو تیمی دیگری دارد؛ ابتدا مالکیت را منتقل کنید یا اعضا را حذف کنید.` };
    }
    if (u.role === "admin") {
      const [other] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.role, "admin"), ne(users.id, userId)));
      if ((other?.n ?? 0) === 0) return { ok: false, error: "شما تنها مدیر کل پلتفرم هستید؛ ابتدا مدیر دیگری تعیین کنید." };
    }

    // قراردادهای در جریان که این کاربر طرف آن‌هاست (امضاکننده یا مشتری) دیگر قابل امضا نیستند
    const sig = await db.select({ id: contractSigners.contractId }).from(contractSigners).where(eq(contractSigners.userId, userId));
    const open = await db
      .select({ id: contracts.id, number: contracts.number, workspaceId: contracts.workspaceId })
      .from(contracts)
      .where(and(eq(contracts.status, "sent"), or(eq(contracts.customerId, userId), sig.length ? inArray(contracts.id, sig.map((s) => s.id)) : sql`false`)));
    for (const c of open) {
      await db.update(contracts).set({ status: "cancelled" }).where(and(eq(contracts.id, c.id), eq(contracts.status, "sent")));
      await revokeSigningLinks({ contractId: c.id });
      await logAudit({ action: "contract.cancelled", workspaceId: c.workspaceId, contractId: c.id, actor: "system", detail: `${c.number} — لغو خودکار: حذف حساب یکی از طرفین` });
    }

    const anon = `deleted-${userId}-${crypto.randomBytes(4).toString("hex")}@deleted.invalid`;
    await db
      .update(users)
      .set({ name: "کاربر حذف‌شده", email: anon, mobile: "", passwordHash: `x:${crypto.randomBytes(32).toString("hex")}`, emailVerifiedAt: null })
      .where(eq(users.id, userId));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    // نام نویسنده‌ی پیام‌های مذاکره ناشناس می‌شود (خودِ گفتگو برای سابقه‌ی قرارداد می‌ماند)
    await db.update(contractComments).set({ authorName: "کاربر حذف‌شده" }).where(eq(contractComments.authorUserId, userId));
    await db.delete(contractApprovals).where(and(eq(contractApprovals.approverId, userId), eq(contractApprovals.status, "pending")));
    await db.delete(userTotp).where(eq(userTotp.userId, userId));
    await db.delete(userNotifications).where(eq(userNotifications.userId, userId));
    await db.delete(passwordResets).where(eq(passwordResets.userId, userId));
    await db.delete(emailVerifications).where(eq(emailVerifications.userId, userId));
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, userId));
    await db.delete(workspaceInvites).where(sql`lower(${workspaceInvites.email}) = ${u.email.toLowerCase()}`);
    await db.update(contractSigners).set({ mobile: "", userAgent: null }).where(and(eq(contractSigners.userId, userId), ne(contractSigners.status, "signed")));

    // مدارک احراز هویت (KYC): ردیف‌ها (مشخصات، کد ملی رمزنگاری‌شده/هش) و فایل‌های رمزنگاری‌شده‌ی تصویر مدارک
    const kycFiles = (
      await db
        .select({ file: kycDocuments.file })
        .from(kycDocuments)
        .innerJoin(kycSubmissions, eq(kycSubmissions.id, kycDocuments.submissionId))
        .where(eq(kycSubmissions.userId, userId))
    ).map((r) => r.file);
    await db.delete(kycSubmissions).where(eq(kycSubmissions.userId, userId)); // kyc_documents با CASCADE

    // تصویر امضا: داده‌ی شخصی است. فقط برای قراردادهایی پاک می‌شود که «شواهد» دیگری از آن نگه می‌دارند:
    // PDF نهایی ذخیره‌شده (تصویر امضا در آن درج و با SHA-256 مهر شده) یا قراردادی که هیچ‌وقت امضای نهایی نشد.
    // امضای قرارداد نهاییِ بدون PDF ذخیره‌شده تا ساخته‌شدن PDF حفظ می‌ماند (هنوز تنها مدرک حقوقی است).
    const sigRows = await db
      .select({ id: contractSigners.id, file: contractSigners.signatureFile })
      .from(contractSigners)
      .innerJoin(contracts, eq(contracts.id, contractSigners.contractId))
      .where(
        and(
          eq(contractSigners.userId, userId),
          sql`${contractSigners.signatureFile} is not null`,
          sql`(${contracts.status} <> 'signed' or exists (select 1 from contract_documents d where d.contract_id = ${contracts.id}))`,
        ),
      );
    if (sigRows.length) {
      await db.update(contractSigners).set({ signatureFile: null }).where(inArray(contractSigners.id, sigRows.map((r) => r.id)));
    }
    const signatureFiles = sigRows.map((r) => r.file).filter((f): f is string => !!f);

    // پاراف و مهر شرکتی هم با همان شرط (PDF مهرشده یا قرارداد ناتمام) پاک می‌شوند؛ هش آن‌ها در ردیف می‌ماند
    const evRows = await db
      .select({ id: contractSigners.id, seal: contractSigners.sealFile, initials: contractSigners.initialsFile })
      .from(contractSigners)
      .innerJoin(contracts, eq(contracts.id, contractSigners.contractId))
      .where(
        and(
          eq(contractSigners.userId, userId),
          sql`(${contractSigners.sealFile} is not null or ${contractSigners.initialsFile} is not null)`,
          sql`(${contracts.status} <> 'signed' or exists (select 1 from contract_documents d where d.contract_id = ${contracts.id}))`,
        ),
      );
    if (evRows.length) await db.update(contractSigners).set({ sealFile: null, initialsFile: null }).where(inArray(contractSigners.id, evRows.map((r) => r.id)));
    const evidenceFiles = evRows.flatMap((r) => [r.seal, r.initials]).filter((f): f is string => !!f);

    // پشتیبانی: تیکت‌های خود کاربر (و پیام‌های آن با CASCADE) پاک می‌شود؛ پیام‌های کاربر در تیکت‌های دیگران ناشناس می‌شود
    await deleteUserChats(userId);
    await db.delete(tickets).where(eq(tickets.userId, userId));
    await db.update(ticketMessages).set({ body: "[پیام کاربر حذف‌شده]" }).where(and(eq(ticketMessages.userId, userId), eq(ticketMessages.isStaff, false)));

    // IP/User-Agent لاگ‌های شخصی پاک می‌شود؛ خودِ رویدادها (بدون هویت) برای بازرسی می‌مانند
    await db.update(auditLogs).set({ ip: null, userAgent: null }).where(and(eq(auditLogs.userId, userId), sql`${auditLogs.contractId} is null`));

    if (signatureFiles.length || evidenceFiles.length || kycFiles.length) await enqueueJob("files.purge", { signatures: [...signatureFiles, ...evidenceFiles], kyc: kycFiles });
    await logAudit({ action: "account.deleted", userId: null, detail: `حساب #${userId} حذف (ناشناس‌سازی) شد؛ ${open.length} قرارداد در جریان لغو شد؛ ${kycFiles.length} مدرک KYC و ${signatureFiles.length} تصویر امضا پاک شد` });
    return { ok: true, cancelled: open.length };
  });
}
