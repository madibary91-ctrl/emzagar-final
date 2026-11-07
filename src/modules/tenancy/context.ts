import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaceMembers, workspaces } from "@/db/schema";
import { getCurrentUser, isSecureRequest, type SessionUser } from "@/modules/auth/session";
import { can, isTeamRole, type MemberRole, type Permission, type TeamRole } from "./roles";

export const WS_COOKIE = "amz_ws";

export type Membership = { workspaceId: number; role: MemberRole; name: string; slug: string };

/** کاربر + فضای کاری فعال + نقش او در آن */
export type TeamUser = SessionUser & {
  workspaceId: number;
  wsRole: TeamRole;
  workspaceName: string;
  /** فضاهای کاری که کاربر عضو تیم آن‌هاست (برای تعویض فضا) */
  teamWorkspaces: { id: number; name: string; role: TeamRole }[];
};

const currentUser = cache(getCurrentUser);

export const getMemberships = cache(async (userId: number): Promise<Membership[]> => {
  const rows = await db
    .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role, name: workspaces.name, slug: workspaces.slug })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.name));
  return rows.map((r) => ({ ...r, role: r.role as MemberRole }));
});

/**
 * فضای کاری فعال از کوکی خوانده می‌شود، اما هر بار عضویت واقعی در دیتابیس بررسی می‌شود؛
 * یعنی دستکاری کوکی هرگز دسترسی ایجاد نمی‌کند.
 */
export const getTeamContext = cache(async (): Promise<TeamUser | null> => {
  const user = await currentUser();
  if (!user) return null;
  const teams = (await getMemberships(user.id)).filter((m) => isTeamRole(m.role));
  if (teams.length === 0) return null;
  const jar = await cookies();
  const wanted = Number(jar.get(WS_COOKIE)?.value);
  const active = teams.find((m) => m.workspaceId === wanted) ?? teams[0];
  return {
    ...user,
    workspaceId: active.workspaceId,
    wsRole: active.role as TeamRole,
    workspaceName: active.name,
    teamWorkspaces: teams.map((m) => ({ id: m.workspaceId, name: m.name, role: m.role as TeamRole })),
  };
});

/**
 * ورودی همه‌ی صفحه‌ها و اکشن‌های پنل مدیریت.
 * کاربر بدون عضویت تیمی (مشتری) به نمای کاربری هدایت می‌شود.
 */
export async function requireTeam(perm: Permission = "view"): Promise<TeamUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  const ctx = await getTeamContext();
  if (!ctx) redirect("/dashboard");
  if (!can(ctx.wsRole, perm)) redirect("/admin?denied=1");
  return ctx;
}

/** نسخه‌ی مخصوص Route Handler ها: به‌جای ریدایرکت، null برمی‌گرداند */
export async function getTeamForApi(perm: Permission = "view"): Promise<TeamUser | null> {
  const ctx = await getTeamContext();
  if (!ctx || !can(ctx.wsRole, perm)) return null;
  return ctx;
}

export async function setActiveWorkspaceCookie(workspaceId: number) {
  const jar = await cookies();
  jar.set(WS_COOKIE, String(workspaceId), {
    httpOnly: true,
    sameSite: "lax",
    secure: await isSecureRequest(),
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

/** مقصد پس از ورود: تیم → پنل مدیریت؛ مشتری → قراردادهای من */
export async function homeFor(userId: number): Promise<string> {
  const ms = await getMemberships(userId);
  return ms.some((m) => isTeamRole(m.role)) ? "/admin" : "/dashboard";
}
