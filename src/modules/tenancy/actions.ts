"use server";

import { redirect } from "next/navigation";
import { escapeHtml } from "@/lib/html";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { users, workspaceInvites, workspaceMembers } from "@/db/schema";
import { requireUser } from "@/modules/auth/session";
import { createResetToken } from "@/modules/auth/tokens";
import { logAudit } from "@/modules/audit/service";
import { sendMail } from "@/modules/mail";
import { getOrigin } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { getMemberships, requireTeam, setActiveWorkspaceCookie } from "./context";
import { canManageRole, isTeamRole, ROLE_LABELS, type MemberRole } from "./roles";
import { createInvite } from "./invites";
import { sendClientConsentEmail } from "./client-consent";
import { assertCanAddMember } from "@/modules/billing/service";
import { createWorkspace, ensureClient, EMAIL_RE } from "./service";
import { getSetting } from "@/modules/settings/service";

export type TeamState = { ok?: boolean; error?: string; message?: string; link?: string };
const showDevLinks = () => process.env.NODE_ENV !== "production" || process.env.ALLOW_DEV_OTP === "1";

/** تعویض فضای کاری فعال؛ عضویت واقعی در دیتابیس بررسی می‌شود */
export async function switchWorkspaceAction(formData: FormData) {
  const user = await requireUser();
  const id = Number(formData.get("workspaceId"));
  const m = (await getMemberships(user.id)).find((x) => x.workspaceId === id && isTeamRole(x.role));
  if (m) await setActiveWorkspaceCookie(m.workspaceId);
  redirect("/admin");
}

/** ساخت فضای کاری دیگر برای کاربر فعلی (مثلاً برای یک فروشگاه دوم) */
export async function createWorkspaceAction(formData: FormData) {
  const user = await requireUser();
  const name = String(formData.get("name") || "").trim();
  if (!rateLimit(`ws:create:${user.id}`, 5, 3600_000).ok) redirect("/admin?denied=1");
  if (!name) redirect("/admin");
  const id = await withTransaction(async () => {
    const wsId = await createWorkspace(user.id, name);
    await logAudit({ action: "workspace.created", workspaceId: wsId, userId: user.id, detail: name });
    return wsId;
  });
  await setActiveWorkspaceCookie(id);
  redirect("/admin");
}

export async function inviteMemberAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const admin = await requireTeam("team");
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const role = String(formData.get("role") || "member");
  if (!EMAIL_RE.test(email)) return { error: "ایمیل معتبر نیست" };
  if (!isTeamRole(role) || role === "owner") return { error: "نقش نامعتبر است" };
  if (!canManageRole(admin.wsRole, "member", role) && admin.wsRole !== "owner") return { error: "فقط مالک می‌تواند «مدیر» تعیین کند" };
  if (!rateLimit(`invite:${admin.workspaceId}`, 30, 3600_000).ok) return { error: "تعداد دعوت‌ها در ساعت زیاد است" };

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    const [m] = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, admin.workspaceId), eq(workspaceMembers.userId, existing.id)));
    if (m && isTeamRole(m.role)) return { error: "این کاربر قبلاً عضو تیم است" };
  }
  try {
    await assertCanAddMember(admin.workspaceId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "سقف اعضای تیم" };
  }
  // ساخت دعوت‌نامه + لاگ ممیزی اتمی‌اند؛ ارسال ایمیل (کار شبکه‌ای) پس از commit انجام می‌شود
  const token = await withTransaction(async () => {
    const t = await createInvite(admin.workspaceId, email, role, admin.id);
    await logAudit({ action: "member.invited", workspaceId: admin.workspaceId, userId: admin.id, detail: `${email} — ${ROLE_LABELS[role]}` });
    return t;
  });
  const base = ((await getSetting("app_url", admin.workspaceId)) || (await getOrigin())).replace(/\/+$/, "");
  if (!base) return { error: "آدرس سایت (APP_URL) روی سرور تنظیم نشده است؛ لینک دعوت ساخته نشد." };
  const link = `${base}/invite/${token}`;
  await sendMail({
    to: email,
    subject: `دعوت به فضای کاری «${admin.workspaceName}»`,
    html: `<div dir="rtl"><p>${escapeHtml(admin.name)} شما را با نقش «${ROLE_LABELS[role]}» به فضای کاری «${escapeHtml(admin.workspaceName)}» دعوت کرده است.</p><p><a href="${link}">${link}</a></p><p>این دعوت ۷ روز معتبر است.</p></div>`,
    workspaceId: admin.workspaceId,
  });
  revalidatePath("/admin/team");
  return { ok: true, message: "دعوت‌نامه ساخته و ایمیل شد. در صورت نیاز لینک را مستقیماً برای فرد بفرستید:", link };
}

export async function revokeInviteAction(formData: FormData) {
  const admin = await requireTeam("team");
  const id = Number(formData.get("id"));
  if (Number.isInteger(id)) await db.delete(workspaceInvites).where(and(eq(workspaceInvites.id, id), eq(workspaceInvites.workspaceId, admin.workspaceId)));
  revalidatePath("/admin/team");
}

export async function changeRoleAction(formData: FormData) {
  const admin = await requireTeam("team");
  const memberId = Number(formData.get("memberId"));
  const role = String(formData.get("role") || "");
  if (!Number.isInteger(memberId) || !isTeamRole(role)) return;
  const [m] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, admin.workspaceId)));
  // مالک هرگز تنزل نمی‌یابد؛ هر کس فقط نقش‌هایی را که اجازه دارد تغییر می‌دهد
  if (!m || m.role === "owner" || m.userId === admin.id || !canManageRole(admin.wsRole, m.role, role)) return;
  await db.update(workspaceMembers).set({ role }).where(eq(workspaceMembers.id, m.id));
  await logAudit({ action: "member.role_changed", workspaceId: admin.workspaceId, userId: admin.id, detail: `کاربر #${m.userId}: ${ROLE_LABELS[m.role as MemberRole]} ← ${ROLE_LABELS[role]}` });
  revalidatePath("/admin/team");
}

export async function removeMemberAction(formData: FormData) {
  const admin = await requireTeam("team");
  const memberId = Number(formData.get("memberId"));
  if (!Number.isInteger(memberId)) return;
  const [m] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, admin.workspaceId)));
  if (!m || m.role === "owner" || m.userId === admin.id || !canManageRole(admin.wsRole, m.role)) return;
  await db.delete(workspaceMembers).where(eq(workspaceMembers.id, m.id));
  await logAudit({ action: "member.removed", workspaceId: admin.workspaceId, userId: admin.id, detail: `کاربر #${m.userId}` });
  revalidatePath("/admin/team");
  revalidatePath("/admin/customers");
}

/** افزودن مشتری: حساب ساخته می‌شود و لینک تعیین رمز برایش ایمیل می‌شود */
export async function addClientAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const admin = await requireTeam("write");
  const name = String(formData.get("name") || "").trim();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const mobile = String(formData.get("mobile") || "").trim();
  if (!EMAIL_RE.test(email)) return { error: "ایمیل معتبر نیست" };
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!exists) {
    if (!name) return { error: "نام مشتری را وارد کنید" };
    if (!/^09\d{9}$/.test(mobile)) return { error: "موبایل باید به‌صورت 09xxxxxxxxx باشد (برای OTP امضا)" };
  }
  // حساب مشتری + عضویت + توکن تعیین رمز + لاگ ممیزی یک واحد اتمی‌اند؛ ایمیل پس از commit ارسال می‌شود
  const added = await withTransaction(async () => {
    const r = await ensureClient(admin.workspaceId, { name, email, mobile, invitedBy: admin.id });
    if (r.consentRequired) {
      await logAudit({ action: "client.consent_requested", workspaceId: admin.workspaceId, userId: admin.id, detail: email });
      return { consent: true as const, inviteToken: r.inviteToken };
    }
    if (!r.created && !r.linked) return null;
    const resetToken = r.created ? await createResetToken(r.userId, 24 * 7) : null;
    await logAudit({ action: "client.added", workspaceId: admin.workspaceId, userId: admin.id, detail: email });
    return { consent: false as const, created: r.created, resetToken };
  });
  if (!added) return { error: "این مشتری قبلاً در این فضای کاری ثبت شده است" };
  if (added.consent) {
    // SEC-06: حساب موجود فقط با رضایت صاحبش عضو می‌شود؛ هیچ اطلاعاتی از آن حساب نمایش داده نمی‌شود
    if (added.inviteToken) {
      // فقط آدرس مورد اعتماد سرور؛ نه app_url قابل‌تنظیم توسط مدیر فضای کاری (ضد فیشینگ به قربانی)
      await sendClientConsentEmail({ workspaceId: admin.workspaceId, email, token: added.inviteToken, base: await getOrigin() });
    }
    return { ok: true, message: "برای حفظ حریم خصوصی، این ایمیل باید ابتدا درخواست شما را بپذیرد. یک ایمیل تأیید برای صاحب حساب ارسال شد؛ پس از پذیرش در فهرست مشتریان دیده می‌شود." };
  }
  const { created } = added;
  let link: string | undefined;
  if (added.resetToken) {
    const base = ((await getSetting("app_url", admin.workspaceId)) || (await getOrigin())).replace(/\/+$/, "");
    link = base ? `${base}/reset/${added.resetToken}` : undefined;
    if (link) {
      await sendMail({
        to: email,
        subject: `حساب شما در «${admin.workspaceName}» ساخته شد`,
        html: `<div dir="rtl"><p>${escapeHtml(name)} عزیز، برای امضای آنلاین قراردادها رمز عبور خود را تعیین کنید:</p><p><a href="${link}">${link}</a></p><p>این لینک ۷ روز معتبر است.</p></div>`,
        workspaceId: admin.workspaceId,
      });
    }
  }
  revalidatePath("/admin/customers");
  return { ok: true, message: created ? "مشتری افزوده شد و لینک تعیین رمز برایش ایمیل شد." : "حساب موجود به فضای کاری شما اضافه شد.", link: link && showDevLinks() ? link : undefined };
}
