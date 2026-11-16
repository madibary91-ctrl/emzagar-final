import crypto from "node:crypto";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { contracts, templates, users, workspaceInvites, workspaceMembers, workspaces } from "@/db/schema";
import { unusablePasswordHash } from "@/lib/password";
import { saveSettings } from "@/modules/settings/service";
import { STARTER_TEMPLATES } from "@/modules/seed/templates";
import { createInvite } from "./invites";

/** شناسه‌ی فضای کاری یک قرارداد (۰ اگر یافت نشد) */
export async function workspaceOfContract(contractId: number | null | undefined): Promise<number> {
  if (!contractId) return 0;
  const [row] = await db.select({ w: contracts.workspaceId }).from(contracts).where(eq(contracts.id, contractId));
  return row?.w ?? 0;
}

function makeSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `${base || "ws"}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * ساخت فضای کاری جدید با مالک مشخص + قالب‌های نمونه و تنظیمات اولیه.
 * اتمی: فضای کاری، عضویت مالک، تنظیمات و قالب‌ها یا همگی ساخته می‌شوند یا هیچ‌کدام.
 * اگر داخل تراکنش بزرگ‌تری (ثبت‌نام، نصب، …) صدا زده شود، بخشی از همان تراکنش می‌شود.
 */
export async function createWorkspace(ownerId: number, name: string, kind: "team" | "quick" = "team"): Promise<number> {
  const clean = name.trim().slice(0, 60) || "کسب‌وکار من";
  return withTransaction(async () => {
    const [ws] = await db.insert(workspaces).values({ name: clean, slug: makeSlug(clean), ownerId, kind }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: ownerId, role: "owner" });
    // فضای ایزوله هرگز ایمیل مدیریتی (admin_email) ندارد؛ نسخه‌ی نهایی اسناد خصوصی به هیچ صندوق مدیریتی نمی‌رود
    await saveSettings(kind === "quick" ? { site_name: clean.slice(0, 40), admin_email: "" } : { site_name: clean.slice(0, 40) }, ws.id);
    await db.insert(templates).values(STARTER_TEMPLATES.map((t) => ({ ...t, workspaceId: ws.id })));
    return ws.id;
  });
}

/** اعضا و مشتریانی که می‌توانند امضاکننده/طرف قرارداد این فضای کاری باشند */
export async function listWorkspaceUsers(workspaceId: number) {
  return db
    .select({ memberId: workspaceMembers.id, id: users.id, name: users.name, email: users.email, mobile: users.mobile, isGuest: users.isGuest, role: workspaceMembers.role, joinedAt: workspaceMembers.createdAt })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(users.name));
}

/** جداسازی داده: فقط شناسه‌هایی که واقعاً عضو این فضای کاری‌اند مجازند */
export async function assertUsersInWorkspace(workspaceId: number, userIds: number[]): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, ids)));
  if (rows.length !== ids.length) throw new Error("یکی از کاربران انتخاب‌شده متعلق به این فضای کاری نیست");
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EnsureClientResult = {
  /** شناسه‌ی حساب مشتری؛ وقتی consentRequired است ۰ است (شناسه‌ی حساب دیگران هرگز فاش نمی‌شود) */
  userId: number;
  created: boolean;
  linked: boolean;
  /** حسابی با این ایمیل از قبل وجود دارد و صاحبش هنوز عضویت در این فضای کاری را تأیید نکرده است */
  consentRequired: boolean;
  /** توکن دعوت تأییدیه (فقط وقتی همین الان ساخته شده تا فراخواننده آن را برای صاحب حساب ایمیل کند) */
  inviteToken?: string;
};

/** حداقل فاصله‌ی ارسال دوباره‌ی دعوت تأییدیه برای یک ایمیل در یک فضای کاری (ضد اسپم کردن قربانی) */
const CONSENT_INVITE_COOLDOWN_MS = 60 * 60_000;

/**
 * افزودن مشتری به فضای کاری — با «رضایت صاحب حساب» (SEC-06).
 *
 * فقط ایمیل هدف «اثبات مالکیت» نیست. اگر حسابی با این ایمیل از قبل وجود داشته باشد، هرگز خودبه‌خود به فضای کاری
 * فراخواننده وصل نمی‌شود (وگرنه نام، ایمیل و موبایل او در فهرست مشتریان مهاجم نشت می‌کرد). به‌جای آن یک دعوت‌نامه‌ی
 * «مشتری» برای ایمیل واقعی صاحب حساب ساخته می‌شود و عضویت فقط وقتی ثبت می‌شود که خودش وارد شود و بپذیرد.
 * حساب‌های «تازه» (که همین‌جا ساخته می‌شوند) فقط داده‌ی خود فراخواننده را دارند و مستقیم وصل می‌شوند.
 */
export async function ensureClient(
  workspaceId: number,
  input: { name: string; email: string; mobile: string; invitedBy?: number },
): Promise<EnsureClientResult> {
  const email = input.email.trim().toLowerCase();
  // ساخت حساب + اتصال به فضای کاری در یک تراکنش: حساب بدون عضویت (یتیم) باقی نمی‌ماند
  return withTransaction(async () => {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (user) {
      const [member] = await db
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id)));
      // قبلاً در همین فضای کاری عضو است: افشای جدیدی رخ نمی‌دهد
      if (member) return { userId: user.id, created: false, linked: false, consentRequired: false };

      const [recent] = await db
        .select({ id: workspaceInvites.id })
        .from(workspaceInvites)
        .where(
          and(
            eq(workspaceInvites.workspaceId, workspaceId),
            eq(workspaceInvites.email, email),
            eq(workspaceInvites.role, "client"),
            isNull(workspaceInvites.acceptedAt),
            gt(workspaceInvites.createdAt, new Date(Date.now() - CONSENT_INVITE_COOLDOWN_MS)),
          ),
        );
      if (recent) return { userId: 0, created: false, linked: false, consentRequired: true };
      let invitedBy = input.invitedBy;
      if (!invitedBy) {
        const [ws] = await db.select({ ownerId: workspaces.ownerId }).from(workspaces).where(eq(workspaces.id, workspaceId));
        invitedBy = ws?.ownerId ?? 0;
      }
      const inviteToken = await createInvite(workspaceId, email, "client", invitedBy);
      return { userId: 0, created: false, linked: false, consentRequired: true, inviteToken };
    }

    const [fresh] = await db
      .insert(users)
      .values({
        name: input.name.trim().slice(0, 100),
        email,
        mobile: input.mobile.trim(),
        passwordHash: unusablePasswordHash(),
        role: "user",
      })
      .returning();
    await db.insert(workspaceMembers).values({ workspaceId, userId: fresh.id, role: "client" }).onConflictDoNothing();
    return { userId: fresh.id, created: true, linked: true, consentRequired: false };
  });
}
