import crypto from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, lockScope, withTransaction } from "@/db";
import { users, workspaceInvites, workspaceMembers, workspaces } from "@/db/schema";
import { sha256 } from "@/lib/password";
import { assertCanAddMember, assertSeatFreeForAccept } from "@/modules/billing/service";
import { isTeamRole } from "./roles";
import { isIsolatedWorkspace, visibleWorkspace } from "./isolation";

/**
 * ساخت «خام» دعوت‌نامه (بدون سنجش سقف). دعوت نقش تیمی (member/admin/viewer) را فقط از مسیر `createTeamInvite` بسازید؛
 * این تابع برای نقش client (مشتری/امضاکننده‌ی خارجی که صندلی تیم نمی‌گیرد) و کدهای داخلی است.
 * حتی اگر دعوتی بدون سنجش ساخته شود، سقف واقعی هنگام پذیرش (`acceptInvite`) اعمال می‌شود؛ پس دور زدن ممکن نیست.
 */
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

/** قفل سریال‌کننده‌ی «صندلی‌های تیم» هر فضای کاری (ساخت دعوت، پذیرش دعوت و ارتقای نقش هر سه پشت همین قفل‌اند) */
export const TEAM_SEATS_LOCK = "team-seats";

/**
 * HX-01 — ساخت دعوت‌نامه‌ی عضو تیم با رزرو «صندلی». دعوت‌نامه‌ی باز یک صندلی اشغال می‌کند: اعضای فعلی + ایمیل‌های متمایزِ
 * دعوت‌های باز باید جای یک نفر دیگر داشته باشند (پیش‌تر دعوت‌های باز شمرده نمی‌شدند ⇒ ساخت انبوه دعوت‌نامه).
 * سنجش و درج در یک تراکنش و پشت قفل فضای کاری است تا ساخت هم‌زمان دعوت‌ها هم از سقف رد نشود.
 * ارسال دوباره‌ی لینک برای همان ایمیل صندلی اضافه نمی‌گیرد. خطای سقف: PlanLimitError (پیش از هر نوشتن).
 */
export async function createTeamInvite(workspaceId: number, email: string, role: string, invitedBy: number): Promise<string> {
  return withTransaction(async () => {
    if (role !== "client") {
      await lockScope(TEAM_SEATS_LOCK, workspaceId);
      await assertCanAddMember(workspaceId, { email: email.toLowerCase() });
    }
    return createInvite(workspaceId, email, role, invitedBy);
  });
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
 *
 * HX-01: سقف اعضای طرح هنگام پذیرش هم اعمال می‌شود (دیوار آخر، پشت همان قفل ساخت دعوت). اگر ظرفیت تکمیل باشد
 * PlanLimitError پرتاب و کل تراکنش برگردانده می‌شود ⇒ دعوت‌نامه «نمی‌سوزد» و پس از ارتقای طرح هنوز قابل‌استفاده است.
 * فقط ورود «عضو تیمیِ تازه» (یا ارتقای مشتری به نقش تیمی) صندلی می‌گیرد؛ عضو تیمی موجود و نقش client صندلی نمی‌خواهند.
 */
export async function acceptInvite(plain: string, userId: number): Promise<{ workspaceId: number } | null> {
  const inv = await findInvite(plain);
  if (!inv) return null;
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  // مهمان عضو تیم نمی‌شود (هویت سبک است، نه حساب)
  if (!user || user.isGuest || user.email.toLowerCase() !== inv.email) return null;
  return withTransaction(async () => {
    if (inv.role !== "client") await lockScope(TEAM_SEATS_LOCK, inv.workspaceId);
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
    if (inv.role !== "client" && (!existing || !isTeamRole(existing.role))) await assertSeatFreeForAccept(inv.workspaceId);
    if (!existing) await db.insert(workspaceMembers).values({ workspaceId: inv.workspaceId, userId, role: inv.role });
    else if (!isTeamRole(existing.role)) await db.update(workspaceMembers).set({ role: inv.role }).where(eq(workspaceMembers.id, existing.id));
    return { workspaceId: inv.workspaceId };
  });
}
