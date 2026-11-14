import { ConnectError, HANDSHAKE_TTL_MS, type HandshakeData, assertSandboxQuota, isLocalSite, parseInput, safeEqual, sandboxConnectAllowed } from "./core";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { apiKeys, connectTokens, templates, users, workspaces, wpConnections } from "@/db/schema";
import { assertSafeUrl, safeFetch } from "@/lib/ssrf";
import { createWorkspace } from "@/modules/tenancy/service";
import crypto from "node:crypto";
import { db } from "@/db";
import { generateKey } from "@/modules/api/service";
import { serializeScopes, WORDPRESS_CONNECTION_SCOPES } from "@/modules/api/scopes";
import { logAudit } from "@/modules/audit/service";
import { saveSettings } from "@/modules/settings/service";
import { sha256, unusablePasswordHash } from "@/lib/password";

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
/**
 * H-02: ایمیلِ ادعاشده‌ی مدیر وردپرس «هرگز» هویت حساب نمی‌شود (هیچ مالکیتی ثابت نشده است). مالک اتصال خودکار همیشه
 * یک حساب بی‌رمز با ایمیل جایگزین (placeholder) است؛ پس مهاجم نمی‌تواند ایمیل قربانی را «اشغال» کند و قربانی
 * هنگام ثبت‌نام، صاحب یک فضای کاری از پیش‌آلوده (با کلید API دست مهاجم) نمی‌شود.
 */
export const CONNECT_OWNER_EMAIL_RE = /^wp-[a-f0-9]{12,32}@sites\.emzagar\.invalid$/;
async function pickOwner(input: HandshakeData): Promise<number> {
  const email = `wp-${crypto.randomBytes(8).toString("hex")}@sites.emzagar.invalid`;
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
    // ایمیل ادعاشده تأییدنشده است؛ نسخه‌ی نهایی قراردادها به آن فرستاده نمی‌شود (مدیر در تنظیمات پنل ایمیل خودش را می‌گذارد)
    await saveSettings({ admin_email: "" }, workspaceId);
    await logAudit({ action: "workspace.created", workspaceId, userId: ownerUserId, detail: `اتصال خودکار وردپرس: ${data.host}`, actor: "wp-connect" });
  }

  // ── چرخش کلید ──
  if (oldKeyId) await db.update(apiKeys).set({ active: false }).where(and(eq(apiKeys.id, oldKeyId), eq(apiKeys.workspaceId, workspaceId)));
  const k = generateKey();
  const [keyRow] = await db
    .insert(apiKeys)
    .values({ workspaceId, name: `وردپرس: ${data.host}`.slice(0, 60), prefix: k.prefix, keyHash: k.hash, createdBy: ownerUserId, scopes: serializeScopes(WORDPRESS_CONNECTION_SCOPES) })
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
