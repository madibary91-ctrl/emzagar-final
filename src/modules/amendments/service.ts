import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { afterCommit, db, withTransaction } from "@/db";
import { amendmentSigners, contractAmendments, contracts, contractSigners, users } from "@/db/schema";
import { lockContract } from "@/modules/contracts/lifecycle";
import { escapeHtml, sanitizeHtml } from "@/lib/html";
import { fa, faTime } from "@/lib/jalali";
import { sha256 } from "@/lib/password";
import { getOrigin } from "@/lib/request";
import { logAudit } from "@/modules/audit/service";
import { notifyTeam, notifyUser } from "@/modules/inbox/service";
import { sendMail } from "@/modules/mail";
import { getAllSettings } from "@/modules/settings/service";
import { amendmentFingerprint } from "@/modules/signing/fingerprint";
import { verifyOtp } from "@/modules/signing/otp";
import { readSignatureFile } from "@/modules/signing/storage";
import type { PdfInput } from "@/modules/pdf/render";

export type Amendment = typeof contractAmendments.$inferSelect;
export const AMEND_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const tokenHash = (t: string) => sha256(`amend:${t}`);

export const AMENDMENT_STATUS_LABELS: Record<string, string> = { sent: "در انتظار تأیید", signed: "تأیید و اجرایی", rejected: "رد شده", cancelled: "لغو شده" };

/** متن ساده (پاراگراف‌ها با خط خالی) → HTML امن */
export function textToHtml(text: string): string {
  const paras = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return sanitizeHtml(paras.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`).join(""));
}

async function amendUrl(token: string, workspaceId: number): Promise<string> {
  const cfg = await getAllSettings(workspaceId);
  let base = (cfg.app_url || "").replace(/\/+$/, "");
  if (!base) base = (await getOrigin().catch(() => "")).replace(/\/+$/, "");
  return `${base}/amend/${token}`;
}

/** نسخه‌ی فعلی قرارداد: ۱ + تعداد الحاقیه‌های تأییدشده */
export async function contractVersion(contractId: number): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(contractAmendments).where(and(eq(contractAmendments.contractId, contractId), eq(contractAmendments.status, "signed")));
  return 1 + (r?.n ?? 0);
}

export type CreateAmendmentResult = { ok: true; id: number; seq: number; links: { signerId: number; userId: number; url: string }[] } | { ok: false; error: string };

export async function createAmendment(p: { contractId: number; workspaceId: number; title: string; bodyText: string; actorId: number | null }): Promise<CreateAmendmentResult> {
  const title = p.title.trim();
  if (title.length < 3 || title.length > 150) return { ok: false, error: "عنوان الحاقیه باید بین ۳ تا ۱۵۰ نویسه باشد" };
  const text = p.bodyText.trim();
  if (text.length < 10) return { ok: false, error: "متن الحاقیه بسیار کوتاه است" };
  if (text.length > 20000) return { ok: false, error: "متن الحاقیه بیش از حد طولانی است" };
  /**
   * A-4: «ثبت الحاقیه + ثبت همه‌ی امضاکنندگان + لاگ» یک واحد اتمی است و زیر قفل ردیف قرارداد.
   * پیش‌تر الحاقیه درج می‌شد و امضاکنندگان در حلقه‌ای جدا؛ شکست در میانه، الحاقیه‌ی «یتیم و بدون امضاکننده» می‌گذاشت که
   * (چون وضعیتش sent بود) الحاقیه‌های بعدی را هم مسدود می‌کرد و هرگز نهایی نمی‌شد. بررسی «الحاقیه‌ی باز» و محاسبه‌ی seq هم
   * پیش‌تر دو درخواست هم‌زمان را رد نمی‌کرد (دومی با خطای کلید یکتا و پیام مبهم می‌ماند)؛ اکنون سریال و با پیام روشن است.
   * ایمیل/اعلان (کار شبکه‌ای) فقط پس از commit ارسال می‌شود.
   */
  type Planned = { amendment: Amendment; contract: typeof contracts.$inferSelect; links: { signerId: number; userId: number; url: string }[]; userRows: (typeof users.$inferSelect)[] };
  let planned: Planned | { error: string };
  try {
    planned = await withTransaction(async (): Promise<Planned | { error: string }> => {
      const c = await lockContract(p.contractId, p.workspaceId);
      if (!c) return { error: "قرارداد یافت نشد" };
      if (c.status !== "signed" || !c.docHash) return { error: "الحاقیه فقط برای قرارداد کاملاً امضاشده ثبت می‌شود" };
      const [open] = await db.select({ id: contractAmendments.id }).from(contractAmendments).where(and(eq(contractAmendments.contractId, c.id), eq(contractAmendments.status, "sent")));
      if (open) return { error: "یک الحاقیه‌ی در انتظار تأیید وجود دارد؛ ابتدا آن را نهایی یا لغو کنید" };
      const signers = await db.select().from(contractSigners).where(eq(contractSigners.contractId, c.id)).orderBy(asc(contractSigners.position));
      if (signers.length === 0) return { error: "قرارداد امضاکننده‌ای ندارد" };

      const [{ m }] = await db.select({ m: sql<number>`coalesce(max(${contractAmendments.seq}), 0)::int` }).from(contractAmendments).where(eq(contractAmendments.contractId, c.id));
      const [amendment] = await db.insert(contractAmendments).values({ contractId: c.id, seq: m + 1, title, bodyHtml: textToHtml(text), createdBy: p.actorId }).returning();

      const userRows = await db.select().from(users).where(inArray(users.id, signers.map((s) => s.userId)));
      const links: { signerId: number; userId: number; url: string }[] = [];
      const tokens = signers.map((s) => ({ s, token: crypto.randomBytes(32).toString("base64url") }));
      await db.insert(amendmentSigners).values(tokens.map(({ s, token }) => ({ amendmentId: amendment.id, signerId: s.id, userId: s.userId, tokenHash: tokenHash(token) })));
      for (const { s, token } of tokens) links.push({ signerId: s.id, userId: s.userId, url: await amendUrl(token, c.workspaceId) });
      await logAudit({ action: "amendment.created", contractId: c.id, userId: p.actorId, detail: `الحاقیه ${amendment.seq}: ${title}` });
      return { amendment, contract: c, links, userRows };
    });
  } catch (e) {
    console.error("[amend:create]", e);
    return { ok: false, error: "ثبت الحاقیه ممکن نشد؛ دوباره تلاش کنید" };
  }
  if ("error" in planned) return { ok: false, error: planned.error };

  const { amendment, contract: c, links, userRows } = planned;
  // کار شبکه‌ای پس از commit؛ شکست هر ایمیل هیچ‌چیز را برنمی‌گرداند
  for (const l of links) {
    const u = userRows.find((x) => x.id === l.userId);
    await notifyUser(l.userId, { kind: "action", title: `الحاقیه‌ی ${c.number} منتظر تأیید شماست`, body: `«${title}» — با کد پیامکی تأیید کنید.`, href: `/contracts/${c.id}#amendments` }).catch((e) => console.error("[amend:notify]", e));
    if (u && !u.email.endsWith(".invalid")) {
      await sendMail({
        to: u.email,
        subject: `الحاقیه‌ی قرارداد ${c.number}`,
        html: `<div dir="rtl" style="font-family:Tahoma,sans-serif;line-height:2"><p>${escapeHtml(u.name)} عزیز، الحاقیه‌ی «${escapeHtml(title)}» به قرارداد ${escapeHtml(c.number)} ثبت شد و تأیید شما لازم است.</p><p><a href="${l.url}">${l.url}</a></p><p style="font-size:12px;color:#555">تأیید با کد پیامکی روی همان شماره‌ی ثبت‌شده انجام می‌شود.</p></div>`,
        contractId: c.id,
      }).catch((e) => console.error("[amend:mail]", e));
    }
  }
  return { ok: true, id: amendment.id, seq: amendment.seq, links };
}

export type AmendmentView = Amendment & { signers: { id: number; signerId: number; userId: number; userName: string; label: string; status: string; decidedAt: Date | null }[] };

export async function listAmendments(contractId: number): Promise<AmendmentView[]> {
  const list = await db.select().from(contractAmendments).where(eq(contractAmendments.contractId, contractId)).orderBy(desc(contractAmendments.seq));
  const out: AmendmentView[] = [];
  for (const a of list) {
    const rows = await db
      .select({ id: amendmentSigners.id, signerId: amendmentSigners.signerId, userId: amendmentSigners.userId, userName: users.name, label: contractSigners.label, status: amendmentSigners.status, decidedAt: amendmentSigners.decidedAt })
      .from(amendmentSigners)
      .innerJoin(users, eq(users.id, amendmentSigners.userId))
      .innerJoin(contractSigners, eq(contractSigners.id, amendmentSigners.signerId))
      .where(eq(amendmentSigners.amendmentId, a.id))
      .orderBy(asc(contractSigners.position));
    out.push({ ...a, signers: rows });
  }
  return out;
}

export interface AmendCtx {
  amSigner: typeof amendmentSigners.$inferSelect;
  amendment: Amendment;
  contract: typeof contracts.$inferSelect;
  signer: typeof contractSigners.$inferSelect;
  user: typeof users.$inferSelect;
}

async function loadCtx(where: ReturnType<typeof eq>): Promise<AmendCtx | null> {
  const [row] = await db
    .select({ amSigner: amendmentSigners, amendment: contractAmendments, contract: contracts, signer: contractSigners, user: users })
    .from(amendmentSigners)
    .innerJoin(contractAmendments, eq(contractAmendments.id, amendmentSigners.amendmentId))
    .innerJoin(contracts, eq(contracts.id, contractAmendments.contractId))
    .innerJoin(contractSigners, eq(contractSigners.id, amendmentSigners.signerId))
    .innerJoin(users, eq(users.id, amendmentSigners.userId))
    .where(where);
  return row ?? null;
}

export const resolveAmendToken = async (token: string) => (AMEND_TOKEN_RE.test(token || "") ? loadCtx(eq(amendmentSigners.tokenHash, tokenHash(token))) : null);
export const resolveAmendForUser = (amendmentId: number, userId: number) => loadCtx(and(eq(amendmentSigners.amendmentId, amendmentId), eq(amendmentSigners.userId, userId)) as ReturnType<typeof eq>);

export type DecideResult = { ok: boolean; error?: string; completed?: boolean };

/**
 * ثبت تأیید/رد یک امضاکننده روی الحاقیه؛ هویت با OTP پیامکی همان امضاکننده راستی‌آزمایی می‌شود.
 *
 * A-5: «مصرف OTP»، «ثبت تصمیم»، «نهایی‌شدن الحاقیه» و لاگ‌ها یک تراکنش‌اند زیر قفل ردیف الحاقیه.
 *  - اگر پس از درستیِ OTP هر مرحله‌ای شکست بخورد، کل تراکنش (از جمله «مصرف‌شدن» کد) برمی‌گردد؛ کاربر می‌تواند با همان کد دوباره تلاش کند.
 *  - دو درخواست هم‌زمان یک امضاکننده: دومی پشت قفل می‌ماند و پس از آزادشدن، «قبلاً ثبت شده» می‌گیرد، بی‌آنکه کدِ تازه‌اش بسوزد.
 *  - تصمیم روی الحاقیه‌ی لغو/رد/نهایی‌شده‌ی هم‌زمان ثبت نمی‌شود (پیش‌تر ردیف تصمیمِ «پذیرفته» روی الحاقیه‌ی لغوشده می‌ماند).
 *  - تلاش‌های ناموفق OTP (شمارنده‌ی سقف) همچنان ماندگار می‌شوند چون خطا throw نمی‌شود.
 * اعلان‌ها فقط پس از commit.
 */
export async function decideAmendment(ctx: AmendCtx, accept: boolean, code: string, meta: { ip: string; userAgent: string }): Promise<DecideResult> {
  const { amSigner, contract, signer, user } = ctx;
  return withTransaction(async (): Promise<DecideResult> => {
    // قفل ردیف الحاقیه: همه‌ی تصمیم‌ها، لغو و نهایی‌سازی همین الحاقیه را سریال می‌کند
    const [amendment] = await db.select().from(contractAmendments).where(eq(contractAmendments.id, ctx.amendment.id)).for("update");
    const [curSigner] = await db.select().from(amendmentSigners).where(eq(amendmentSigners.id, amSigner.id));
    if (!amendment || amendment.status !== "sent" || !curSigner || curSigner.status !== "pending") return { ok: false, error: "این الحاقیه دیگر در انتظار تصمیم شما نیست" };

    const otp = await verifyOtp(signer.id, String(code || ""));
    if (!otp.ok) {
      await logAudit({ action: "otp.failed", contractId: contract.id, userId: user.id, detail: `${otp.error} (الحاقیه ${amendment.seq})` });
      return { ok: false, error: otp.error };
    }
    const now = new Date();
    const claimed = await db
      .update(amendmentSigners)
      .set({ status: accept ? "accepted" : "rejected", decidedAt: now, ip: meta.ip, userAgent: meta.userAgent })
      .where(and(eq(amendmentSigners.id, amSigner.id), eq(amendmentSigners.status, "pending")))
      .returning({ id: amendmentSigners.id });
    if (claimed.length === 0) throw new Error("تصمیم شما قبلاً ثبت شده است"); // زیر قفل رخ نمی‌دهد؛ اگر رخ داد، مصرف OTP هم برمی‌گردد
    await logAudit({ action: accept ? "amendment.accepted" : "amendment.rejected", contractId: contract.id, userId: user.id, detail: `الحاقیه ${amendment.seq} — ${signer.label}` });

    if (!accept) {
      const upd = await db.update(contractAmendments).set({ status: "rejected" }).where(and(eq(contractAmendments.id, amendment.id), eq(contractAmendments.status, "sent"))).returning({ id: contractAmendments.id });
      if (upd.length) {
        await afterCommit(async () => {
          await notifyTeam(contract.workspaceId, { kind: "warning", title: `الحاقیه ${amendment.seq} رد شد`, body: `${signer.label} (${user.name}) الحاقیه‌ی «${amendment.title}» را رد کرد.`, href: `/contracts/${contract.id}#amendments` }, [contract.createdBy]);
        });
      }
      return { ok: true, completed: false };
    }

    const rows = await db.select().from(amendmentSigners).where(eq(amendmentSigners.amendmentId, amendment.id));
    if (rows.some((r) => r.status !== "accepted")) return { ok: true, completed: false };
    const hash = amendmentFingerprint(contract.docHash ?? "", amendment.seq, amendment.bodyHtml, rows.map((r) => ({ userId: r.userId, decidedAt: r.decidedAt, ip: r.ip })).sort((a, b) => a.userId - b.userId));
    const fin = await db
      .update(contractAmendments)
      .set({ status: "signed", signedAt: now, docHash: hash })
      .where(and(eq(contractAmendments.id, amendment.id), eq(contractAmendments.status, "sent")))
      .returning({ id: contractAmendments.id });
    if (fin.length === 0) return { ok: true, completed: false };
    const version = await contractVersion(contract.id);
    await logAudit({ action: "amendment.completed", contractId: contract.id, userId: user.id, detail: `الحاقیه ${amendment.seq} اجرایی شد — نسخه ${version} — اثر انگشت: ${hash.slice(0, 16)}…` });
    await afterCommit(async () => {
      for (const r of rows) await notifyUser(r.userId, { kind: "success", title: `الحاقیه‌ی ${contract.number} اجرایی شد`, body: `«${amendment.title}» توسط همه‌ی طرفین تأیید شد.`, href: `/contracts/${contract.id}#amendments` });
      await notifyTeam(contract.workspaceId, { kind: "success", title: `الحاقیه ${amendment.seq} اجرایی شد`, body: `قرارداد ${contract.number} اکنون نسخه‌ی ${version} است.`, href: `/contracts/${contract.id}#amendments` }, [contract.createdBy]);
    });
    return { ok: true, completed: true };
  });
}

export async function cancelAmendment(contractId: number, workspaceId: number, amendmentId: number, actorId: number): Promise<boolean> {
  // لغو و لاگ اتمی‌اند و زیر همان قفل تصمیم‌ها: تصمیمِ در حال ثبت یا کامل می‌شود یا لغو؛ نه هر دو
  return withTransaction(async () => {
    const [c] = await db.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.workspaceId, workspaceId)));
    if (!c) return false;
    await db.select({ id: contractAmendments.id }).from(contractAmendments).where(and(eq(contractAmendments.id, amendmentId), eq(contractAmendments.contractId, contractId))).for("update");
    const rows = await db
      .update(contractAmendments)
      .set({ status: "cancelled" })
      .where(and(eq(contractAmendments.id, amendmentId), eq(contractAmendments.contractId, contractId), eq(contractAmendments.status, "sent")))
      .returning({ seq: contractAmendments.seq });
    if (rows.length === 0) return false;
    await logAudit({ action: "amendment.cancelled", contractId, userId: actorId, detail: `الحاقیه ${rows[0].seq}` });
    return true;
  });
}

/** ورودی PDF الحاقیه (قالب همان PDF رسمی قرارداد؛ امضای هر نفر همان امضای ثبت‌شده در قرارداد اصلی + تأیید OTP) */
export async function buildAmendmentPdfInput(contractId: number, seq: number): Promise<{ input: PdfInput; amendment: Amendment } | null> {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  const [a] = await db.select().from(contractAmendments).where(and(eq(contractAmendments.contractId, contractId), eq(contractAmendments.seq, seq)));
  if (!c || !a || a.status !== "signed" || !a.docHash) return null;
  const cfg = await getAllSettings(c.workspaceId);
  const rows = await db
    .select({ am: amendmentSigners, s: contractSigners, name: users.name })
    .from(amendmentSigners)
    .innerJoin(contractSigners, eq(contractSigners.id, amendmentSigners.signerId))
    .innerJoin(users, eq(users.id, amendmentSigners.userId))
    .where(eq(amendmentSigners.amendmentId, a.id))
    .orderBy(asc(contractSigners.position));
  const [customer] = await db.select({ name: users.name }).from(users).where(eq(users.id, c.customerId));
  const base = (cfg.app_url || "").replace(/\/+$/, "");
  return {
    amendment: a,
    input: {
      siteName: cfg.site_name,
      number: `${c.number}/A${a.seq}`,
      title: `الحاقیه‌ی ${a.seq} — ${a.title}`,
      customerName: customer?.name ?? "—",
      issuedAtText: fa(a.createdAt),
      completedAtText: fa(a.signedAt),
      bodyHtml: `${sanitizeHtml(`<p>الحاقیه به قرارداد شماره ${escapeHtml(c.number)} («${escapeHtml(c.title)}»)، با اثر انگشت قرارداد اصلی: ${c.docHash?.slice(0, 16) ?? ""}…</p>`)}${a.bodyHtml}`,
      docHash: a.docHash,
      verifyUrl: base ? `${base}/verify/${c.docHash}` : "",
      signers: await Promise.all(
        rows.map(async ({ am, s, name }) => ({
          label: s.label,
          name,
          mobileMasked: s.mobile && s.mobile.length >= 8 ? `${s.mobile.slice(0, 4)}***${s.mobile.slice(-4)}` : "",
          signedAtText: faTime(am.decidedAt),
          ip: am.ip ?? "",
          methodText: "تأیید با OTP پیامکی",
          otpVerified: true,
          signature: s.signatureFile ? await readSignatureFile(s.signatureFile) : null,
        })),
      ),
    },
  };
}
