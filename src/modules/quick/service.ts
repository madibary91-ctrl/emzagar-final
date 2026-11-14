import crypto from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { contracts, quickSends, signingLinks, users, workspaces, contractSigners } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { sha256, unusablePasswordHash } from "@/lib/password";
import { sanitizeHtml } from "@/lib/html";
import { applySignature } from "@/modules/signing/finalize";
import { getOrCreateSigningLink, signingUrl, TOKEN_RE } from "@/modules/signing/links";
import { parseSignatureDataUrl } from "@/modules/signing/types";
import { cancelContract, getSigners, issueContract, removeContract } from "@/modules/contracts/service";
import { attachSourceToContract, getUsableDraft, listDocFields, prepareSigningFields, sourceStubHtml, DocError } from "@/modules/docs/service";
import { fieldKey, sanitizePlacements } from "@/modules/docs/placement";
import { ensureGuestSigner, GuestError, GUEST_EMAIL_DOMAIN, validateGuestInput } from "@/modules/guests/service";
import { consumeProof } from "@/modules/mobile/otp";
import { getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";
import { createWorkspace } from "@/modules/tenancy/service";
import { sealIsolatedWorkspace } from "@/modules/tenancy/isolation";
import { logAudit } from "@/modules/audit/service";
import { notifySigner } from "@/modules/signing/links";

/**
 * ── ارسال سریع (Quick Send) ───────────────────────────────────────────────
 * هیچ‌کس حساب نمی‌سازد: فرستنده فقط «نام + موبایل» می‌دهد، با یک کد پیامکی هویتش را تأیید و همان‌جا امضا می‌کند؛
 * سند برای طرف مقابل (لینک اختصاصی + OTP) ارسال می‌شود و فرستنده یک «لینک پیگیری» می‌گیرد.
 * هر دو طرف «امضاکننده‌ی مهمان»اند و کل خط‌لوله‌ی موجود (زنجیره‌ی امضا، OTP، ممیزی، PDF، استعلام) بدون تغییر کار می‌کند.
 * قراردادها در یک فضای کاری سیستمی «ایزوله» (workspaces.kind = quick) نگه‌داری می‌شوند که مالک آن یک کاربر غیرقابل‌ورود است؛
 * این فضا از هیچ پنل، فهرست، آمار نام‌دار، پروفایل عمومی و ایمیل/اعلان مدیریتی دیده نمی‌شود (ر.ک. tenancy/isolation.ts)
 * و سهمیه‌ی طرح‌ها هم مصرف نمی‌شود. سوءاستفاده با سقف نرخ، تأیید موبایل و
 * سقف روزانه‌ی هر شماره/IP مهار می‌شود.
 */
export class QuickError extends Error {}

export const QUICK_MAX_PER_MOBILE_DAY = 10;
export const QUICK_MAX_PER_IP_DAY = 25;
const MANAGE_RE = TOKEN_RE;

export async function isQuickEnabled(): Promise<boolean> {
  if (process.env.QUICK_SEND_ENABLED === "0") return false;
  return (await getGlobalSetting("quick_send_enabled")) !== "0";
}

/** فضای کاری سیستمی ارسال سریع (در اولین استفاده ساخته می‌شود) */
export async function getQuickContext(): Promise<{ workspaceId: number; ownerId: number }> {
  const read = async () => {
    const id = Number(await getGlobalSetting("quick_workspace_id"));
    if (!id) return null;
    const [ws] = await db.select({ id: workspaces.id, ownerId: workspaces.ownerId }).from(workspaces).where(eq(workspaces.id, id));
    return ws ? { workspaceId: ws.id, ownerId: ws.ownerId } : null;
  };
  const cached = await read();
  if (cached) {
    // خودترمیمی: دیتابیس‌هایی که پیش از «ایزولاسیون صریح» ساخته شده‌اند، یک‌بار مُهر می‌شوند
    await sealIsolatedWorkspace(cached.workspaceId, cached.ownerId);
    return cached;
  }
  return withTransaction(async () => {
    await db.execute(sql`select pg_advisory_xact_lock(7731001)`);
    const again = await read();
    if (again) return again;
    const email = `quick-system@${GUEST_EMAIL_DOMAIN}`;
    let [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (!owner) {
      [owner] = await db
        .insert(users)
        .values({ name: "سامانه‌ی ارسال سریع", email, mobile: "", passwordHash: unusablePasswordHash(), role: "user", isGuest: true, emailVerifiedAt: new Date() })
        .returning({ id: users.id });
    }
    const wsId = await createWorkspace(owner.id, "ارسال سریع", "quick");
    await saveGlobalSetting("quick_workspace_id", String(wsId));
    return { workspaceId: wsId, ownerId: owner.id };
  });
}

export interface QuickInput {
  title: string;
  /** حالت متنی */
  bodyHtml?: string;
  /** حالت فایل */
  draftCode?: string;
  placements?: unknown;
  sender: { name: string; mobile: string };
  recipient: { name: string; mobile: string };
  proof: string;
  signature: string;
  method: "draw" | "upload";
  agree: boolean;
  fields?: Record<string, string>;
  ip: string;
}

export const SENDER_LABEL = "طرف اول (ارسال‌کننده)";
export const RECIPIENT_LABEL = "طرف دوم";

const textLen = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().length;

export async function createQuickSend(input: QuickInput): Promise<{ contractId: number; manageToken: string; recipientUrl: string | null; number: string }> {
  if (!(await isQuickEnabled())) throw new QuickError("ارسال سریع در این سامانه غیرفعال است");
  let sender: { name: string; mobile: string };
  let recipient: { name: string; mobile: string };
  try {
    sender = validateGuestInput(input.sender);
    recipient = validateGuestInput(input.recipient);
  } catch (e) {
    throw new QuickError(e instanceof GuestError ? e.message : "اطلاعات طرفین معتبر نیست");
  }
  if (sender.mobile === recipient.mobile) throw new QuickError("شماره‌ی طرف مقابل باید با شماره‌ی خودتان فرق داشته باشد");
  if (!input.agree) throw new QuickError("تأیید مطالعه‌ی سند الزامی است");
  const title = String(input.title || "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  if (title.length < 3) throw new QuickError("عنوان سند را وارد کنید");
  const sig = parseSignatureDataUrl(input.signature);
  if ("error" in sig) throw new QuickError(sig.error);

  const since = new Date(Date.now() - 86400_000);
  const [byMobile] = await db.select({ n: sql<number>`count(*)::int` }).from(quickSends).where(and(eq(quickSends.senderMobile, sender.mobile), gt(quickSends.createdAt, since)));
  const [byIp] = await db.select({ n: sql<number>`count(*)::int` }).from(quickSends).where(and(eq(quickSends.ip, input.ip.slice(0, 64)), gt(quickSends.createdAt, since)));
  if ((byMobile?.n ?? 0) >= QUICK_MAX_PER_MOBILE_DAY || (byIp?.n ?? 0) >= QUICK_MAX_PER_IP_DAY) throw new QuickError("سقف ارسال روزانه تکمیل شده است؛ فردا دوباره تلاش کنید یا برای حجم بالا ثبت‌نام کنید");

  // محتوا: متن یا فایل (پیش از مصرف گواهی تأیید، تا خطای فرم کد را نسوزاند)
  const ctx = await getQuickContext();
  let bodyHtml = "";
  let draft: Awaited<ReturnType<typeof getUsableDraft>> | null = null;
  let placements: ReturnType<typeof sanitizePlacements> | null = null;
  if (input.draftCode) {
    try {
      draft = await getUsableDraft(input.draftCode, null);
    } catch (e) {
      throw new QuickError(e instanceof DocError ? e.message : "فایل معتبر نیست");
    }
    placements = sanitizePlacements(input.placements, draft.pageCount, 2, { requireSignatureFor: [1, 2] });
    if (!placements.ok) throw new QuickError(placements.error);
    bodyHtml = sourceStubHtml(draft.originalName, draft.originalSha256);
  } else {
    bodyHtml = sanitizeHtml(String(input.bodyHtml || ""));
    if (textLen(bodyHtml) < 10) throw new QuickError("متن سند خالی یا بسیار کوتاه است");
    if (bodyHtml.length > 200_000) throw new QuickError("متن سند بیش از حد طولانی است");
  }

  if (!(await consumeProof(input.proof, { purpose: "quick", scope: "sender", mobile: sender.mobile }))) {
    throw new QuickError("تأیید شماره‌ی موبایل منقضی یا نامعتبر است؛ دوباره کد بگیرید");
  }

  const [g1, g2] = [await ensureGuestSigner(ctx.workspaceId, sender), await ensureGuestSigner(ctx.workspaceId, recipient)];
  const manageToken = crypto.randomBytes(32).toString("base64url");
  const draftRef = draft;
  const items = placements && placements.ok ? placements.items : [];

  const contractId = await issueContract({
    workspaceId: ctx.workspaceId,
    title,
    bodyHtml,
    customerId: g2.userId,
    customerLabel: RECIPIENT_LABEL,
    extraSigners: [{ label: SENDER_LABEL, userId: g1.userId }],
    createdBy: null,
    expiryDays: 30,
    skipQuota: true,
    skipAnnounce: true,
    onCreated: async (id) => {
      if (draftRef) await attachSourceToContract(id, draftRef, items);
      await db.insert(quickSends).values({
        contractId: id,
        tokenHash: sha256(manageToken),
        senderUserId: g1.userId,
        senderName: sender.name,
        senderMobile: sender.mobile,
        recipientName: recipient.name,
        recipientMobile: recipient.mobile,
        ip: input.ip.slice(0, 64),
      });
    },
  });

  // امضای فرستنده (هویتش همین الان با OTP ثابت شده)؛ هر شکستی = پاک‌سازی کامل تا قرارداد نیمه‌کاره نماند
  const rollback = async () => {
    await removeContract(contractId, ctx.ownerId, ctx.workspaceId).catch((e) => console.error("[quick:rollback]", e));
  };
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  const signers = await getSigners(contractId);
  const mine = signers[0];
  // کلاینت فیلدها را با «شماره‌ی ترتیبی جانمایی» می‌فرستد (df_1…)؛ اینجا به شناسه‌ی واقعی ردیف‌ها نگاشت می‌شود
  let fieldInput: Record<string, string> | undefined = input.fields;
  if (draftRef && input.fields) {
    const df = (await listDocFields(contractId)).sort((a, b) => a.id - b.id);
    fieldInput = {};
    df.forEach((f, i) => {
      const v = input.fields?.[`df_${i + 1}`];
      if (v !== undefined && fieldInput) fieldInput[fieldKey(f.id)] = v;
    });
  }
  const prepared = await prepareSigningFields(contract, signers, { position: 1, userName: sender.name }, fieldInput);
  if (!prepared.ok) {
    await rollback();
    throw new QuickError(prepared.error);
  }
  await logAudit({ action: "otp.verified", contractId, userId: g1.userId, detail: "مالکیت موبایل فرستنده با OTP پیامکی (ارسال سریع) تأیید شد" });
  // لینک اختصاصی خود فرستنده (برای دریافت نسخه‌ی نهایی با OTP پس از تکمیل سند)
  await getOrCreateSigningLink(mine.id);
  try {
    const res = await applySignature({
      contract,
      signer: { id: mine.id, label: mine.label },
      user: { id: g1.userId, name: sender.name, mobile: sender.mobile },
      buffer: sig.buffer,
      method: input.method === "upload" ? "upload" : "draw",
      via: "link",
      fieldValues: prepared.rows,
    });
    if (!res.ok) throw new QuickError(res.error || "ثبت امضا انجام نشد");
  } catch (e) {
    await rollback();
    throw e instanceof QuickError ? e : new QuickError("ثبت امضا انجام نشد؛ دوباره تلاش کنید");
  }
  await logAudit({ action: "quick.sent", contractId, userId: g1.userId, workspaceId: ctx.workspaceId, detail: `${sender.name} ← ${recipient.name}` });

  const rs = signers[1];
  const link = await getOrCreateSigningLink(rs.id);
  return { contractId, manageToken, recipientUrl: link ? await signingUrl(link.token, ctx.workspaceId) : null, number: contract.number };
}

/* ───────── پیگیری با لینک مدیریتی ───────── */

export async function getQuickStatus(token: string) {
  if (!MANAGE_RE.test(token)) return null;
  const [q] = await db.select().from(quickSends).where(eq(quickSends.tokenHash, sha256(token)));
  if (!q) return null;
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, q.contractId));
  if (!contract) return null;
  const signers = await getSigners(contract.id);
  const ctx = await getQuickContext();
  const pending = signers.find((s) => s.status === "pending");
  let recipientUrl: string | null = null;
  if (contract.status === "sent" && pending && pending.userId !== q.senderUserId) {
    const link = await getOrCreateSigningLink(pending.id);
    if (link) recipientUrl = await signingUrl(link.token, ctx.workspaceId);
  }
  // لینک خود فرستنده برای دریافت نسخه‌ی نهایی (با OTP)
  let senderUrl: string | null = null;
  const mine = signers.find((s) => s.userId === q.senderUserId);
  if (mine) {
    const [l] = await db.select().from(signingLinks).where(eq(signingLinks.signerId, mine.id)).orderBy(sql`${signingLinks.createdAt} desc`).limit(1);
    if (l?.tokenEnc) {
      const t = decryptSecret(l.tokenEnc);
      if (TOKEN_RE.test(t)) senderUrl = await signingUrl(t, ctx.workspaceId);
    }
  }
  return { quick: q, contract, signers, recipientUrl, senderUrl, workspaceId: ctx.workspaceId, ownerId: ctx.ownerId };
}

export async function remindQuickRecipient(token: string): Promise<{ ok: boolean; error?: string }> {
  const st = await getQuickStatus(token);
  if (!st) return { ok: false, error: "لینک پیگیری نامعتبر است" };
  if (st.contract.status !== "sent") return { ok: false, error: "این سند دیگر منتظر امضا نیست" };
  const pending = st.signers.find((s) => s.status === "pending");
  if (!pending || pending.userId === st.quick.senderUserId) return { ok: false, error: "نوبت امضای طرف مقابل نیست" };
  await notifySigner(st.contract.id, pending.id, "reminder");
  await logAudit({ action: "quick.reminded", contractId: st.contract.id, userId: st.quick.senderUserId, detail: "یادآوری توسط فرستنده" });
  return { ok: true };
}

export async function cancelQuick(token: string): Promise<{ ok: boolean; error?: string }> {
  const st = await getQuickStatus(token);
  if (!st) return { ok: false, error: "لینک پیگیری نامعتبر است" };
  try {
    await cancelContract(st.contract.id, st.ownerId, "لغو توسط ارسال‌کننده", st.workspaceId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "لغو انجام نشد" };
  }
}

export { contractSigners };
