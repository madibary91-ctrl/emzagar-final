import crypto from "node:crypto";
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  amendmentSigners, auditLogs, contractAmendments, contractApprovals, contractComments, contractFieldValues, contractRevisions, contractSigners, contracts, demoRecords, notifications, orders,
  otpCodes, passwordResets, products, shortLinks, signingLinks, templates, ticketMessages, tickets, userNotifications, userSessions, users, workspaceMembers,
} from "@/db/schema";
import { unusablePasswordHash } from "@/lib/password";
import { fa, faNum } from "@/lib/jalali";
import { sanitizeHtml } from "@/lib/html";
import { renderVariables } from "@/modules/variables";
import { docFingerprint } from "@/modules/signing/fingerprint";
import { deleteAllAttachments } from "@/modules/attachments/service";
import { deleteContractDocument } from "@/modules/pdf/service";
import { deleteSignatureFile } from "@/modules/signing/storage";
import { getAllSettings } from "@/modules/settings/service";
import { logAudit } from "@/modules/audit/service";
import { DEMO_BODIES, DEMO_CONTRACTS, DEMO_EMAIL_DOMAIN, DEMO_PEOPLE, DEMO_PRODUCTS, DEMO_TICKETS } from "./data";

/**
 * سازنده و پاک‌کننده‌ی «داده‌ی نمونه».
 *
 * اصل طراحی: هر رکوردی که ساخته می‌شود در جدول demo_records ثبت می‌شود و پاک‌سازی فقط همان رکوردها را حذف می‌کند؛
 * بنابراین هرگز داده‌ی واقعی خریدار لمس نمی‌شود، حتی اگر داده‌ی واقعی کنار داده‌ی نمونه ساخته شده باشد.
 * ساخت داده در یک تراکنش انجام می‌شود (یا کامل ساخته می‌شود یا هیچ).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface DemoStatus {
  seeded: boolean;
  counts: { users: number; contracts: number; tickets: number; logs: number; products: number; notifications: number };
}

export interface DemoSummary extends DemoStatus {
  kept: number;
}

export async function demoStatus(workspaceId: number): Promise<DemoStatus> {
  const rows = await db
    .select({ entity: demoRecords.entity, n: sql<number>`count(*)::int` })
    .from(demoRecords)
    .where(eq(demoRecords.workspaceId, workspaceId))
    .groupBy(demoRecords.entity);
  const c = (e: string) => rows.find((r) => r.entity === e)?.n ?? 0;
  const counts = { users: c("user"), contracts: c("contract"), tickets: c("ticket"), logs: c("audit"), products: c("product"), notifications: c("notification") + c("usernotice") };
  return { seeded: rows.length > 0, counts };
}

async function register(tx: Tx, workspaceId: number, entity: string, ids: number[]) {
  if (ids.length === 0) return;
  await tx.insert(demoRecords).values(ids.map((entityId) => ({ workspaceId, entity, entityId }))).onConflictDoNothing();
}

const ipFor = (i: number) => `203.0.113.${10 + i}`; // بازه‌ی مستند TEST-NET-3 (هرگز IP واقعی نیست)
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const UA_MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

export async function seedDemoData(p: { workspaceId: number; actorId: number }): Promise<DemoStatus> {
  const { workspaceId, actorId } = p;
  if ((await demoStatus(workspaceId)).seeded) throw new Error("داده‌ی نمونه قبلاً ساخته شده است؛ ابتدا آن را پاک کنید.");
  const cfg = await getAllSettings(workspaceId);
  const [actor] = await db.select().from(users).where(eq(users.id, actorId));
  if (!actor) throw new Error("کاربر یافت نشد");
  const now = Date.now();
  const tpls = await db.select().from(templates).where(eq(templates.workspaceId, workspaceId)).orderBy(templates.id);

  await db.transaction(async (tx) => {
    // قفل مشورتی: دو کلیک همزمان نمی‌تواند داده را دوبار بسازد
    await tx.execute(sql`select pg_advisory_xact_lock(7701, ${workspaceId})`);
    if ((await demoStatus(workspaceId)).seeded) throw new Error("داده‌ی نمونه قبلاً ساخته شده است؛ ابتدا آن را پاک کنید.");
    /* ── کاربران (مشتریان) نمونه: رمز تصادفی ناشناخته؛ هیچ‌کس نمی‌تواند با آن‌ها وارد شود ── */
    const tag = `${workspaceId}-${crypto.randomBytes(2).toString("hex")}`;
    const people = await tx
      .insert(users)
      .values(
        DEMO_PEOPLE.map((d, i) => ({
          name: d.name,
          email: `demo-${tag}-${i + 1}@${DEMO_EMAIL_DOMAIN}`,
          mobile: d.mobile,
          passwordHash: unusablePasswordHash(),
          role: "user",
          emailVerifiedAt: new Date(now - 60 * DAY),
          createdAt: new Date(now - (58 - i * 4) * DAY),
        })),
      )
      .returning();
    await register(tx, workspaceId, "user", people.map((u) => u.id));
    await tx.insert(workspaceMembers).values(people.map((u) => ({ workspaceId, userId: u.id, role: "client" }))).onConflictDoNothing();

    /* ── محصولات ── */
    const prods = await tx
      .insert(products)
      .values(DEMO_PRODUCTS.map((d, i) => ({ workspaceId, ...d, templateId: tpls[i % Math.max(1, tpls.length)]?.id ?? null })))
      .returning({ id: products.id });
    await register(tx, workspaceId, "product", prods.map((x) => x.id));

    /* ── قراردادها ── */
    const contractIds: number[] = [];
    const auditIds: number[] = [];
    const notifIds: number[] = [];
    const audit = async (v: { contractId: number | null; userId: number | null; action: string; detail: string; at: number; ip?: string; ua?: string }) => {
      const [r] = await tx
        .insert(auditLogs)
        .values({ workspaceId, contractId: v.contractId, userId: v.userId, action: v.action, detail: v.detail, ip: v.ip ?? "203.0.113.1", userAgent: v.ua ?? UA, createdAt: new Date(v.at) })
        .returning({ id: auditLogs.id });
      auditIds.push(r.id);
    };
    const notif = async (v: { channel: "email" | "sms"; recipient: string; subject: string; body: string; contractId: number; at: number }) => {
      const [r] = await tx
        .insert(notifications)
        .values({ workspaceId, channel: v.channel, recipient: v.recipient, subject: v.subject, body: v.body, status: "sent", contractId: v.contractId, createdAt: new Date(v.at) })
        .returning({ id: notifications.id });
      notifIds.push(r.id);
    };

    for (const [idx, plan] of DEMO_CONTRACTS.entries()) {
      const person = people[plan.person];
      const issuedAt = now - plan.daysAgo * DAY - (idx % 5) * HOUR;
      const isDraft = plan.status === "draft";
      const signedAtMs = plan.status === "signed" ? issuedAt + (plan.signAfterHours ?? 4) * HOUR : null;
      const termEndsAt = plan.termEndsInDays != null ? new Date(now + plan.termEndsInDays * DAY) : null;

      const [created] = await tx
        .insert(contracts)
        .values({
          workspaceId,
          number: `TMP-${crypto.randomBytes(5).toString("hex")}`,
          title: plan.title,
          templateId: null,
          customerId: person.id,
          bodyHtml: "",
          status: plan.status,
          source: "admin",
          createdBy: actorId,
          issuedAt: new Date(issuedAt),
          publishedAt: isDraft ? null : new Date(issuedAt),
          signedAt: signedAtMs ? new Date(signedAtMs) : null,
          expiresAt: isDraft ? null : plan.status === "expired" ? new Date(issuedAt + 14 * DAY) : new Date(issuedAt + 30 * DAY),
          termDays: plan.termDays ?? null,
          termEndsAt,
          reminderCount: plan.reminders ?? 0,
          lastReminderAt: plan.reminders ? new Date(now - 1 * DAY) : null,
        })
        .returning();
      contractIds.push(created.id);
      const number = `AMZ-${new Date(issuedAt).getFullYear()}-${String(created.id).padStart(5, "0")}`;
      const body = renderVariables(sanitizeHtml(DEMO_BODIES[plan.body]), {
        USER_NAME: person.name,
        USER_EMAIL: person.email,
        USER_MOBILE: person.mobile,
        CONTRACT_NUMBER: number,
        DATE: fa(new Date(issuedAt)),
        SITE_NAME: cfg.site_name,
        PRODUCT_NAME: plan.product ?? plan.title,
        AMOUNT: faNum(plan.amount),
      });

      // امضاکنندگان: نماینده‌ی کسب‌وکار (اختیاری) ← مشتری
      const steps = [...(plan.twoSigners ? [{ label: "نماینده‌ی کسب‌وکار", user: actor }] : []), { label: "مشتری", user: person }];
      const signerRows = await tx
        .insert(contractSigners)
        .values(
          steps.map((s, i) => {
            const isLast = i === steps.length - 1;
            // چه کسی تا الان امضا کرده؟ signed: همه؛ sent دو امضایی: فقط نماینده؛ rejected: مشتری رد کرده
            const signed = plan.status === "signed" || (plan.status === "sent" && plan.twoSigners && !isLast) || (plan.status === "rejected" && !isLast);
            const rejected = plan.status === "rejected" && isLast;
            const at = signedAtMs ? (isLast ? signedAtMs : issuedAt + (signedAtMs - issuedAt) / 3) : issuedAt + (rejected ? 20 : 2) * HOUR;
            return {
              contractId: created.id,
              position: i + 1,
              label: s.label,
              userId: s.user.id,
              mobile: s.user.mobile,
              status: signed ? "signed" : rejected ? "rejected" : "pending",
              signedAt: signed || rejected ? new Date(Math.round(at)) : null,
              ip: signed || rejected ? ipFor(idx + i) : null,
              userAgent: signed || rejected ? (i % 2 ? UA_MOBILE : UA) : null,
              signatureMethod: signed ? "draw" : null,
              otpVerifiedAt: signed ? new Date(Math.round(at)) : null,
            };
          }),
        )
        .returning();

      await tx.update(contracts).set({ number, bodyHtml: body }).where(eq(contracts.id, created.id));
      if (plan.status === "signed") {
        const hash = docFingerprint(body, signerRows.map((s) => ({ userId: s.userId, signedAt: s.signedAt, ip: s.ip })));
        await tx.update(contracts).set({ docHash: hash }).where(eq(contracts.id, created.id));
      }

      // رویدادهای واقع‌گرایانه برای لاگ و شناسنامه‌ی دیجیتال
      await audit({ contractId: created.id, userId: actorId, action: isDraft ? "contract.draft_saved" : "contract.issued", detail: `${number} — ${steps.map((s, i) => `${i + 1}. ${s.label}`).join(" ← ")}`, at: issuedAt });
      if (!isDraft) {
        await notif({ channel: "email", recipient: person.email, subject: `قرارداد «${plan.title}» برای امضا`, body: `سلام ${person.name}، قرارداد شماره ${number} برای امضای شما آماده است.`, contractId: created.id, at: issuedAt + 60_000 });
        await notif({ channel: "sms", recipient: person.mobile, subject: "", body: `${cfg.site_name}: لینک امضای قرارداد ${number} برای شما ارسال شد.`, contractId: created.id, at: issuedAt + 90_000 });
      }
      if (plan.viewed || plan.status === "signed" || plan.status === "rejected") {
        await audit({ contractId: created.id, userId: person.id, action: "contract.viewed", detail: number, at: issuedAt + 1.2 * HOUR, ip: ipFor(idx), ua: idx % 2 ? UA_MOBILE : UA });
      }
      if (plan.reminders) await audit({ contractId: created.id, userId: null, action: "contract.reminder", detail: `یادآوری ${plan.reminders} برای ${person.name}`, at: now - 1 * DAY, ip: "system", ua: "system" });
      if (plan.status === "signed" && signedAtMs) {
        await audit({ contractId: created.id, userId: person.id, action: "otp.sent", detail: person.mobile, at: signedAtMs - 4 * 60_000, ip: ipFor(idx) });
        await audit({ contractId: created.id, userId: person.id, action: "otp.verified", detail: person.mobile, at: signedAtMs - 2 * 60_000, ip: ipFor(idx) });
        await audit({ contractId: created.id, userId: person.id, action: "contract.signed", detail: `${number} — ${person.name}`, at: signedAtMs, ip: ipFor(idx), ua: idx % 2 ? UA_MOBILE : UA });
        await audit({ contractId: created.id, userId: person.id, action: "contract.completed", detail: number, at: signedAtMs + 1000, ip: ipFor(idx) });
      }
      if (plan.status === "rejected") await audit({ contractId: created.id, userId: person.id, action: "contract.rejected", detail: plan.rejectReason ?? "", at: issuedAt + 20 * HOUR, ip: ipFor(idx) });
      if (plan.status === "expired") await audit({ contractId: created.id, userId: null, action: "contract.expired", detail: number, at: issuedAt + 14 * DAY, ip: "system", ua: "system" });
      if (plan.status === "cancelled") await audit({ contractId: created.id, userId: actorId, action: "contract.cancelled", detail: "لغو توسط مدیر", at: issuedAt + 2 * DAY });
    }
    await register(tx, workspaceId, "contract", contractIds);

    // چند رویداد عمومی (ورود/تنظیمات) تا صفحه‌ی لاگ‌ها زنده دیده شود
    for (const [i, a] of ([["auth.login", "ورود موفق"], ["settings.saved", "به‌روزرسانی تنظیمات"], ["template.saved", "ذخیره‌ی قالب"], ["auth.login", "ورود موفق"]] as const).entries()) {
      await audit({ contractId: null, userId: actorId, action: a[0], detail: a[1], at: now - (i * 6 + 2) * DAY, ip: "203.0.113.5" });
    }
    await register(tx, workspaceId, "audit", auditIds);
    await register(tx, workspaceId, "notification", notifIds);

    /* ── تیکت‌های پشتیبانی ── */
    const ticketIds: number[] = [];
    for (const t of DEMO_TICKETS) {
      const person = people[t.person];
      const created = now - t.daysAgo * DAY;
      const last = t.replies.at(-1);
      const lastAt = last ? created + last.hoursLater * HOUR : created;
      const [row] = await tx
        .insert(tickets)
        .values({
          number: `TK-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
          userId: person.id,
          workspaceId,
          subject: t.subject,
          category: t.category,
          priority: t.priority,
          status: t.status,
          lastReplyBy: last ? (last.staff ? "staff" : "customer") : "customer",
          rating: t.rating ?? null,
          createdAt: new Date(created),
          updatedAt: new Date(lastAt),
          closedAt: t.status === "closed" ? new Date(lastAt) : null,
        })
        .returning({ id: tickets.id });
      ticketIds.push(row.id);
      await tx.insert(ticketMessages).values([
        { ticketId: row.id, userId: person.id, isStaff: false, body: t.body, createdAt: new Date(created) },
        ...t.replies.map((r) => ({ ticketId: row.id, userId: r.staff ? actorId : person.id, isStaff: r.staff, internal: !!r.internal, body: r.body, createdAt: new Date(created + r.hoursLater * HOUR) })),
      ]);
    }
    await register(tx, workspaceId, "ticket", ticketIds);

    /* ── اعلان‌های زنگوله‌ی مدیر ── */
    const notices = await tx
      .insert(userNotifications)
      .values([
        { userId: actorId, kind: "success", title: "قرارداد «طراحی وب‌سایت کلینیک مهر» امضا شد", body: "همه‌ی امضاکنندگان قرارداد را امضا کردند.", href: `/contracts/${contractIds[6]}`, createdAt: new Date(now - 4 * DAY) },
        { userId: actorId, kind: "action", title: "۳ قرارداد منتظر امضای مشتری است", body: "برای تسریع، یادآوری ارسال کنید.", href: "/admin", createdAt: new Date(now - 1 * DAY) },
        { userId: actorId, kind: "warning", title: "قرارداد اجاره‌ی دفتر کار تا ۲۱ روز دیگر تمام می‌شود", body: "زمان مناسبی برای تمدید است.", href: "/admin/renewals", createdAt: new Date(now - 2 * HOUR) },
      ])
      .returning({ id: userNotifications.id });
    await register(tx, workspaceId, "usernotice", notices.map((n) => n.id));
  });

  await logAudit({ workspaceId, userId: actorId, action: "demo.seeded", detail: `${DEMO_CONTRACTS.length} قرارداد، ${DEMO_PEOPLE.length} مشتری، ${DEMO_TICKETS.length} تیکت` });
  return demoStatus(workspaceId);
}

/** پاک‌سازی کامل داده‌ی نمونه (فقط رکوردهای ثبت‌شده در demo_records) */
export async function clearDemoData(p: { workspaceId: number; actorId: number }): Promise<DemoSummary> {
  const { workspaceId, actorId } = p;
  const before = await demoStatus(workspaceId);
  const recs = await db.select().from(demoRecords).where(eq(demoRecords.workspaceId, workspaceId));
  const ids = (e: string) => recs.filter((r) => r.entity === e).map((r) => r.entityId);
  const contractIds = ids("contract");
  const ticketIds = ids("ticket");
  let userIds = ids("user");
  let kept = 0;

  // فایل‌های دیسک (امضا، PDF، پیوست) خارج از تراکنش پاک می‌شوند
  if (contractIds.length) {
    const signers = await db.select().from(contractSigners).where(inArray(contractSigners.contractId, contractIds));
    for (const s of signers) if (s.signatureFile) await deleteSignatureFile(s.signatureFile).catch(() => undefined);
    for (const id of contractIds) {
      await deleteContractDocument(id).catch(() => undefined);
      await deleteAllAttachments(id).catch(() => undefined);
    }
  }

  // کاربر نمونه‌ای که در یک قرارداد/سفارش «واقعی» استفاده شده حذف نمی‌شود (فقط از فهرست نمونه خارج می‌شود)
  if (userIds.length) {
    const guard = contractIds.length ? [notInArray(contracts.id, contractIds)] : [];
    const asCustomer = await db.select({ id: contracts.customerId }).from(contracts).where(and(inArray(contracts.customerId, userIds), ...guard));
    const asSigner = await db
      .select({ id: contractSigners.userId })
      .from(contractSigners)
      .where(and(inArray(contractSigners.userId, userIds), ...(contractIds.length ? [notInArray(contractSigners.contractId, contractIds)] : [])));
    const protectedIds = new Set([...asCustomer, ...asSigner].map((r) => r.id));
    kept = protectedIds.size;
    userIds = userIds.filter((id) => !protectedIds.has(id));
  }

  await db.transaction(async (tx) => {
    if (ticketIds.length) {
      await tx.delete(ticketMessages).where(inArray(ticketMessages.ticketId, ticketIds));
      await tx.delete(tickets).where(inArray(tickets.id, ticketIds));
    }
    if (contractIds.length) {
      const ams = await tx.select({ id: contractAmendments.id }).from(contractAmendments).where(inArray(contractAmendments.contractId, contractIds));
      if (ams.length) await tx.delete(amendmentSigners).where(inArray(amendmentSigners.amendmentId, ams.map((a) => a.id)));
      await tx.delete(contractAmendments).where(inArray(contractAmendments.contractId, contractIds));
      await tx.delete(contractFieldValues).where(inArray(contractFieldValues.contractId, contractIds));
      await tx.delete(contractRevisions).where(inArray(contractRevisions.contractId, contractIds));
      await tx.delete(contractComments).where(inArray(contractComments.contractId, contractIds));
      await tx.delete(contractApprovals).where(inArray(contractApprovals.contractId, contractIds));
      await tx.delete(otpCodes).where(inArray(otpCodes.contractId, contractIds));
      await tx.delete(signingLinks).where(inArray(signingLinks.contractId, contractIds));
      await tx.delete(shortLinks).where(inArray(shortLinks.contractId, contractIds));
      await tx.delete(notifications).where(inArray(notifications.contractId, contractIds));
      await tx.delete(auditLogs).where(inArray(auditLogs.contractId, contractIds));
      await tx.delete(contractSigners).where(inArray(contractSigners.contractId, contractIds));
      await tx.delete(contracts).where(inArray(contracts.id, contractIds));
    }
    const auditIds = ids("audit");
    if (auditIds.length) await tx.delete(auditLogs).where(inArray(auditLogs.id, auditIds));
    const notifIds = ids("notification");
    if (notifIds.length) await tx.delete(notifications).where(inArray(notifications.id, notifIds));
    const noticeIds = ids("usernotice");
    if (noticeIds.length) await tx.delete(userNotifications).where(inArray(userNotifications.id, noticeIds));
    const productIds = ids("product");
    if (productIds.length) {
      await tx.delete(orders).where(inArray(orders.productId, productIds));
      await tx.delete(products).where(inArray(products.id, productIds));
    }
    if (userIds.length) {
      await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, userIds)));
      // کاربری که عضو فضای کاری دیگری هم شده فقط از این فضا جدا می‌شود
      const stillMember = await tx.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(inArray(workspaceMembers.userId, userIds));
      const keep = new Set(stillMember.map((r) => r.id));
      const removable = userIds.filter((id) => !keep.has(id));
      if (removable.length) {
        await tx.delete(userNotifications).where(inArray(userNotifications.userId, removable));
        await tx.delete(userSessions).where(inArray(userSessions.userId, removable));
        await tx.delete(passwordResets).where(inArray(passwordResets.userId, removable));
        await tx.delete(users).where(and(inArray(users.id, removable), ne(users.role, "admin")));
      }
    }
    await tx.delete(demoRecords).where(eq(demoRecords.workspaceId, workspaceId));
  });

  await logAudit({ workspaceId, userId: actorId, action: "demo.cleared", detail: `${before.counts.contracts} قرارداد، ${before.counts.users} کاربر، ${before.counts.tickets} تیکت حذف شد${kept ? ` · ${kept} کاربر چون در قرارداد واقعی بودند حفظ شدند` : ""}` });
  return { ...(await demoStatus(workspaceId)), kept };
}
