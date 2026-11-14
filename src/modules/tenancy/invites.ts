import crypto from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { users, workspaceInvites, workspaceMembers, workspaces } from "@/db/schema";
import { sha256 } from "@/lib/password";
import { isTeamRole } from "./roles";
import { isIsolatedWorkspace, visibleWorkspace } from "./isolation";

export async function createInvite(workspaceId: number, email: string, role: string, invitedBy: number): Promise<string> {
  if (await isIsolatedWorkspace(workspaceId)) throw new Error("این فضای کاری سیستمی است و عضو یا دعوت‌نامه نمی‌پذیرد");
  const plain = crypto.randomBytes(32).toString("hex");
  await db.insert(workspaceInvites).values({
    workspaceId,
    email: email.toLowerCase(),
    role,
    tokenHash: sha256(plain),
    invitedBy,
    expiresAt: new Date(Date.now() + 7 * 86400_000),
  });
  return plain;
}

export async function findInvite(plain: string) {
  if (!/^[a-f0-9]{64}$/.test(plain)) return null;
  const [row] = await db
    .select({
      id: workspaceInvites.id,
      workspaceId: workspaceInvites.workspaceId,
      email: workspaceInvites.email,
      role: workspaceInvites.role,
      workspaceName: workspaces.name,
    })
    .from(workspaceInvites)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInvites.workspaceId))
    .where(and(eq(workspaceInvites.tokenHash, sha256(plain)), isNull(workspaceInvites.acceptedAt), gt(workspaceInvites.expiresAt, new Date()), visibleWorkspace()));
  return row ?? null;
}

/**
 * پذیرش دعوت: فقط برای حسابی با همان ایمیل دعوت‌شده. نقش موجود بالاتر هرگز تنزل نمی‌یابد.
 * اتمی: «مصرف دعوت‌نامه» و «ایجاد/ارتقای عضویت» در یک تراکنش‌اند؛ اگر عضویت ثبت نشود، دعوت‌نامه سوخته نمی‌شود.
 */
export async function acceptInvite(plain: string, userId: number): Promise<{ workspaceId: number } | null> {
  const inv = await findInvite(plain);
  if (!inv) return null;
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  // مهمان عضو تیم نمی‌شود (هویت سبک است، نه حساب)
  if (!user || user.isGuest || user.email.toLowerCase() !== inv.email) return null;
  return withTransaction(async () => {
    const claimed = await db
      .update(workspaceInvites)
      .set({ acceptedAt: new Date() })
      .where(and(eq(workspaceInvites.id, inv.id), isNull(workspaceInvites.acceptedAt)))
      .returning({ id: workspaceInvites.id });
    if (claimed.length === 0) return null;
    const [existing] = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, inv.workspaceId), eq(workspaceMembers.userId, userId)));
    if (!existing) await db.insert(workspaceMembers).values({ workspaceId: inv.workspaceId, userId, role: inv.role });
    else if (!isTeamRole(existing.role)) await db.update(workspaceMembers).set({ role: inv.role }).where(eq(workspaceMembers.id, existing.id));
    return { workspaceId: inv.workspaceId };
  });
}
