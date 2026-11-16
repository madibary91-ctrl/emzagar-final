"use server";
import { MOBILE_HINT, parseIranMobile } from "@/lib/phone";

import { devSecretsVisible } from "@/lib/dev-flags";
import { redirect } from "next/navigation";
import { escapeHtml } from "@/lib/html";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db, lockScope, withTransaction } from "@/db";
import { users, workspaceInvites, workspaceMembers } from "@/db/schema";
import { requireUser } from "@/modules/auth/session";
import { createResetToken } from "@/modules/auth/tokens";
import { logAudit } from "@/modules/audit/service";
import { sendMail } from "@/modules/mail";
import { getOrigin } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { getMemberships, requireTeam, setActiveWorkspaceCookie } from "./context";
import { canManageRole, isTeamRole, ROLE_LABELS, type MemberRole } from "./roles";
import { createTeamInvite, TEAM_SEATS_LOCK } from "./invites";
import { sendClientConsentEmail } from "./client-consent";
import { assertCanAddMember, assertSeatFreeForAccept, PlanLimitError } from "@/modules/billing/service";
import { createWorkspace, ensureClient, EMAIL_RE } from "./service";
import { getSetting } from "@/modules/settings/service";

export type TeamState = { ok?: boolean; error?: string; message?: string; link?: string };
const showDevLinks = () => devSecretsVisible();

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

  const [existing] = await db.select({ id: users.id, isGuest: users.isGuest }).from(users).where(eq(users.email, email));
  if (existing?.isGuest) return { error: "ایمیل معتبر نیست" };
  if (existing) {
    const [m] = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, admin.workspaceId), eq(workspaceMembers.userId, existing.id)));
    if (m && isTeamRole(m.role)) return { error: "این کاربر قبلاً عضو تیم است" };
  }
  try {
    await assertCanAddMember(admin.workspaceId, { email });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "سقف اعضای تیم" };
  }
  // ساخت دعوت‌نامه + لاگ ممیزی اتمی‌اند؛ ارسال ایمیل (کار شبکه‌ای) پس از commit انجام می‌شود
  // سقف اعضا (اعضا + دعوت‌های باز) زیر قفل و داخل createTeamInvite دوباره سنجیده می‌شود (پیش‌سنجش بالا فقط برای پیام زودهنگام است)
  let token: string;
  try {
    token = await withTransaction(async () => {
      // دعوت دوباره برای همان ایمیل، دعوت‌های باز قبلی را جایگزین می‌کند (پیش‌تر چند ردیف تکراری با لینک‌های هم‌زمان می‌ماند)
      await db.delete(workspaceInvites).where(and(eq(workspaceInvites.workspaceId, admin.workspaceId), eq(workspaceInvites.email, email), isNull(workspaceInvites.acceptedAt), ne(workspaceInvites.role, "client")));
      const t = await createTeamInvite(admin.workspaceId, email, role, admin.id);
      await logAudit({ action: "member.invited", workspaceId: admin.workspaceId, userId: admin.id, detail: `${email} — ${ROLE_LABELS[role]}` });
      return t;
    });
  } catch (e) {
    if (e instanceof PlanLimitError) return { error: e.message };
    throw e;
  }
  const delivered = await deliverInvite(admin, email, role, token);
  if ("error" in delivered) return { error: delivered.error };
  revalidatePath("/admin/team");
  return { ok: true, message: "دعوت‌نامه ساخته و ایمیل شد. در صورت نیاز لینک را مستقیماً برای فرد بفرستید:", link: delivered.link };
}

/** ایمیل دعوت را می‌فرستد و لینک قابل‌کپی را برمی‌گرداند (ایمیل ممکن است به صندوق نرسد؛ لینک همیشه به مدیر داده می‌شود) */
async function deliverInvite(admin: { workspaceId: number; workspaceName: string; name: string }, email: string, role: string, token: string): Promise<{ link: string } | { error: string }> {
  const base = ((await getSetting("app_url", admin.workspaceId)) || (await getOrigin())).replace(/\/+$/, "");
  if (!base) return { error: "آدرس سایت (APP_URL) روی سرور تنظیم نشده است؛ لینک دعوت ساخته نشد." };
  const link = `${base}/invite/${token}`;
  await sendMail({
    to: email,
    subject: `دعوت به فضای کاری «${admin.workspaceName}»`,
    html: `<div dir="rtl"><p>${escapeHtml(admin.name)} شما را با نقش «${ROLE_LABELS[role as MemberRole]}» به فضای کاری «${escapeHtml(admin.workspaceName)}» دعوت کرده است.</p><p><a href="${link}">${link}</a></p><p>این دعوت ۷ روز معتبر است.</p></div>`,
    workspaceId: admin.workspaceId,
  });
  return { link };
}

async function revokeInviteCore(formData: FormData): Promise<TeamState> {
  const admin = await requireTeam("team");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { error: "دعوت‌نامه نامعتبر است" };
  const gone = await db.delete(workspaceInvites).where(and(eq(workspaceInvites.id, id), eq(workspaceInvites.workspaceId, admin.workspaceId))).returning({ email: workspaceInvites.email });
  revalidatePath("/admin/team");
  if (!gone.length) return { error: "این دعوت‌نامه دیگر وجود ندارد (شاید قبلاً لغو یا پذیرفته شده است)" };
  await logAudit({ action: "member.invite_revoked", workspaceId: admin.workspaceId, userId: admin.id, detail: gone[0].email });
  return { ok: true, message: `دعوت «${gone[0].email}» لغو شد` };
}

async function changeRoleCore(formData: FormData): Promise<TeamState> {
  const admin = await requireTeam("team");
  const memberId = Number(formData.get("memberId"));
  const role = String(formData.get("role") || "");
  if (!Number.isInteger(memberId) || !isTeamRole(role)) return { error: "نقش نامعتبر است" };
  // «مالک» از این مسیر ساخته نمی‌شود (UI هم نمی‌دهد؛ فرم دست‌ساز می‌توانست مالک دومِ تنزل‌ناپذیر بسازد)
  if (role === "owner") return { error: "نقش «مالک» از این بخش قابل واگذاری نیست" };
  const [m] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, admin.workspaceId)));
  if (!m) return { error: "این عضو دیگر در تیم نیست؛ صفحه را تازه کنید" };
  if (m.role === role) return { ok: true, message: "نقش همین بود؛ تغییری لازم نشد" };
  // مالک هرگز تنزل نمی‌یابد؛ هر کس فقط نقش‌هایی را که اجازه دارد تغییر می‌دهد
  if (m.role === "owner" || m.userId === admin.id || !canManageRole(admin.wsRole, m.role, role)) return { error: "شما اجازه‌ی تغییر نقش این عضو را ندارید" };
  // مهمان هرگز به نقش تیمی ارتقا نمی‌یابد (فرم دست‌ساز هم نمی‌تواند)؛ ارتقای مهمان فقط با تأیید OTP (upgradeGuestToUser)
  const [target] = await db.select({ isGuest: users.isGuest, name: users.name }).from(users).where(eq(users.id, m.userId));
  if (!target || target.isGuest) return { error: "این کاربر حساب کامل ندارد و نمی‌تواند عضو تیم شود" };
  // HX-01: ارتقای «مشتری» به نقش تیمی یک صندلی تیم می‌گیرد؛ بدون این سد، سقف اعضای طرح از این در دور زده می‌شد
  try {
    await withTransaction(async () => {
      if (!isTeamRole(m.role)) {
        await lockScope(TEAM_SEATS_LOCK, admin.workspaceId);
        await assertSeatFreeForAccept(admin.workspaceId);
      }
      await db.update(workspaceMembers).set({ role }).where(eq(workspaceMembers.id, m.id));
    });
  } catch (e) {
    if (e instanceof PlanLimitError) return { error: e.message };
    throw e;
  }
  await logAudit({ action: "member.role_changed", workspaceId: admin.workspaceId, userId: admin.id, detail: `کاربر #${m.userId}: ${ROLE_LABELS[m.role as MemberRole]} ← ${ROLE_LABELS[role]}` });
  revalidatePath("/admin/team");
  return { ok: true, message: `نقش «${target.name}» به «${ROLE_LABELS[role]}» تغییر کرد` };
}

async function removeMemberCore(formData: FormData): Promise<TeamState> {
  const admin = await requireTeam("team");
  const memberId = Number(formData.get("memberId"));
  if (!Number.isInteger(memberId)) return { error: "عضو نامعتبر است" };
  const [m] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, admin.workspaceId)));
  if (!m) return { error: "این عضو دیگر در تیم نیست؛ صفحه را تازه کنید" };
  if (m.role === "owner" || m.userId === admin.id || !canManageRole(admin.wsRole, m.role)) return { error: "شما اجازه‌ی حذف این عضو را ندارید" };
  await db.delete(workspaceMembers).where(eq(workspaceMembers.id, m.id));
  await logAudit({ action: "member.removed", workspaceId: admin.workspaceId, userId: admin.id, detail: `کاربر #${m.userId}` });
  revalidatePath("/admin/team");
  revalidatePath("/admin/customers");
  return { ok: true, message: "عضو از تیم حذف شد" };
}

/** نسخه‌های «فرم ساده» (بدون state)؛ سازگار با فراخوانی‌های قبلی */
export async function revokeInviteAction(formData: FormData) {
  await revokeInviteCore(formData);
}
export async function changeRoleAction(formData: FormData) {
  await changeRoleCore(formData);
}
export async function removeMemberAction(formData: FormData) {
  await removeMemberCore(formData);
}

/** نسخه‌های «با بازخورد» برای رابط کاربری: هر نتیجه (موفقیت یا دلیل رد) به کاربر نشان داده می‌شود */
export async function revokeInviteStateAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  return revokeInviteCore(formData);
}
export async function changeRoleStateAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  return changeRoleCore(formData);
}
export async function removeMemberStateAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  return removeMemberCore(formData);
}

/** ارسال دوباره‌ی دعوت (باز یا منقضی‌شده): دعوت قبلی باطل و دعوت تازه‌ی ۷ روزه ساخته می‌شود؛ لینک برای کپی برمی‌گردد */
export async function resendInviteAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const admin = await requireTeam("team");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { error: "دعوت‌نامه نامعتبر است" };
  if (!rateLimit(`invite:${admin.workspaceId}`, 30, 3600_000).ok) return { error: "تعداد دعوت‌ها در ساعت زیاد است" };
  const [old] = await db.select().from(workspaceInvites).where(and(eq(workspaceInvites.id, id), eq(workspaceInvites.workspaceId, admin.workspaceId), isNull(workspaceInvites.acceptedAt)));
  if (!old) return { error: "این دعوت‌نامه دیگر وجود ندارد (شاید پذیرفته یا لغو شده است)" };
  if (!isTeamRole(old.role) || old.role === "owner") return { error: "این دعوت از مسیر دیگری (تأیید مشتری) ارسال شده و از اینجا دوباره ارسال نمی‌شود" };
  if (old.role === "admin" && admin.wsRole !== "owner") return { error: "فقط مالک می‌تواند دعوت «مدیر» را دوباره بفرستد" };
  let token: string;
  try {
    token = await withTransaction(async () => {
      await db.delete(workspaceInvites).where(and(eq(workspaceInvites.workspaceId, admin.workspaceId), eq(workspaceInvites.email, old.email), isNull(workspaceInvites.acceptedAt), ne(workspaceInvites.role, "client")));
      const t = await createTeamInvite(admin.workspaceId, old.email, old.role, admin.id);
      await logAudit({ action: "member.invited", workspaceId: admin.workspaceId, userId: admin.id, detail: `${old.email} — ${ROLE_LABELS[old.role as MemberRole]} (ارسال دوباره)` });
      return t;
    });
  } catch (e) {
    if (e instanceof PlanLimitError) return { error: e.message };
    throw e;
  }
  const delivered = await deliverInvite(admin, old.email, old.role, token);
  if ("error" in delivered) return { error: delivered.error };
  revalidatePath("/admin/team");
  return { ok: true, message: `دعوت تازه برای «${old.email}» ساخته و ایمیل شد (۷ روز معتبر). لینک را هم می‌توانید مستقیم بفرستید:`, link: delivered.link };
}

/** افزودن مشتری: حساب ساخته می‌شود و لینک تعیین رمز برایش ایمیل می‌شود */
export async function addClientAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const admin = await requireTeam("write");
  const name = String(formData.get("name") || "").trim();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const mobile = parseIranMobile(formData.get("mobile")) ?? "";
  if (!EMAIL_RE.test(email)) return { error: "ایمیل معتبر نیست" };
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!exists) {
    if (!name) return { error: "نام مشتری را وارد کنید" };
    if (!mobile) return { error: `${MOBILE_HINT} — برای کد تأیید امضای مشتری لازم است` };
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
