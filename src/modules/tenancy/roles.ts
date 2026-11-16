/**
 * نقش‌ها و سطوح دسترسی فضای کاری (بدون وابستگی به سرور؛ قابل استفاده در کلاینت)
 *
 *  owner  — مالک: همه‌چیز، از جمله مدیریت اعضا و نقش‌ها
 *  admin  — مدیر: تنظیمات، حذف، لغو، وب‌هوک، API و دعوت عضو (به‌جز تغییر مالک/مدیر)
 *  member — عضو: صدور قرارداد، قالب، مشتریان، یادآوری و دستیار هوش مصنوعی
 *  viewer — ناظر: فقط مشاهده (گزارش‌ها و قراردادها)
 *  client — مشتری/امضاکننده‌ی خارجی؛ فقط به قراردادهای خودش دسترسی دارد
 */
export const TEAM_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export type MemberRole = TeamRole | "client";

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: "مالک",
  admin: "مدیر",
  member: "عضو",
  viewer: "ناظر (فقط مشاهده)",
  client: "مشتری",
};

export const ROLE_HINTS: Record<TeamRole, string> = {
  owner: "دسترسی کامل از جمله مدیریت اعضای تیم",
  admin: "تنظیمات، حذف و لغو، وب‌هوک و کلید API",
  member: "صدور قرارداد، ساخت قالب، مشتریان و دستیار هوشمند",
  viewer: "فقط مشاهده‌ی قراردادها، گزارش‌ها و لاگ‌ها",
};

export type Permission = "view" | "write" | "delete" | "settings" | "team";

const MATRIX: Record<Permission, TeamRole[]> = {
  view: ["owner", "admin", "member", "viewer"],
  write: ["owner", "admin", "member"],
  delete: ["owner", "admin"],
  settings: ["owner", "admin"],
  team: ["owner", "admin"],
};

export function isTeamRole(r: string): r is TeamRole {
  return (TEAM_ROLES as readonly string[]).includes(r);
}

export function can(role: string | null | undefined, perm: Permission): boolean {
  return !!role && isTeamRole(role) && MATRIX[perm].includes(role);
}

/** آیا actor مجاز است نقش target را به next تغییر دهد یا عضو را حذف کند؟ */
export function canManageRole(actor: string, target: string, next?: string): boolean {
  if (!can(actor, "team")) return false;
  if (actor === "owner") return true;
  // مدیر فقط عضو/ناظر/مشتری را مدیریت می‌کند و نمی‌تواند مالک یا مدیر بسازد
  const low = ["member", "viewer", "client"];
  return low.includes(target) && (next === undefined || low.includes(next));
}
