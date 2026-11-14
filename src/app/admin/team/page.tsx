import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { ShieldCheck, Trash2, UsersRound } from "lucide-react";
import Shell from "@/components/Shell";
import ConfirmButton from "@/components/ConfirmButton";
import { InviteMemberForm } from "@/components/TeamForms";
import { db } from "@/db";
import { workspaceInvites } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { listWorkspaceUsers } from "@/modules/tenancy/service";
import { canManageRole, can, isTeamRole, ROLE_HINTS, ROLE_LABELS, TEAM_ROLES, type MemberRole } from "@/modules/tenancy/roles";
import { changeRoleAction, removeMemberAction, revokeInviteAction } from "@/modules/tenancy/actions";
import { fa } from "@/lib/jalali";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const admin = await requireTeam("view");
  const canTeam = can(admin.wsRole, "team");
  const [all, invites] = await Promise.all([
    listWorkspaceUsers(admin.workspaceId),
    db
      .select()
      .from(workspaceInvites)
      .where(and(eq(workspaceInvites.workspaceId, admin.workspaceId), isNull(workspaceInvites.acceptedAt), gt(workspaceInvites.expiresAt, new Date())))
      .orderBy(desc(workspaceInvites.createdAt)),
  ]);
  const team = all.filter((m) => isTeamRole(m.role));

  return (
    <Shell user={admin}>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><UsersRound size={22} />تیم و دسترسی‌ها</h1>
      <p className="mb-5 text-xs text-ink/72">اعضای فضای کاری «{admin.workspaceName}» و سطح دسترسی هرکدام</p>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {TEAM_ROLES.map((r) => (
          <div key={r} className="panel-solid p-4">
            <b className="flex items-center gap-1.5 text-sm"><ShieldCheck size={15} className="text-ink/72" />{ROLE_LABELS[r]}</b>
            <p className="mt-1 text-xs leading-6 text-ink/75">{ROLE_HINTS[r]}</p>
          </div>
        ))}
      </div>

      {canTeam && (
        <section className="card mb-5">
          <h2 className="mb-3 font-bold">دعوت عضو جدید</h2>
          <InviteMemberForm isOwner={admin.wsRole === "owner"} />
        </section>
      )}

      <section className="panel-solid mb-5 overflow-x-auto">
        <table className="w-full">
          <thead className="bg-stone-50/80">
            <tr><th className="th">نام</th><th className="th">ایمیل</th><th className="th">نقش</th><th className="th">عضویت از</th>{canTeam && <th className="th">عملیات</th>}</tr>
          </thead>
          <tbody>
            {team.map((m) => {
              const editable = canTeam && m.role !== "owner" && m.id !== admin.id && canManageRole(admin.wsRole, m.role);
              return (
                <tr key={m.id} className="border-t border-ink/[.07]">
                  <td className="td font-bold">{m.name}{m.id === admin.id && <span className="badge mr-2 bg-mint/30">شما</span>}</td>
                  <td className="td text-xs" dir="ltr">{m.email}</td>
                  <td className="td">
                    {editable ? (
                      <form action={changeRoleAction} className="flex items-center gap-2">
                        <input type="hidden" name="memberId" value={m.memberId} />
                        <select name="role" defaultValue={m.role} className="input !min-h-9 !py-1 text-xs" aria-label="نقش">
                          {TEAM_ROLES.filter((r) => r !== "owner" && (admin.wsRole === "owner" || r !== "admin" || m.role === "admin")).map((r) => (
                            <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                          ))}
                        </select>
                        <button className="btn-secondary btn-sm">ذخیره</button>
                      </form>
                    ) : (
                      <span className="badge bg-stone-100 text-ink/70">{ROLE_LABELS[m.role as MemberRole]}</span>
                    )}
                  </td>
                  <td className="td whitespace-nowrap text-xs">{fa(m.joinedAt)}</td>
                  {canTeam && (
                    <td className="td">
                      {editable && (
                        <form action={removeMemberAction}>
                          <input type="hidden" name="memberId" value={m.memberId} />
                          <ConfirmButton message={`«${m.name}» از تیم حذف شود؟`} className="btn-danger btn-sm"><Trash2 size={14} />حذف</ConfirmButton>
                        </form>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {invites.length > 0 && (
        <section className="panel-solid overflow-x-auto">
          <h2 className="px-5 pt-5 font-bold">دعوت‌های در انتظار پذیرش</h2>
          <table className="w-full">
            <tbody>
              {invites.map((i) => (
                <tr key={i.id} className="border-t border-ink/[.07]">
                  <td className="td text-xs" dir="ltr">{i.email}</td>
                  <td className="td"><span className="badge bg-stone-100">{ROLE_LABELS[i.role as MemberRole]}</span></td>
                  <td className="td text-xs">تا {fa(i.expiresAt)}</td>
                  <td className="td">
                    {canTeam && (
                      <form action={revokeInviteAction}>
                        <input type="hidden" name="id" value={i.id} />
                        <button className="btn-secondary btn-sm">لغو دعوت</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </Shell>
  );
}
