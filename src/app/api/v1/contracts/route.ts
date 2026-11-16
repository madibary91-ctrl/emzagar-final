import { KycRequiredError } from "@/modules/kyc/service";
import { NextResponse } from "next/server";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { contracts, contractSigners, shortLinks, templates, users, wcContractLinks } from "@/db/schema";
import { getSetting } from "@/modules/settings/service";
import { STATUS_LABELS } from "@/modules/contracts/service";
import { authenticateApi, requestOrigin } from "@/modules/api/service";
import { releaseLock, tryAcquireLock } from "@/lib/db-lock";
import { issueContract } from "@/modules/contracts/service";
import { PlanLimitError } from "@/modules/billing/service";
import { logAudit } from "@/modules/audit/service";
import { ensureShortLink, shortUrl } from "@/modules/links/service";
import { getOrCreateSigningLink, signingUrl } from "@/modules/signing/links";
import { ensureClient, EMAIL_RE } from "@/modules/tenancy/service";
import { sendClientConsentEmail } from "@/modules/tenancy/client-consent";
import { rateLimit } from "@/lib/rate-limit";
import { IdentityConfigError } from "@/modules/identity/service";
import { isIdentityReq } from "@/modules/identity/rules";
import { connectionByKey, createLink, findLinkByKey, parseExternal, statusesForContracts } from "@/modules/sync/service";

export const dynamic = "force-dynamic";

const err = (status: number, error: string, detail?: string) => NextResponse.json({ ok: false, error, detail }, { status });

/** قفل درون‌فرایندی کلید ایدمپوتنت: دو درخواست هم‌زمان با یک کلید، دو قرارداد نمی‌سازند */
// M-05: قفل ایدمپوتنسی اکنون بین همه‌ی نمونه‌ها مشترک است (lib/db-lock.ts) نه Set درون‌فرایندی

async function firstSignUrl(contractId: number, workspaceId: number): Promise<string | null> {
  const [first] = await db.select({ id: contractSigners.id }).from(contractSigners).where(eq(contractSigners.contractId, contractId)).orderBy(asc(contractSigners.position)).limit(1);
  const sl = first ? await getOrCreateSigningLink(first.id) : null;
  return sl ? await signingUrl(sl.token, workspaceId) : null;
}

/**
 * صدور قرارداد از سیستم بیرونی.
 * بدنه: { templateId, customer: { name, email, mobile }, title?, draft?, expiryDays?, termDays?, renewalNoticeDays?,
 *         identity?: "none"|"shahkar"|"document"|"both" (احراز هویت اختیاری مشتری), nationalCode?: کد ملی مورد انتظار مشتری }
 */
export async function POST(req: Request) {
  const auth = await authenticateApi(req);
  if (!auth.ok) return err(auth.status, auth.error);

  // نویسه‌ی NUL (\u0000) را PostgreSQL نمی‌پذیرد و صدور را با ۵۰۰ می‌شکند؛ پیش از تجزیه حذف می‌شود
  const body = (await req.text().then((t) => JSON.parse(t.replace(/\\u0000/gi, "")) as unknown, () => null).catch(() => null)) as {
    templateId?: number;
    title?: string;
    draft?: boolean;
    expiryDays?: number;
    termDays?: number;
    renewalNoticeDays?: number;
    customer?: { name?: string; email?: string; mobile?: string };
    external?: unknown;
    identity?: unknown;
    nationalCode?: unknown;
  } | null;
  if (!body || typeof body !== "object") return err(400, "invalid_json");

  // ── صدور از ووکامرس: ایدمپوتنت با کلید خارجی + پیوند قرارداد↔سفارش برای همگام‌سازی وضعیت ──
  const external = body.external === undefined ? null : parseExternal(body.external);
  if (body.external !== undefined && !external) return err(422, "external_invalid");
  const wpConn = external ? await connectionByKey(auth.keyId) : null;
  if (external && !wpConn) return err(422, "external_requires_wp_connection");
  let locked = false;
  const lockKey = external && wpConn ? `${wpConn.id}:${external.key}` : "";
  if (external && wpConn) {
    const prior = await findLinkByKey(wpConn.id, external.key);
    if (prior) {
      const [pc] = await db.select({ id: contracts.id, status: contracts.status }).from(contracts).where(and(eq(contracts.id, prior.contractId), eq(contracts.workspaceId, auth.workspaceId)));
      if (pc) return NextResponse.json({ ok: true, reused: true, id: pc.id, status: pc.status, signUrl: pc.status === "sent" ? await firstSignUrl(pc.id, auth.workspaceId) : null, shortUrl: null }, { status: 200 });
    }
    if (!(await tryAcquireLock(`issue:${lockKey}`, 90_000))) return err(409, "issue_in_progress");
    locked = true;
  }
  try {
    return await issueFromBody(req, auth, body, external ? { conn: wpConn!, ref: external } : null);
  } finally {
    if (locked) await releaseLock(`issue:${lockKey}`);
  }
}

type IssueBody = {
  templateId?: number;
  title?: string;
  draft?: boolean;
  expiryDays?: number;
  termDays?: number;
  renewalNoticeDays?: number;
  customer?: { name?: string; email?: string; mobile?: string };
  identity?: unknown;
  nationalCode?: unknown;
};

async function issueFromBody(req: Request, auth: { keyId: number; workspaceId: number }, body: IssueBody, wcLink: { conn: NonNullable<Awaited<ReturnType<typeof connectionByKey>>>; ref: NonNullable<ReturnType<typeof parseExternal>> } | null) {

  const templateId = Number(body.templateId);
  if (!Number.isInteger(templateId)) return err(422, "templateId_required");
  const [tpl] = await db.select().from(templates).where(and(eq(templates.id, templateId), eq(templates.workspaceId, auth.workspaceId)));
  if (!tpl) return err(404, "template_not_found");

  const email = String(body.customer?.email || "").trim().toLowerCase();
  const name = String(body.customer?.name || "").trim().slice(0, 100);
  const mobile = String(body.customer?.mobile || "").trim();
  if (!EMAIL_RE.test(email)) return err(422, "customer_email_invalid");
  if (mobile && !/^09\d{9}$/.test(mobile)) return err(422, "customer_mobile_invalid", "format: 09xxxxxxxxx");

  // مشتری فقط در صورت وجود حساب یا ارسال نام و موبایل ساخته می‌شود و به همین فضای کاری وصل می‌شود
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!existing && (!name || !mobile)) return err(422, "customer_name_and_mobile_required_for_new_customer");
  const client = await ensureClient(auth.workspaceId, { name, email, mobile });
  if (client.consentRequired) {
    // SEC-06: حساب موجود فقط با رضایت صاحبش مشتری این فضای کاری می‌شود؛ هیچ داده‌ای از آن حساب برنمی‌گردد
    if (client.inviteToken) await sendClientConsentEmail({ workspaceId: auth.workspaceId, email, token: client.inviteToken, base: requestOrigin(req) }).catch(() => undefined);
    return err(409, "customer_consent_required", "an account with this email already exists; the account owner has been asked to approve before a contract can be issued");
  }
  const customerId = client.userId;
  const title = String(body.title || tpl.title).trim().slice(0, 200);
  const expiryDays = body.expiryDays === undefined ? undefined : Math.max(0, Math.min(3650, Number(body.expiryDays) || 0));
  let id: number;
  try {
    id = await issueContract({ identity: isIdentityReq(body.identity) && body.identity !== "none" ? { req: body.identity, expectedNc: typeof body.nationalCode === "string" || typeof body.nationalCode === "number" ? String(body.nationalCode) : null } : undefined, title, bodyHtml: tpl.body, templateId, customerId, workspaceId: auth.workspaceId, draft: !!body.draft, expiryDays, termDays: body.termDays === undefined ? undefined : Math.max(0, Math.min(36500, Number(body.termDays) || 0)), renewalNoticeDays: body.renewalNoticeDays === undefined ? undefined : Math.max(1, Math.min(365, Number(body.renewalNoticeDays) || 30)) });
  } catch (e) {
    if (e instanceof PlanLimitError) return err(402, "plan_limit_reached", e.message);
    if (e instanceof KycRequiredError) return err(403, "kyc_required", e.message);
    if (e instanceof IdentityConfigError) return err(422, "identity_invalid", e.message);
    console.error("[api:v1:issue]", e);
    return err(500, "issue_failed");
  }
  if (wcLink) await createLink(wcLink.conn, id, wcLink.ref);
  await logAudit({ action: "api.contract_issued", workspaceId: auth.workspaceId, contractId: id, detail: `کلید #${auth.keyId}${wcLink ? ` — ووکامرس: سفارش ${wcLink.ref.orderId}` : ""}`, actor: "api" });
  // برای پیش‌نویس لینکی ساخته نمی‌شود؛ لینک هنگام انتشار ایجاد می‌شود
  const link = body.draft ? null : await ensureShortLink(id);
  // لینک امضای اختصاصی نفر اول: مشتری بدون ثبت‌نام و فقط با OTP پیامکی امضا می‌کند
  const signUrl: string | null = body.draft ? null : await firstSignUrl(id, auth.workspaceId);
  return NextResponse.json(
    { ok: true, id, status: body.draft ? "draft" : "sent", signUrl, shortUrl: signUrl ?? (link ? await shortUrl(link.code, requestOrigin(req)) : null) },
    { status: 201 },
  );
}

/**
 * فهرست قراردادهای فضای کاری صاحب کلید (برای افزونه‌ی وردپرس و سیستم‌های بیرونی).
 * پارامترها: email (قراردادهای یک مشتری)، status، page، limit (حداکثر ۵۰)
 */
export async function GET(req: Request) {
  const auth = await authenticateApi(req);
  if (!auth.ok) return err(auth.status, auth.error);
  const sp = new URL(req.url).searchParams;
  const email = (sp.get("email") || "").trim().toLowerCase().slice(0, 200);
  const status = sp.get("status") || "";
  // جستجوی آزاد (عنوان، شماره، نام یا ایمیل مشتری) برای میز کار وردپرس
  const q = (sp.get("q") || "").trim().slice(0, 80);
  const qLike = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const page = Math.max(1, Math.min(10_000, Number(sp.get("page")) || 1));
  const limit = Math.max(1, Math.min(50, Number(sp.get("limit")) || 20));
  if (status && !(status in STATUS_LABELS)) return err(422, "invalid_status");
  // هم‌ترازسازی: وضعیت چند قرارداد مشخص (برای ترمیم رویدادهای احتمالاً ازدست‌رفته)
  const idsParam = sp.get("ids");
  const orderId = Number(sp.get("orderId")) || 0;
  if (idsParam) {
    const ids = idsParam.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
    return NextResponse.json({ ok: true, items: await statusesForContracts(auth.workspaceId, ids) }, { headers: { "Cache-Control": "no-store" } });
  }

  const where = and(
    eq(contracts.workspaceId, auth.workspaceId),
    sql`${contracts.status} <> 'draft'`,
    status ? eq(contracts.status, status) : undefined,
    email ? eq(users.email, email) : undefined,
    q.length >= 2 ? or(ilike(contracts.title, qLike), ilike(contracts.number, qLike), ilike(users.name, qLike), ilike(users.email, qLike)) : undefined,
    orderId ? sql`${contracts.id} in (select contract_id from wc_contract_links where wc_order_id = ${orderId} and workspace_id = ${auth.workspaceId})` : undefined,
  );
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({ c: contracts, name: users.name, email: users.email })
      .from(contracts)
      .innerJoin(users, eq(users.id, contracts.customerId))
      .where(where)
      .orderBy(desc(contracts.issuedAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ n: sql<number>`count(*)::int` }).from(contracts).innerJoin(users, eq(users.id, contracts.customerId)).where(where),
  ]);
  const links = rows.length ? await db.select().from(shortLinks).where(inArray(shortLinks.contractId, rows.map((r) => r.c.id))) : [];
  const base = ((await getSetting("app_url", auth.workspaceId)) || requestOrigin(req)).replace(/\/+$/, "");
  const code = new Map(links.map((l) => [l.contractId, l.code]));
  return NextResponse.json(
    {
      ok: true,
      page,
      limit,
      total: n,
      items: rows.map(({ c, name, email: mail }) => ({
        id: c.id,
        number: c.number,
        title: c.title,
        status: c.status,
        statusLabel: STATUS_LABELS[c.status] ?? c.status,
        issuedAt: c.issuedAt,
        signedAt: c.signedAt,
        expiresAt: c.expiresAt,
        value: c.contractValue,
        customer: { name, email: mail },
        shortUrl: code.has(c.id) ? `${base}/s/${code.get(c.id)}` : null,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
