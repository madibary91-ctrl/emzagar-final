import { type IdentityReq } from "@/modules/identity/rules";
import { type LegalInfo, type SignerRole, type SigningMode, type WitnessTiming, normalizeLegal, parseSigningMode, planStages, stageOf } from "@/modules/signing/stages";
import { type SignerSpec, normalizeTags, resolveExpiry, varsFor } from "./core";
import { acquireIssueQuota } from "@/modules/billing/service";
import { and, eq, inArray } from "drizzle-orm";
import { applyIdentityAtIssue, carryOverRequirement } from "@/modules/identity/service";
import { assertApprovalsClear, invalidateApprovals } from "../approvals";
import { assertUsersInWorkspace } from "@/modules/tenancy/service";
import { contractSigners, contracts, users } from "@/db/schema";
import { currentSigners, getSigners } from "./signers";
import { db, withTransaction } from "@/db";
import { emitEvent } from "@/modules/webhooks/service";
import { ensureShortLink, shortUrl } from "@/modules/links/service";
import { fa } from "@/lib/jalali";
import { getAllSettings } from "@/modules/settings/service";
import { logAudit } from "@/modules/audit/service";
import { notifySigner, revokeSigningLinks } from "@/modules/signing/links";
import { notifyUser } from "@/modules/inbox/service";
import { qualifyReferralForWorkspace } from "@/modules/referral/service";
import { renderVariables } from "@/modules/variables";
import { sanitizeHtml } from "@/lib/html";
import { snapshotRevision } from "../revisions";
import { closeLinkedOrder, lockContract } from "../lifecycle";
import { cloneSourceToContract } from "@/modules/docs/service/sources";
import { removeFiles } from "@/modules/docs/service/core";

export interface IssueParams {
  /** فضای کاری مالک قرارداد (الزامی؛ همه‌ی کاربران باید عضو آن باشند) */
  workspaceId: number;
  title: string;
  bodyHtml: string;
  templateId?: number | null;
  customerId: number;
  /** امضاکنندگان قبل از مشتری، به ترتیب */
  extraSigners?: (SignerSpec & { label: string; userId: number })[];
  /** مشخصات امضاکننده‌ی «مشتری» (حقوقی/مهر/پاراف/مرحله) — اختیاری */
  customerSpec?: SignerSpec;
  /**
   * شاهدها: فقط گواهی می‌دهند (نه طرف قرارداد). به‌طور پیش‌فرض پس از همه‌ی طرف‌ها و هم‌زمان با یکدیگر امضا می‌کنند.
   * هیچ‌گاه «مشتری» حساب نمی‌شوند و امضای آن‌ها شرط نهایی‌شدن قرارداد است.
   */
  witnesses?: { label?: string; userId: number; initialsRequired?: boolean }[];
  witnessTiming?: WitnessTiming;
  /** شیوه‌ی امضا: ترتیبی (پیش‌فرض) | هم‌زمان | مرحله‌ای */
  signingMode?: SigningMode;
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
  /** فاز ۲: صدور بدون مصرف سهمیه‌ی طرح (ارسال سریع؛ محدودیت با سقف نرخ خودش اعمال می‌شود) */
  skipQuota?: boolean;
  /** فاز ۲: اعلان به امضاکننده‌ی اول فرستاده نشود (فراخواننده خودش امضای اول را ثبت یا اعلان را ارسال می‌کند) */
  skipAnnounce?: boolean;
  /**
   * احراز هویت اختیاری امضاکننده‌ی مشتری (آخرین امضاکننده): سطح امنیت + کد ملی مورد انتظار (اختیاری).
   * پیش‌فرض (نبود این گزینه یا req="none") دقیقاً همان مسیر سریع قبلی است.
   */
  identity?: { req: IdentityReq; expectedNc?: string | null };
  /** فاز ۲: کار اضافه داخل «همان تراکنش» صدور (مثلاً اتصال فایل مبدأ)؛ خطا = برگشت کل صدور */
  onCreated?: (contractId: number) => Promise<void>;
}
/** پس از انتشار: لینک کوتاه + ایمیل به اولین امضاکننده + رویداد وب‌هوک */
export async function announceContract(contractId: number) {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  if (!c) return;
  const cfg = await getAllSettings(c.workspaceId);
  const signers = await getSigners(contractId);
  // امضای ترتیبی: فقط نفر اول؛ امضای هم‌زمان: همه‌ی اعضای مرحله‌ی اول (هر کدام لینک اختصاصی خودش)
  const firstStage = currentSigners(signers);
  const link = await ensureShortLink(contractId, c.createdBy);
  const url = await shortUrl(link.code);
  for (const f of firstStage) {
    // لینک امضای اختصاصی (بدون نیاز به ثبت‌نام) به‌جای لینک ورود به حساب
    await notifySigner(contractId, f.id, "issue").catch(() => null);
    await notifyUser(f.userId, { kind: "action", title: `قرارداد جدید برای امضا: ${c.number}`, body: `«${c.title}» منتظر ${f.role === "witness" ? "شهادت" : "امضای"} شماست.`, href: `/contracts/${contractId}` });
  }
  emitEvent({
    event: "contract.issued",
    contractId,
    text: `📄 قرارداد جدید صادر شد\n${c.number} — ${c.title}\nنوبت امضا: ${firstStage.length ? firstStage.map((f) => `${f.label} (${f.userName})`).join(" + ") : "—"}${cfg.app_url ? `\n${url}` : ""}`,
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
  await assertUsersInWorkspace(p.workspaceId, [p.customerId, ...(p.extraSigners ?? []).map((x) => x.userId), ...(p.witnesses ?? []).map((w) => w.userId)]);

  const cfg = await getAllSettings(p.workspaceId);
  const expiresAt = p.draft ? null : await resolveExpiry(p.expiryDays, p.workspaceId);

  const createdId = await withTransaction(async () => {
    // سقف ماهانه‌ی طرح (یا اعتبار قرارداد کیف پول) و احراز هویت قراردادهای پرمبلغ؛ پیش‌نویس‌ها سهمیه مصرف نمی‌کنند.
    // مصرف اعتبار داخل همین تراکنش است: با شکست مراحل بعد، خودبه‌خود برگردانده می‌شود.
    if (!p.draft && p.skipQuota) {
      if (process.env.LICENSE_REQUIRED === "1" && !(await (await import("@/modules/license/client")).isLicensed())) throw new Error("لایسنس محصول فعال نیست");
    } else if (!p.draft) await acquireIssueQuota(p.workspaceId, 1, { contractValue: p.contractValue });

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

    // طرف‌های قرارداد (به ترتیب) + مشتری در پایانِ طرف‌ها + شاهدها (نقش دیگر، پس از طرف‌ها)
    const parties: (SignerSpec & { label: string; userId: number })[] = [
      ...(p.extraSigners ?? []),
      { ...(p.customerSpec ?? {}), label: p.customerLabel ?? "مشتری", userId: customer.id },
    ];
    const witnessList = p.witnesses ?? [];
    const mode = parseSigningMode(p.signingMode);
    const planned = planStages({ mode, partyStages: parties.map((x) => x.stage), partyCount: parties.length, witnessCount: witnessList.length, witnessTiming: p.witnessTiming });
    const steps = [
      ...parties.map((x, i) => ({ ...x, role: "signer" as SignerRole, stage: planned.parties[i] })),
      ...witnessList.map((w, i) => ({ label: w.label?.trim() || (witnessList.length > 1 ? `شاهد ${i + 1}` : "شاهد"), userId: w.userId, sealRequired: false, initialsRequired: !!w.initialsRequired, role: "witness" as SignerRole, stage: planned.witnesses[i] })),
    ];
    // یک نفر نمی‌تواند هم‌زمان در دو نقش «طرف» و «شاهد» همین سند باشد (شهادت بی‌طرف نیست)
    const partyIds = new Set(parties.map((x) => x.userId));
    // یک نفر دوبار «طرف» همین سند نمی‌شود: دو لینک/دو OTP برای یک نفر، ترتیب امضا را بی‌معنا و گردش کار را گیج می‌کند
    // (معمولاً اشتباه انتخاب است: مشتری هم‌زمان در فهرست «امضاکنندگان قبل از مشتری» هم آمده یا یک مهمان دوبار وارد شده)
    if (partyIds.size !== parties.length) throw new Error("یک نفر را نمی‌توان دوبار به‌عنوان طرف قرارداد گذاشت؛ امضاکننده‌ی تکراری (یا مشتریِ انتخاب‌شده در فهرست امضاکنندگان) را حذف کنید");
    if (witnessList.some((w) => partyIds.has(w.userId))) throw new Error("شاهد نمی‌تواند خودش یکی از طرف‌های قرارداد باشد");
    if (new Set(witnessList.map((w) => w.userId)).size !== witnessList.length) throw new Error("یک نفر را نمی‌توان دوبار شاهد کرد");
    const legalById = steps.map((x) => {
      const r = normalizeLegal(x as Partial<LegalInfo>);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    });
    await db
      .update(contracts)
      .set({ signingMode: mode === "sequential" && new Set(steps.map((x) => x.stage)).size < steps.length ? "staged" : mode })
      .where(eq(contracts.id, created.id));
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
        role: s.role,
        stage: s.stage,
        signerType: s.role === "witness" ? "natural" : legalById[i].signerType,
        companyName: s.role === "witness" ? "" : legalById[i].companyName,
        companyNationalId: s.role === "witness" ? "" : legalById[i].companyNationalId,
        signatoryTitle: s.role === "witness" ? "" : legalById[i].signatoryTitle,
        // مهر شرکتی فقط برای امضاکننده‌ی حقوقی معنا دارد؛ پاراف برای هر نقشی ممکن است
        sealRequired: s.role === "signer" && legalById[i].signerType === "legal" && !!s.sealRequired,
        initialsRequired: !!s.initialsRequired,
      })),
    );

    // احراز هویت اختیاری: فقط وقتی صادرکننده خواسته باشد؛ خطا (مثلاً کد ملی نامعتبر) کل صدور را برمی‌گرداند
    if (p.identity && p.identity.req !== "none") {
      const [customerSigner] = await db.select({ id: contractSigners.id }).from(contractSigners).where(and(eq(contractSigners.contractId, created.id), eq(contractSigners.position, parties.length)));
      if (customerSigner) await applyIdentityAtIssue({ contractId: created.id, workspaceId: p.workspaceId, signerId: customerSigner.id, req: p.identity.req, expectedNc: p.identity.expectedNc, actorId: p.createdBy ?? null });
    }

    if (p.onCreated) await p.onCreated(created.id);

    await logAudit({
      action: p.draft ? "contract.draft_saved" : "contract.issued",
      workspaceId: p.workspaceId,
      contractId: created.id,
      userId: p.createdBy ?? customer.id,
      detail: `${number} — ${mode === "parallel" ? "هم‌زمان: " : ""}${steps.map((s, i) => `${i + 1}. ${s.label}${s.role === "witness" ? " (شاهد)" : ""}`).join(mode === "parallel" ? " + " : " ← ")}`,
    });
    return created.id;
  });

  // ───── پس از commit: اعلان به امضاکننده‌ی اول و پاداش دعوت (شبکه‌ای؛ جدا از اتمی بودن صدور) ─────
  if (!p.draft && !p.skipAnnounce) {
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
/**
 * ذخیره‌ی تغییرات پیش‌نویس (نسخه‌ی نهایی هرگز قابل ویرایش نیست).
 *
 * A-6: پیش‌تر «بررسی وضعیت draft» و «UPDATE» دو گام جدا و بدون شرط بودند؛ اگر هم‌زمان قرارداد منتشر می‌شد،
 * ذخیره‌ی دیرهنگام متن «قرارداد منتشرشده» را بازنویسی می‌کرد (و یک نسخه‌ی draft کهنه در تاریخچه می‌نشست).
 * اکنون ردیف قفل می‌شود (`FOR UPDATE`؛ همان قفل انتشار)، وضعیت زیر قفل سنجیده می‌شود، UPDATE شرط `status='draft'` دارد،
 * و نسخه‌ی تاریخچه/ابطال تأییدها/لاگ همه در «همان تراکنش»‌اند.
 */
export async function saveDraft(id: number, adminId: number, input: { title: string; bodyHtml: string }, workspaceId: number) {
  const body = sanitizeHtml(input.bodyHtml);
  await withTransaction(async () => {
    const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId))).for("update");
    if (!c || c.status !== "draft") throw new Error("فقط پیش‌نویس قابل ویرایش است");
    const upd = await db.update(contracts).set({ title: input.title, bodyHtml: body }).where(and(eq(contracts.id, id), eq(contracts.status, "draft"))).returning({ id: contracts.id });
    if (upd.length === 0) throw new Error("فقط پیش‌نویس قابل ویرایش است");
    // نسخه‌ی جدید فقط وقتی ثبت می‌شود که چیزی تغییر کرده باشد؛ هر تغییر، تأییدهای داخلی قبلی را بی‌اعتبار می‌کند
    const created = await snapshotRevision(id, { title: input.title, bodyHtml: body, kind: "draft", userId: adminId });
    if (created) await invalidateApprovals(id, adminId, "ویرایش متن پیش‌نویس");
    await logAudit({ action: "contract.draft_saved", contractId: id, userId: adminId, detail: `${c.number}${created ? ` — نسخه‌ی ${created}` : ""}` });
  });
}
/**
 * انتشار پیش‌نویس: متغیرها جایگزین، نسخه قفل و برای امضاکننده‌ی اول ارسال می‌شود.
 *
 * HX-02: «سنجش سقف ماهانه/کسر اعتبار» و «تبدیل پیش‌نویس به منتشرشده» اکنون در «یک تراکنش» و پشت قفل سریال‌کننده‌ی فضای کاری‌اند
 * (`acquireIssueQuota` داخل تراکنش قفل می‌گیرد). پیش‌تر کسر/سنجش خارج از تراکنش بود: انتشار هم‌زمان N پیش‌نویس همگی «۹ از ۱۰» می‌دیدند
 * و همه منتشر می‌شدند. ردیف پیش‌نویس هم `FOR UPDATE` قفل می‌شود تا انتشار هم‌زمانِ «یک» پیش‌نویس اعتبار را دوبار کسر نکند.
 * هر شکست در میانه ⇒ rollback کامل، اعتبار کیف پول خودکار برمی‌گردد (دیگر release دستی لازم نیست).
 * اعلان/وب‌هوک (کار شبکه‌ای) پس از commit انجام می‌شود و شکست آن قرارداد منتشرشده را باطل یا اعتبارش را برگردان نمی‌کند.
 */
export async function publishDraft(id: number, adminId: number, input: { title: string; bodyHtml: string; expiryDays?: number | null }, workspaceId: number) {
  const [draft] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId)));
  if (!draft || draft.status !== "draft") throw new Error("این قرارداد پیش‌نویس نیست");
  const cleanIncoming = sanitizeHtml(input.bodyHtml);
  // اگر همزمان با انتشار متن تغییر کرده، ابتدا ثبت نسخه و ابطال تأییدها (عمداً «بیرون» از تراکنش انتشار: حتی اگر انتشار
  // به‌خاطر سد تأیید یا سقف رد شود، ویرایش و ابطال تأییدهای قبلی باید ماندگار بماند)؛ سپس سد تأیید داخلی داخل تراکنش
  if (cleanIncoming !== draft.bodyHtml || input.title !== draft.title) {
    // A-6: این گام هم زیر قفل و با سنجش دوباره‌ی وضعیت است؛ وگرنه اگر هم‌زمان منتشر شده بود، متن کهنه به‌عنوان «پیش‌نویس» در تاریخچه می‌نشست
    await withTransaction(async () => {
      const [cur] = await db.select({ status: contracts.status }).from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId))).for("update");
      if (!cur || cur.status !== "draft") throw new Error("این قرارداد پیش‌نویس نیست");
      const created = await snapshotRevision(id, { title: input.title, bodyHtml: cleanIncoming, kind: "draft", userId: adminId });
      if (created) await invalidateApprovals(id, adminId, "ویرایش هم‌زمان با انتشار");
    });
  }
  await withTransaction(async () => {
    const [c] = await db
      .select()
      .from(contracts)
      .where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId)))
      .for("update");
    if (!c || c.status !== "draft") throw new Error("این قرارداد پیش‌نویس نیست");
    await acquireIssueQuota(workspaceId, 1, { contractValue: c.contractValue });
    const [customer] = await db.select().from(users).where(eq(users.id, c.customerId));
    if (!customer) throw new Error("مشتری یافت نشد");
    const cfg = await getAllSettings(workspaceId);
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
  });
  // ───── پس از commit: اعلان به امضاکننده‌ی اول و پاداش دعوت (شبکه‌ای) ─────
  try {
    await announceContract(id);
  } catch (e) {
    console.error("[contract:announce]", e);
    await logAudit({ action: "contract.announce_failed", workspaceId, contractId: id, detail: (e instanceof Error ? e.message : "خطای ناشناخته").slice(0, 300), actor: "system" }).catch(() => undefined);
  }
  await qualifyReferralForWorkspace(workspaceId).catch(() => undefined);
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
  // در صدور، مشتری آخرین «طرف» است (شاهدها پس از او می‌آیند)؛ بقیه‌ی طرف‌ها «امضاکننده‌ی اضافه» هستند
  const parties = signers.filter((s) => s.role !== "witness");
  const customerStep = parties[parties.length - 1];
  const specOf = (s: (typeof signers)[number]): SignerSpec => ({
    signerType: s.signerType as LegalInfo["signerType"],
    companyName: s.companyName,
    companyNationalId: s.companyNationalId,
    signatoryTitle: s.signatoryTitle,
    sealRequired: s.sealRequired,
    initialsRequired: s.initialsRequired,
    stage: stageOf(s),
  });
  const extraSigners = parties.slice(0, -1).map((s) => ({ label: s.label, userId: s.userId, ...specOf(s) }));
  const witnesses = signers.filter((s) => s.role === "witness").map((s) => ({ label: s.label, userId: s.userId, initialsRequired: s.initialsRequired }));
  const lastPartyStage = parties.length ? Math.max(...parties.map(stageOf)) : 0;
  const witnessTiming: WitnessTiming = witnesses.length && signers.some((s) => s.role === "witness" && stageOf(s) <= lastPartyStage) ? "together" : "after";
  const body = c.bodyHtml.split(c.number).join("[CONTRACT_NUMBER]").split(fa(c.issuedAt)).join("[DATE]");
  // سطح امنیت هویت مشتری هم کپی می‌شود (نه شواهد)
  const carry = customerStep ? await carryOverRequirement(customerStep.id).catch(() => null) : null;
  // فایل مبدأ (امضا روی PDF/Word) و جای فیلدها هم کپی می‌شود؛ بدون آن، نسخه‌ی کپی یک «قرارداد بدون سند» خراب می‌شد
  const clonedFiles: string[] = [];
  let newId: number;
  try {
    newId = await issueContract({
    identity: carry ? { req: carry.req, expectedNc: carry.expectedNc } : undefined,
    workspaceId,
    title: c.title,
    bodyHtml: body,
    templateId: c.templateId,
    customerId: c.customerId,
    customerLabel: customerStep?.label,
    customerSpec: customerStep ? specOf(customerStep) : undefined,
    extraSigners,
    witnesses,
    witnessTiming,
    signingMode: parseSigningMode(c.signingMode),
    source: "admin",
    createdBy: actorId,
    draft: true,
    // ارزش، برچسب‌ها و مدت اعتبار هم حفظ می‌شود (پیش‌تر نسخه‌ی تمدید/کپی «بدون ارزش و برچسب» ساخته می‌شد و گزارش‌های مالی را کم‌شمار می‌کرد)
    contractValue: c.contractValue,
    tags: c.tags,
    termDays: c.termDays,
    renewalNoticeDays: c.renewalNoticeDays,
    onCreated: async (cid) => {
      await cloneSourceToContract(id, cid, clonedFiles);
    },
    });
  } catch (e) {
    await removeFiles(...clonedFiles);
    throw e;
  }
  await logAudit({ action: "contract.duplicated", contractId: newId, userId: actorId, workspaceId, detail: `کپی از ${c.number}` });
  return newId;
}
/**
 * لغو توسط مدیر (فقط قراردادهای در جریان).
 *
 * A-1/A-2: لغو، تغییر وضعیت، ابطال لینک‌ها، سفارش مرتبط و لاگ ممیزی «یک واحد اتمی»‌اند و زیر قفل ردیف قرارداد.
 * امضای هم‌زمانِ آخرین نفر (applySignature) همین قفل را می‌گیرد؛ پس یا لغو اول می‌نشیند و امضا «دیگر قابل امضا نیست» می‌گیرد،
 * یا امضا اول نهایی می‌شود و لغو خطای «فقط قراردادهای در انتظار امضا قابل لغو هستند» می‌دهد — حالت «هم لغوشده هم امضاشده» ناممکن است.
 */
export async function cancelContract(id: number, adminId: number, reason: string, workspaceId: number) {
  const closed = await withTransaction(async () => {
    const c = await lockContract(id, workspaceId);
    if (!c || c.status !== "sent") throw new Error("فقط قراردادهای در انتظار امضا قابل لغو هستند");
    const updated = await db
      .update(contracts)
      .set({ status: "cancelled" })
      .where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId), eq(contracts.status, "sent")))
      .returning({ number: contracts.number });
    if (updated.length === 0) throw new Error("فقط قراردادهای در انتظار امضا قابل لغو هستند");
    await revokeSigningLinks({ contractId: id });
    await closeLinkedOrder(c.orderId);
    await logAudit({ action: "contract.cancelled", contractId: id, userId: adminId, detail: `${updated[0].number}${reason ? ` — ${reason.slice(0, 200)}` : ""}` });
    return updated[0];
  });
  // رویداد (وب‌هوک / همگام‌سازی ووکامرس) فقط پس از commit
  emitEvent({ event: "contract.cancelled", contractId: id, text: `🚫 قرارداد ${closed.number} لغو شد.${reason ? `\nدلیل: ${reason.slice(0, 200)}` : ""}`, data: { number: closed.number } });
}
