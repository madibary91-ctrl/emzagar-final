"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contracts, shortLinks } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { isSecureRequest } from "@/modules/auth/session";
import { logAudit } from "@/modules/audit/service";
import { hashPasswordAsync, verifyPasswordAsync } from "@/lib/password";
import {
  SLUG_RE, UNLOCK_TTL, ensureShortLink, getLinkByCode, getLinkForContract, makeUnlockToken, unlockCookieName,
} from "./service";

export type LinkState = { ok?: boolean; error?: string };

/** ساخت / ویرایش لینک اختصاصی قرارداد (فقط مدیر) */
export async function saveLinkAction(_prev: LinkState, formData: FormData): Promise<LinkState> {
  const admin = await requireTeam("write");
  const contractId = Number(formData.get("contractId"));
  if (!Number.isInteger(contractId)) return { error: "قرارداد نامعتبر است" };
  const [c] = await db.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.workspaceId, admin.workspaceId)));
  if (!c) return { error: "قرارداد یافت نشد" };

  const slug = String(formData.get("slug") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  const clearPassword = formData.get("clearPassword") === "on";
  const days = Number(formData.get("days")) || 0;

  if (slug && !SLUG_RE.test(slug)) return { error: "کد اختصاصی فقط شامل حروف انگلیسی کوچک، عدد و خط تیره (۳ تا ۳۲ نویسه) باشد" };
  if (password && password.length < 4) return { error: "رمز لینک حداقل ۴ نویسه باشد" };
  if (days < 0 || days > 365) return { error: "مهلت لینک باید بین ۰ تا ۳۶۵ روز باشد" };

  const link = await ensureShortLink(contractId, admin.id);
  const patch: Partial<typeof shortLinks.$inferInsert> = { active: true };
  if (slug && slug !== link.code) {
    const taken = await getLinkByCode(slug);
    if (taken && taken.id !== link.id) return { error: "این کد اختصاصی قبلاً استفاده شده است" };
    patch.code = slug;
  }
  if (password) {
    patch.passwordHash = await hashPasswordAsync(password);
    patch.failedAttempts = 0;
    patch.lockedUntil = null;
  } else if (clearPassword) patch.passwordHash = null;
  patch.expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : null;

  await db.update(shortLinks).set(patch).where(eq(shortLinks.id, link.id));
  await logAudit({ workspaceId: admin.workspaceId,
    action: "link.created",
    contractId,
    userId: admin.id,
    detail: `${patch.code ?? link.code}${password ? " — با رمز" : ""}${days ? ` — ${days} روز` : ""}`,
  });
  revalidatePath(`/contracts/${contractId}`);
  return { ok: true };
}

export async function disableLinkAction(formData: FormData) {
  const admin = await requireTeam("write");
  const contractId = Number(formData.get("contractId"));
  if (!Number.isInteger(contractId)) return;
  const [owned] = await db.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.workspaceId, admin.workspaceId)));
  if (!owned) return;
  const link = await getLinkForContract(contractId);
  if (!link) return;
  await db.update(shortLinks).set({ active: !link.active }).where(eq(shortLinks.id, link.id));
  await logAudit({ workspaceId: admin.workspaceId, action: "link.disabled", contractId, userId: admin.id, detail: link.active ? "غیرفعال" : "فعال" });
  revalidatePath(`/contracts/${contractId}`);
}

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

/** بررسی رمز لینک (عمومی): با محدودیت تلاش و قفل موقت */
export async function unlockLinkAction(_prev: LinkState, formData: FormData): Promise<LinkState> {
  const code = String(formData.get("code") || "");
  const password = String(formData.get("password") || "");
  const link = await getLinkByCode(code);
  if (!link || !link.active || (link.expiresAt && link.expiresAt < new Date()) || !link.passwordHash) {
    return { error: "لینک نامعتبر یا منقضی شده است" };
  }
  if (link.lockedUntil && link.lockedUntil > new Date()) {
    return { error: "به‌دلیل تلاش‌های ناموفق، لینک موقتاً قفل شده است. چند دقیقه بعد دوباره تلاش کنید." };
  }
  if (!(await verifyPasswordAsync(password, link.passwordHash))) {
    // افزایش اتمیک شمارنده؛ تلاش‌های موازی نمی‌توانند قفل را دور بزنند
    const [upd] = await db
      .update(shortLinks)
      .set({ failedAttempts: sql`${shortLinks.failedAttempts} + 1` })
      .where(eq(shortLinks.id, link.id))
      .returning({ n: shortLinks.failedAttempts });
    const fails = upd?.n ?? link.failedAttempts + 1;
    if (fails >= MAX_FAILS) {
      await db.update(shortLinks).set({ failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MS) }).where(eq(shortLinks.id, link.id));
    }
    await logAudit({ action: "link.failed", contractId: link.contractId, detail: `${link.code} — تلاش ${fails}` });
    return { error: fails >= MAX_FAILS ? "تعداد تلاش‌ها بیش از حد مجاز است؛ لینک ۱۵ دقیقه قفل شد." : "رمز نادرست است" };
  }
  await db.update(shortLinks).set({ failedAttempts: 0, lockedUntil: null }).where(eq(shortLinks.id, link.id));
  const jar = await cookies();
  jar.set(unlockCookieName(link.code), makeUnlockToken(link.code), {
    httpOnly: true,
    sameSite: "lax",
    secure: await isSecureRequest(),
    path: "/",
    maxAge: UNLOCK_TTL,
  });
  return { ok: true };
}
