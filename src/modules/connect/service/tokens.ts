import { PAIRING_TTL_MS, SSO_TTL_MS } from "./core";
import { and, eq, gt, isNull } from "drizzle-orm";
import { apiKeys, connectTokens, users, workspaceMembers } from "@/db/schema";
import { CONNECT_OWNER_EMAIL_RE } from "./handshake";
import { isTotpEnabled } from "@/modules/auth/twofactor";
import { connectionForKey } from "./connections";
import crypto from "node:crypto";
import { db } from "@/db";
import { sha256 } from "@/lib/password";

/* ───────────── ورود یک‌کلیکی (SSO) از وردپرس ───────────── */

/**
 * H-01: کلید API یک «اعتبار اتصال» است، نه هم‌ارز ورود با رمز. پس SSO فقط برای «حساب مالک اتصال خودکار» مجاز است:
 *   • ایمیل جایگزین (placeholder) و تأییدنشده — یعنی هنوز هیچ انسانی این حساب را تصاحب نکرده؛
 *   • نه مدیر کل، نه مهمان، بدون ورود دومرحله‌ای (SSO هیچ‌گاه 2FA را دور نمی‌زند)؛
 *   • فقط عضو همین یک فضای کاری (ورود به فضاهای دیگر ممکن نیست).
 * به محض اینکه حساب «واقعی» شود (ایمیل تأییدشده، 2FA، عضویت در فضای دیگر)، SSO بسته می‌شود و فقط ورود عادی (رمز + 2FA) می‌ماند.
 */
export async function isSsoEligibleOwner(ownerUserId: number, workspaceId: number): Promise<boolean> {
  const [u] = await db.select().from(users).where(eq(users.id, ownerUserId));
  if (!u || u.isGuest || u.role === "admin" || u.emailVerifiedAt || !CONNECT_OWNER_EMAIL_RE.test(u.email)) return false;
  if (await isTotpEnabled(u.id)) return false;
  const ms = await db.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, u.id));
  return ms.length === 1 && ms[0].workspaceId === workspaceId;
}

export async function createSsoToken(keyId: number, workspaceId: number): Promise<string | null> {
  const c = await connectionForKey(keyId);
  if (!c || !c.ownerUserId || c.workspaceId !== workspaceId) return null;
  if (!(await isSsoEligibleOwner(c.ownerUserId, workspaceId))) return null;
  const plain = crypto.randomBytes(32).toString("hex");
  // توکن به همان کلید API صادرکننده گره می‌خورد؛ با ابطال کلید/اتصال، توکن‌های باز هم بی‌اثر می‌شوند
  await db.insert(connectTokens).values({ purpose: "sso", tokenHash: sha256(plain), workspaceId, userId: c.ownerUserId, data: JSON.stringify({ keyId }), expiresAt: new Date(Date.now() + SSO_TTL_MS) });
  return plain;
}
export async function consumeSsoToken(plain: string): Promise<{ userId: number; workspaceId: number } | null> {
  if (!/^[a-f0-9]{64}$/.test(plain)) return null;
  const rows = await db
    .update(connectTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(connectTokens.purpose, "sso"), eq(connectTokens.tokenHash, sha256(plain)), isNull(connectTokens.usedAt), gt(connectTokens.expiresAt, new Date())))
    .returning({ userId: connectTokens.userId, workspaceId: connectTokens.workspaceId, data: connectTokens.data });
  const hit = rows[0];
  if (!hit) return null;
  // اعتبارسنجی دوباره در لحظه‌ی مصرف: کلید هنوز فعال، اتصال فعال و مالک همچنان واجد شرایط
  let keyId = 0;
  try {
    keyId = Number((JSON.parse(hit.data || "{}") as { keyId?: unknown }).keyId) || 0;
  } catch {
    keyId = 0;
  }
  if (!keyId) return null;
  const [key] = await db.select({ active: apiKeys.active, workspaceId: apiKeys.workspaceId }).from(apiKeys).where(eq(apiKeys.id, keyId));
  if (!key || !key.active || key.workspaceId !== hit.workspaceId) return null;
  const c = await connectionForKey(keyId);
  if (!c || c.workspaceId !== hit.workspaceId || c.ownerUserId !== hit.userId) return null;
  if (!(await isSsoEligibleOwner(hit.userId, hit.workspaceId))) return null;
  return { userId: hit.userId, workspaceId: hit.workspaceId };
}
/* ───────────── کد جفت‌سازی (دانلود شخصی‌سازی‌شده‌ی افزونه) ───────────── */

export async function createPairingToken(workspaceId: number, userId: number): Promise<string> {
  const plain = `emzp_${crypto.randomBytes(20).toString("hex")}`;
  await db.insert(connectTokens).values({ purpose: "pairing", tokenHash: sha256(plain), workspaceId, userId, expiresAt: new Date(Date.now() + PAIRING_TTL_MS) });
  return plain;
}
