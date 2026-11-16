import Shell from "@/components/Shell";
import AutomationForm from "@/components/AutomationForm";
import { requireTeam } from "@/modules/tenancy/context";
import { getAllSettings } from "@/modules/settings/service";
import { recentRuns } from "@/modules/automation/service";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";

export default async function AutomationPage() {
  const admin = await requireTeam("settings");
  const [settings, runs] = await Promise.all([getAllSettings(admin.workspaceId), recentRuns(10)]);
  return (
    <Shell user={admin}>
      <h1 className="mb-1 text-2xl font-black">یادآوری و انقضا</h1>
      <p className="mb-4 text-xs text-ink/72">قراردادهای امضا نشده به‌صورت خودکار یادآوری می‌شوند و پس از مهلت، منقضی می‌شوند.</p>
      <AutomationForm s={settings} />

      <section className="card mt-5 space-y-2">
        <h2 className="font-bold">زمان‌بندی (Cron)</h2>
        <p className="text-xs leading-7 text-ink/75">
          زمان‌بند داخلی پلتفرم به‌طور خودکار و برای همه‌ی فضاهای کاری، هر چند دقیقه یک‌بار اجرا می‌شود و تنظیمات بالا فقط برای فضای کاری شما اعمال می‌شود.
          دکمه‌ی «اجرای دستی» هم فقط قراردادهای همین فضای کاری را پردازش می‌کند. کلید فراخوان HTTP یک تنظیم سراسری است و در اختیار مدیر پلتفرم قرار دارد.
        </p>
      </section>

      <section className="panel-solid mt-5 overflow-x-auto">
        <h2 className="px-5 pt-5 font-bold">آخرین اجراها</h2>
        <table className="w-full">
          <thead>
            <tr><th className="th">زمان</th><th className="th">منبع</th><th className="th">وضعیت</th></tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-ink/[.07]">
                <td className="td whitespace-nowrap text-xs">{faTime(r.createdAt)}</td>
                <td className="td text-xs">{r.trigger === "scheduler" ? "زمان‌بند داخلی" : r.trigger === "http" ? "فراخوان HTTP" : "دستی"}</td>
                <td className="td text-xs">{r.error ? <span className="text-rose-600">خطا</span> : "موفق"}</td>
              </tr>
            ))}
            {runs.length === 0 && <tr><td colSpan={3} className="py-10 text-center text-xs text-ink/72">هنوز اجرایی ثبت نشده است.</td></tr>}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}
