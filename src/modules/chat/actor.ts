import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/modules/auth/session";
import { isSecureRequest } from "@/modules/auth/session";
import { sha256 } from "@/lib/password";
import { getTeamContext } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { getPlatformAdminForApi } from "@/modules/platform/admin";
import { ChatError, getConversation, staffCanAccess, type Conv, type Requester, type StaffScope } from "./service";
import type { ChatContextKind, ChatQueue } from "./meta";

export const VISITOR_COOKIE = "amz_chat";
const VISITOR_MAX_AGE = 60 * 60 * 24 * 30;
const VISITOR_RE = /^[A-Za-z0-9_-]{32,64}$/;

/**
 * هویت مشتری:
 *  - panel → کاربر واردشده (نشست)
 *  - sign / pay / site → «کوکی بازدیدکننده» (راز تصادفی؛ فقط هش آن در دیتابیس است)
 * create=true فقط هنگام ارسال پیام (نه با باز کردن ویجت) کوکی می‌سازد.
 */
export async function getRequester(kind: ChatContextKind, create: boolean): Promise<Requester | null> {
  if (kind === "panel") {
    const u = await getCurrentUser();
    return u ? { kind: "user", userId: u.id, name: u.name, mobile: u.mobile } : null;
  }
  const jar = await cookies();
  let secret = jar.get(VISITOR_COOKIE)?.value;
  if (!secret || !VISITOR_RE.test(secret)) {
    if (!create) return null;
    secret = crypto.randomBytes(32).toString("base64url");
    jar.set(VISITOR_COOKIE, secret, { httpOnly: true, sameSite: "lax", secure: await isSecureRequest(), path: "/", maxAge: VISITOR_MAX_AGE });
  }
  return { kind: "visitor", hash: sha256(secret) };
}

/** دسترسی مشتری به یک گفتگو با «کد»: صاحب حساب یا صاحب کوکی بازدیدکننده */
export async function requesterConversation(code: string): Promise<Conv | null> {
  const conv = await getConversation(code);
  if (!conv) return null;
  if (conv.userId) {
    const u = await getCurrentUser();
    return u && u.id === conv.userId ? conv : null;
  }
  const who = await getRequester("site", false);
  return who && who.kind === "visitor" && conv.visitorHash === who.hash ? conv : null;
}

/** پشتیبان: مدیر کل (صف پلتفرم) یا عضو تیم با دسترسی نوشتن (صف فضای کاری فعال) */
export async function getStaff(queue: ChatQueue): Promise<StaffScope | null> {
  if (queue === "platform") {
    const u = await getPlatformAdminForApi();
    return u ? { queue, workspaceId: 0, userId: u.id, name: u.name } : null;
  }
  const t = await getTeamContext();
  return t && can(t.wsRole, "write") ? { queue, workspaceId: t.workspaceId, userId: t.id, name: t.name } : null;
}

export async function staffConversation(s: StaffScope, code: string): Promise<Conv | null> {
  const conv = await getConversation(code);
  return conv && staffCanAccess(s, conv) ? conv : null;
}

/** دفاع در برابر CSRF برای درخواست‌های تغییردهنده: اگر Origin فرستاده شده باشد باید هم‌مبدأ باشد */
export async function sameOriginOk(): Promise<boolean> {
  const h = await headers();
  const origin = h.get("origin");
  if (!origin) return true;
  const host = h.get("x-forwarded-host") || h.get("host");
  try {
    return !!host && new URL(origin).host === host.split(",")[0].trim();
  } catch {
    return false;
  }
}

const NO_STORE = { "Cache-Control": "private, no-store" };
export const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: NO_STORE });

export function fail(e: unknown) {
  if (e instanceof ChatError) return json({ error: e.code, message: e.message }, e.status);
  console.error("[chat]", e);
  return json({ error: "server", message: "خطای داخلی؛ دوباره تلاش کنید" }, 500);
}
