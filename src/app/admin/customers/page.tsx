import Link from "next/link";
import { Trash2, Users } from "lucide-react";
import Shell from "@/components/Shell";
import ConfirmButton from "@/components/ConfirmButton";
import { AddClientForm } from "@/components/TeamForms";
import { AddGuestForm } from "@/components/GuestForms";
import { requireTeam } from "@/modules/tenancy/context";
import { listWorkspaceUsers } from "@/modules/tenancy/service";
import { can } from "@/modules/tenancy/roles";
import { removeMemberAction } from "@/modules/tenancy/actions";
import { fa } from "@/lib/jalali";

export const dynamic = "force-dynamic";

export default async function CustomersPage() {
  const admin = await requireTeam("view");
  const clients = (await listWorkspaceUsers(admin.workspaceId)).filter((u) => u.role === "client");
  const canWrite = can(admin.wsRole, "write");
  const canManage = can(admin.wsRole, "team");
  return (
    <Shell user={admin}>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><Users size={22} />مشتریان</h1>
      <p className="mb-5 text-xs text-ink/72">طرف‌های قرارداد شما؛ فقط قراردادهای خودشان را می‌بینند و هر مشتری فقط در همین فضای کاری شما دیده می‌شود.</p>

      {canWrite && (
        <section className="card mb-5 border-emerald-200 bg-emerald-50/40">
          <h2 className="mb-1 font-bold">افزودن امضاکننده‌ی مهمان <span className="mr-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">بدون ثبت‌نام</span></h2>
          <p className="mb-3 text-xs leading-6 text-ink/72">فقط نام و موبایل. او لینک امضا را دریافت می‌کند و با کد پیامکی، قرارداد را می‌بیند و امضا می‌کند؛ نیازی به ایمیل، رمز یا حساب کاربری نیست.</p>
          <AddGuestForm />
        </section>
      )}

      {canWrite && (
        <section className="card mb-5">
          <h2 className="mb-3 font-bold">افزودن مشتری با حساب کاربری</h2>
          <AddClientForm />
          <p className="mt-3 text-xs leading-6 text-ink/72">برای مشتری جدید ایمیل «تعیین رمز» ارسال می‌شود. موبایل برای کد تأیید امضا الزامی است.</p>
        </section>
      )}

      <section className="panel-solid overflow-x-auto">
        <table className="w-full">
          <thead className="bg-stone-50/80">
            <tr><th className="th">نام</th><th className="th">ایمیل</th><th className="th">موبایل</th><th className="th">افزوده‌شده</th><th className="th">عملیات</th></tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="border-t border-ink/[.07]">
                <td className="td font-bold">{c.name}{c.isGuest && <span className="mr-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">مهمان</span>}</td>
                <td className="td text-xs" dir="ltr">{c.isGuest ? "—" : c.email}</td>
                <td className="td text-xs" dir="ltr">{c.mobile || "—"}</td>
                <td className="td whitespace-nowrap text-xs">{fa(c.joinedAt)}</td>
                <td className="td">
                  <div className="flex gap-2">
                    {canWrite && <Link href={`/admin/new?customer=${c.id}`} className="btn-secondary btn-sm">صدور قرارداد</Link>}
                    {canManage && (
                      <form action={removeMemberAction}>
                        <input type="hidden" name="memberId" value={c.memberId} />
                        <ConfirmButton message={`«${c.name}» از مشتریان حذف شود؟ قراردادهای قبلی باقی می‌مانند.`} className="btn-danger btn-sm"><Trash2 size={14} />حذف</ConfirmButton>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {clients.length === 0 && <tr><td colSpan={5} className="py-14 text-center text-xs text-ink/72">هنوز مشتری‌ای ثبت نشده است. از فرم بالا اولین مشتری را اضافه کنید.</td></tr>}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}
