import crypto from "node:crypto";
import net from "node:net";
import { and, asc, desc, eq, isNull, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, connectTokens, templates, users, workspaces, wpConnections } from "@/db/schema";
import { sha256, unusablePasswordHash } from "@/lib/password";
import { assertSafeUrl, isPrivateIp, safeFetch } from "@/lib/ssrf";
import { EMAIL_RE, createWorkspace } from "@/modules/tenancy/service";
import { saveSettings } from "@/modules/settings/service";
import { generateKey } from "@/modules/api/service";
import { logAudit } from "@/modules/audit/service";

/**
 * اتصال بدون تنظیم (Zero-Config) افزونه‌ی وردپرس
 * ───────────────────────────────────────────────
 * ۱) register : افزونه اطلاعات سایت را می‌فرستد؛ ابر یک «چالش» تصادفی می‌سازد.
 * ۲) افزونه چالش را روی مسیر REST خودش (/wp-json/emzagar/v1/verify) در دسترس می‌گذارد.
 * ۳) complete : ابر همان مسیر را از بیرون فراخوانی می‌کند؛ اگر چالش برگردد، مالکیت دامنه ثابت شده است.
 * ۴) فضای کاری + قالب‌های نمونه + کلید API ساخته می‌شود و کلید فقط یک‌بار به سرور وردپرس تحویل می‌شود.
 *
 * کاربر نهایی هیچ‌چیزی کپی/وارد نمی‌کند.
 */

const HANDSHAKE_TTL_MS = 15 * 60_000;
const PAIRING_TTL_MS = 7 * 24 * 3600_000;
const SSO_TTL_MS = 90_000;

export class ConnectError extends Error {
  constructor(public code: string, public status = 422, message?: string) {
    super(message ?? code);
  }
}

export type RegisterInput = {
  installId: string;
  siteUrl: string;
  siteName: string;
  adminEmail: string;
  adminName: string;
  pluginVersion: string;
  wpVersion: string;
  wcActive: boolean;
  locale: string;
  pairing?: string;
};

type HandshakeData = RegisterInput & { challenge: string; host: string; pairingHash?: string };

const CTRL = /[\u0000-\u001f\u007f]/g;
const clean = (v: unknown, max: number) => String(v ?? "").replace(CTRL, " ").trim().slice(0, max);

/** آدرس سایت وردپرس را نرمال می‌کند: فقط http(s)، بدون اسلش پایانی، بدون کوئری و هش */
export function normalizeSiteUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new ConnectError("site_url_invalid");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ConnectError("site_url_invalid");
  if (u.username || u.password) throw new ConnectError("site_url_invalid");
  u.search = "";
  u.hash = "";
  u.pathname = u.pathname.replace(/\/+$/, "");
  return u;
}

/**
 * سایت‌های «واقعاً محلی/آزمایشی» که ابر نمی‌تواند به آن‌ها دسترسی بگیرد (localhost، IP خصوصی، پسوندهای رزروشده).
 * پروتکل ملاک نیست: یک آدرس http:// روی دامنه‌ی عمومی «محلی» نیست و باید مالکیت دامنه‌اش تایید شود
 * (در غیر این صورت هر کسی با ثبت یک آدرس http جعلی، بی‌نهایت فضای کاری و کلید API می‌ساخت — SEC-03).
 */
export function isLocalSite(u: URL): boolean {
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (net.isIP(host)) return isPrivateIp(host);
  return host === "localhost" || !host.includes(".") || /\.(local|localhost|test|internal|lan|example|invalid)$/.test(host);
}

/**
 * حالت Sandbox (اتصال بدون تایید دامنه برای سایت محلی) فقط برای توسعه/آزمون است و روی سرور production به‌طور
 * پیش‌فرض «خاموش» است؛ در production سایت محلی فقط با «کد جفت‌سازی» حساب کاربری اتصال می‌گیرد.
 * اگر واقعاً لازم بود، مدیر سرور با ALLOW_SANDBOX_CONNECT=1 آن را آگاهانه روشن می‌کند.
 */
export function sandboxConnectAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ALLOW_SANDBOX_CONNECT === "1";
}

/** سقف روزانه‌ی اتصال‌های تایید‌نشده (Sandbox) در کل سامانه؛ حتی با روشن بودن Sandbox، ساخت بی‌نهایت فضای کاری ممکن نیست */
const SANDBOX_DAILY_CAP = Number(process.env.SANDBOX_DAILY_CAP) > 0 ? Number(process.env.SANDBOX_DAILY_CAP) : 50;

async function assertSandboxQuota(): Promise<void> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(wpConnections)
    .where(and(eq(wpConnections.verified, false), sql`${wpConnections.createdAt} > now() - interval '1 day'`));
  if ((row?.n ?? 0) >= SANDBOX_DAILY_CAP) throw new ConnectError("sandbox_quota", 429, "سقف روزانه‌ی اتصال آزمایشی پر شده است؛ دامنه‌ی خود را تایید کنید.");
}

function parseInput(raw: unknown): { input: RegisterInput; url: URL } {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const installId = clean(b.installId, 64);
  if (!/^[a-f0-9]{32}$/.test(installId)) throw new ConnectError("install_id_invalid");
  const url = normalizeSiteUrl(String(b.siteUrl || ""));
  const adminEmail = clean(b.adminEmail, 200).toLowerCase();
  if (!EMAIL_RE.test(adminEmail)) throw new ConnectError("admin_email_invalid");
  const pairing = clean(b.pairing, 80);
  if (pairing && !/^emzp_[a-f0-9]{40}$/.test(pairing)) throw new ConnectError("pairing_invalid");
  const siteName = clean(b.siteName, 60) || url.hostname;
  return {
    url,
    input: {
      installId,
      siteUrl: url.origin + url.pathname,
      siteName,
      adminEmail,
      adminName: clean(b.adminName, 100) || siteName,
      pluginVersion: clean(b.pluginVersion, 20),
      wpVersion: clean(b.wpVersion, 20),
      wcActive: b.wcActive === true,
      locale: clean(b.locale, 20),
      pairing: pairing || undefined,
    },
  };
}

/* ───────────── مرحله‌ی ۱: شروع دست‌دادن ───────────── */

export async function startHandshake(raw: unknown): Promise<{ handshakeId: string; challenge: string; mode: "verify" | "sandbox" | "paired" }> {
  const { input, url } = parseInput(raw);
  let pairingHash: string | undefined;
  if (input.pairing) {
    pairingHash = sha256(input.pairing);
    const [p] = await db
      .select({ id: connectTokens.id })
      .from(connectTokens)
      .where(and(eq(connectTokens.purpose, "pairing"), eq(connectTokens.tokenHash, pairingHash), isNull(connectTokens.usedAt), gt(connectTokens.expiresAt, new Date())));
    if (!p) throw new ConnectError("pairing_expired", 410);
  }
  if (!pairingHash && isLocalSite(url) && !sandboxConnectAllowed()) {
    throw new ConnectError("sandbox_disabled", 403, "اتصال سایت محلی/آزمایشی روی این سرور بدون کد جفت‌سازی مجاز نیست.");
  }
  const handshakeId = crypto.randomBytes(24).toString("hex");
  const challenge = crypto.randomBytes(24).toString("hex");
  const data: HandshakeData = { ...input, pairing: undefined, challenge, host: url.hostname.toLowerCase(), pairingHash };
  await db.insert(connectTokens).values({ purpose: "handshake", tokenHash: sha256(handshakeId), data: JSON.stringify(data), expiresAt: new Date(Date.now() + HANDSHAKE_TTL_MS) });
  // پاک‌سازی توکن‌های منقضی
  await db.delete(connectTokens).where(sql`${connectTokens.expiresAt} < now() - interval '1 day'`);
  return { handshakeId, challenge, mode: pairingHash ? "paired" : isLocalSite(url) ? "sandbox" : "verify" };
}

/* ───────────── مرحله‌ی ۲: تایید مالکیت دامنه ───────────── */

async function fetchVerify(siteUrl: string, handshakeId: string): Promise<string | null> {
  let target = `${siteUrl}/?rest_route=${encodeURIComponent("/emzagar/v1/verify")}&handshake=${handshakeId}`;
  const originHost = new URL(target).hostname;
  for (let hop = 0; hop < 3; hop++) {
    const u = await assertSafeUrl(target, { allowHttp: true });
    // تغییر مسیر فقط درون همان میزبان پذیرفته می‌شود (مثلاً www یا اسلش پایانی)
    if (u.hostname.replace(/^www\./, "") !== originHost.replace(/^www\./, "")) return null;
    // اتصال با نگهبان SSRF در لحظه‌ی اتصال (ضد DNS Rebinding)؛ http فقط برای همین تایید مالکیت (بدون هیچ رازی) مجاز است
    const res = await safeFetch(u, { allowHttp: true, redirect: "manual", signal: AbortSignal.timeout(9000), headers: { Accept: "application/json", "User-Agent": "EmzagarCloud/1.0" } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      target = new URL(loc, u).toString();
      continue;
    }
    if (!res.ok) return null;
    const text = (await res.text()).slice(0, 4000);
    try {
      const j = JSON.parse(text) as { challenge?: unknown };
      return typeof j.challenge === "string" ? j.challenge : null;
    } catch {
      return null;
    }
  }
  return null;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* ───────────── مرحله‌ی ۳: تکمیل و ساخت اتصال ───────────── */

export type ConnectResult = {
  apiKey: string;
  workspaceId: number;
  workspaceName: string;
  defaultTemplateId: number;
  verified: boolean;
  reused: boolean;
  /** آیا ورود یک‌کلیکی (SSO) به پنل ممکن است */
  sso: boolean;
};

async function pickOwner(input: HandshakeData): Promise<number> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.adminEmail));
  // اگر ایمیل قبلاً حساب دارد، اتصال ناشناس هرگز به آن حساب وصل نمی‌شود (جلوگیری از سوءاستفاده)
  const email = existing ? `wp-${crypto.randomBytes(6).toString("hex")}@sites.emzagar.invalid` : input.adminEmail;
  const [u] = await db
    .insert(users)
    .values({ name: input.adminName.slice(0, 100), email, mobile: "", passwordHash: unusablePasswordHash(), role: "user" })
    .returning({ id: users.id });
  return u.id;
}

export async function completeHandshake(handshakeId: string): Promise<ConnectResult> {
  if (!/^[a-f0-9]{48}$/.test(handshakeId)) throw new ConnectError("handshake_invalid");
  const hash = sha256(handshakeId);
  const [tok] = await db
    .select()
    .from(connectTokens)
    .where(and(eq(connectTokens.purpose, "handshake"), eq(connectTokens.tokenHash, hash), isNull(connectTokens.usedAt), gt(connectTokens.expiresAt, new Date())));
  if (!tok) throw new ConnectError("handshake_expired", 410);
  const data = JSON.parse(tok.data) as HandshakeData;
  const url = new URL(data.siteUrl);
  const local = isLocalSite(url);
  if (local && !data.pairingHash && !sandboxConnectAllowed()) throw new ConnectError("sandbox_disabled", 403, "اتصال سایت محلی/آزمایشی روی این سرور بدون کد جفت‌سازی مجاز نیست.");

  // ── تایید مالکیت ──
  let verified = false;
  if (data.pairingHash) {
    verified = true; // کد جفت‌سازی از داخل حساب کاربری صادر شده است
  } else if (!local) {
    let got: string | null = null;
    try {
      got = await fetchVerify(data.siteUrl, handshakeId);
    } catch {
      got = null;
    }
    if (!got || !safeEqual(got, data.challenge)) throw new ConnectError("site_unreachable", 422, "ابر نتوانست سایت شما را تایید کند");
    verified = true;
  }

  // سایت تایید‌نشده (Sandbox) فقط تا سقف روزانه
  if (!verified) await assertSandboxQuota();

  // ── مصرف اتمیک توکن ──
  const claimed = await db.update(connectTokens).set({ usedAt: new Date() }).where(and(eq(connectTokens.id, tok.id), isNull(connectTokens.usedAt))).returning({ id: connectTokens.id });
  if (claimed.length === 0) throw new ConnectError("handshake_expired", 410);

  // ── تعیین فضای کاری ──
  let workspaceId = 0;
  let ownerUserId: number | null = null;
  let reused = false;
  let existingConnId = 0;
  let oldKeyId: number | null = null;

  const [byInstall] = await db.select().from(wpConnections).where(eq(wpConnections.installId, data.installId));
  // اتصال تأییدشده را فقط ادعای تأییدشده می‌تواند بازیابی/بچرخاند. در غیر این صورت کپی آزمایشی/لوکال یک سایت
  // (با همان installId) در حالت Sandbox کلید API سایت واقعی را باطل می‌کرد و فضای کاری آن را در اختیار می‌گرفت.
  if (byInstall && byInstall.verified && !verified) {
    throw new ConnectError("install_verified", 409, "این نصب پیش‌تر با دامنه‌ی واقعی تأیید شده است؛ برای اتصال دوباره باید دامنه‌ی خود را تأیید کنید.");
  }
  if (byInstall && (verified || local)) {
    workspaceId = byInstall.workspaceId;
    ownerUserId = byInstall.ownerUserId;
    existingConnId = byInstall.id;
    oldKeyId = byInstall.apiKeyId;
    reused = true;
  }
  if (!workspaceId && data.pairingHash) {
    const [p] = await db.select().from(connectTokens).where(and(eq(connectTokens.purpose, "pairing"), eq(connectTokens.tokenHash, data.pairingHash), isNull(connectTokens.usedAt), gt(connectTokens.expiresAt, new Date())));
    if (!p) throw new ConnectError("pairing_expired", 410);
    const used = await db.update(connectTokens).set({ usedAt: new Date() }).where(and(eq(connectTokens.id, p.id), isNull(connectTokens.usedAt))).returning({ id: connectTokens.id });
    if (used.length === 0) throw new ConnectError("pairing_expired", 410);
    workspaceId = p.workspaceId;
  }
  if (!workspaceId && verified) {
    // نصب مجدد روی همان دامنه‌ی تاییدشده: همان فضای کاری و داده‌ها برمی‌گردند
    const [prev] = await db
      .select()
      .from(wpConnections)
      .where(and(eq(wpConnections.siteHost, data.host), eq(wpConnections.verified, true)))
      .orderBy(desc(wpConnections.createdAt))
      .limit(1);
    if (prev) {
      workspaceId = prev.workspaceId;
      ownerUserId = prev.ownerUserId;
      existingConnId = prev.id;
      oldKeyId = prev.apiKeyId;
      reused = true;
    }
  }
  if (!workspaceId) {
    ownerUserId = await pickOwner(data);
    workspaceId = await createWorkspace(ownerUserId, data.siteName);
    await saveSettings({ admin_email: data.adminEmail }, workspaceId);
    await logAudit({ action: "workspace.created", workspaceId, userId: ownerUserId, detail: `اتصال خودکار وردپرس: ${data.host}`, actor: "wp-connect" });
  }

  // ── چرخش کلید ──
  if (oldKeyId) await db.update(apiKeys).set({ active: false }).where(and(eq(apiKeys.id, oldKeyId), eq(apiKeys.workspaceId, workspaceId)));
  const k = generateKey();
  const [keyRow] = await db
    .insert(apiKeys)
    .values({ workspaceId, name: `وردپرس: ${data.host}`.slice(0, 60), prefix: k.prefix, keyHash: k.hash, createdBy: ownerUserId })
    .returning({ id: apiKeys.id });

  const values = {
    workspaceId,
    installId: data.installId,
    siteUrl: data.siteUrl,
    siteHost: data.host,
    siteName: data.siteName,
    verified,
    apiKeyId: keyRow.id,
    ownerUserId,
    pluginVersion: data.pluginVersion,
    wpVersion: data.wpVersion,
    wcActive: data.wcActive,
    locale: data.locale,
    status: "active",
    lastSeenAt: new Date(),
  };
  if (existingConnId) await db.update(wpConnections).set(values).where(eq(wpConnections.id, existingConnId));
  else await db.insert(wpConnections).values(values);

  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const [tpl] = await db.select({ id: templates.id }).from(templates).where(eq(templates.workspaceId, workspaceId)).orderBy(asc(templates.id)).limit(1);
  await logAudit({ action: "apikey.created", workspaceId, detail: `اتصال خودکار ${data.host}${verified ? "" : " (تایید نشده)"}`, actor: "wp-connect" });
  const sso = !!ownerUserId && !data.pairingHash;
  return { apiKey: k.plain, workspaceId, workspaceName: ws?.name ?? data.siteName, defaultTemplateId: tpl?.id ?? 0, verified, reused, sso };
}

/* ───────────── پس از اتصال: وضعیت، ضربان، قطع ───────────── */

export async function connectionForKey(keyId: number) {
  const [c] = await db.select().from(wpConnections).where(and(eq(wpConnections.apiKeyId, keyId), eq(wpConnections.status, "active")));
  return c ?? null;
}

export async function heartbeat(keyId: number, meta: Partial<Pick<RegisterInput, "pluginVersion" | "wpVersion" | "wcActive" | "locale" | "siteName">>) {
  const c = await connectionForKey(keyId);
  if (!c) return null;
  await db
    .update(wpConnections)
    .set({
      lastSeenAt: new Date(),
      pluginVersion: clean(meta.pluginVersion, 20) || c.pluginVersion,
      wpVersion: clean(meta.wpVersion, 20) || c.wpVersion,
      wcActive: typeof meta.wcActive === "boolean" ? meta.wcActive : c.wcActive,
      locale: clean(meta.locale, 20) || c.locale,
      siteName: clean(meta.siteName, 60) || c.siteName,
    })
    .where(eq(wpConnections.id, c.id));
  return c;
}

export async function disconnectByKey(keyId: number, workspaceId: number) {
  const c = await connectionForKey(keyId);
  if (c) await db.update(wpConnections).set({ status: "disconnected" }).where(eq(wpConnections.id, c.id));
  await db.update(apiKeys).set({ active: false }).where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, workspaceId)));
  await logAudit({ action: "apikey.revoked", workspaceId, detail: `قطع اتصال وردپرس ${c?.siteHost ?? ""}`, actor: "wp-connect" });
}

export async function disconnectById(workspaceId: number, connId: number) {
  const [c] = await db.select().from(wpConnections).where(and(eq(wpConnections.id, connId), eq(wpConnections.workspaceId, workspaceId)));
  if (!c) return;
  await db.update(wpConnections).set({ status: "disconnected" }).where(eq(wpConnections.id, c.id));
  if (c.apiKeyId) await db.update(apiKeys).set({ active: false }).where(and(eq(apiKeys.id, c.apiKeyId), eq(apiKeys.workspaceId, workspaceId)));
}

export async function listConnections(workspaceId: number) {
  return db.select().from(wpConnections).where(eq(wpConnections.workspaceId, workspaceId)).orderBy(desc(wpConnections.createdAt));
}

/* ───────────── ورود یک‌کلیکی (SSO) از وردپرس ───────────── */

/** فقط برای فضاهای کاری که حساب مالک آن را خود اتصال خودکار ساخته (نه مدیر کل پلتفرم) */
export async function createSsoToken(keyId: number, workspaceId: number): Promise<string | null> {
  const c = await connectionForKey(keyId);
  if (!c || !c.ownerUserId) return null;
  const [owner] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, c.ownerUserId));
  if (!owner || owner.role === "admin") return null;
  const plain = crypto.randomBytes(32).toString("hex");
  await db.insert(connectTokens).values({ purpose: "sso", tokenHash: sha256(plain), workspaceId, userId: owner.id, expiresAt: new Date(Date.now() + SSO_TTL_MS) });
  return plain;
}

export async function consumeSsoToken(plain: string): Promise<{ userId: number; workspaceId: number } | null> {
  if (!/^[a-f0-9]{64}$/.test(plain)) return null;
  const rows = await db
    .update(connectTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(connectTokens.purpose, "sso"), eq(connectTokens.tokenHash, sha256(plain)), isNull(connectTokens.usedAt), gt(connectTokens.expiresAt, new Date())))
    .returning({ userId: connectTokens.userId, workspaceId: connectTokens.workspaceId });
  return rows[0] ?? null;
}

/* ───────────── کد جفت‌سازی (دانلود شخصی‌سازی‌شده‌ی افزونه) ───────────── */

export async function createPairingToken(workspaceId: number, userId: number): Promise<string> {
  const plain = `emzp_${crypto.randomBytes(20).toString("hex")}`;
  await db.insert(connectTokens).values({ purpose: "pairing", tokenHash: sha256(plain), workspaceId, userId, expiresAt: new Date(Date.now() + PAIRING_TTL_MS) });
  return plain;
}
