import Shell from "@/components/Shell";
import { WebhookForm, EndpointActions } from "@/components/WebhookForm";
import { requireTeam } from "@/modules/tenancy/context";
import { listEndpointsSafe, recentDeliveries } from "@/modules/webhooks/service";
import { EVENTS, PROVIDERS } from "@/modules/webhooks/meta";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";

const evLabel = (id: string) => EVENTS.find((e) => e.id === id)?.label ?? id;

export default async function WebhooksPage() {
  const admin = await requireTeam("settings");
  const [endpoints, deliveries] = await Promise.all([listEndpointsSafe(admin.workspaceId), recentDeliveries(admin.workspaceId, 25)]);
  return (
    <Shell user={admin}>
      <h1 className="mb-1 text-2xl font-black">اعلان پیام‌رسان‌ها</h1>
      <p className="mb-4 text-xs text-ink/72">رویدادهای قرارداد را به تلگرام، بله، روبیکا یا هر سیستم دیگر (وب‌هوک JSON) ارسال کنید. متن پیام‌ها هرگز شامل کد تایید یا اطلاعات تماس نیست.</p>

      <div className="space-y-3">
        {endpoints.map((e) => (
          <div key={e.id} className="panel-solid flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <b className="text-sm">{e.name}</b>
              <span className={`badge mr-2 ${e.active ? "bg-emerald-50 text-emerald-800" : "bg-stone-100 text-stone-600"}`}>{e.active ? "فعال" : "غیرفعال"}</span>
              <div className="mt-1 text-xs text-ink/72">
                {PROVIDERS.find((p) => p.id === e.provider)?.label} • {e.provider === "generic" ? "" : "مقصد: "}
                <span dir="ltr" className="font-mono">{e.provider === "generic" ? new URL(e.target).host : e.target}</span>
                {e.hasSecret && " • توکن ثبت شده"} • {e.events === "*" ? "همه‌ی رویدادها" : e.events.split(",").map(evLabel).join("، ")}
              </div>
            </div>
            <EndpointActions id={e.id} active={e.active} />
          </div>
        ))}
        {endpoints.length === 0 && <div className="panel-solid p-8 text-center text-xs text-ink/72">هنوز مقصدی تعریف نشده است.</div>}
      </div>

      <div className="mt-5"><WebhookForm /></div>

      <section className="panel-solid mt-5 overflow-x-auto">
        <h2 className="px-5 pt-5 font-bold">آخرین ارسال‌ها</h2>
        <table className="w-full">
          <thead><tr><th className="th">زمان</th><th className="th">مقصد</th><th className="th">رویداد</th><th className="th">نتیجه</th></tr></thead>
          <tbody>
            {deliveries.map((d) => (
              <tr key={d.id} className="border-t border-ink/[.07]">
                <td className="td whitespace-nowrap text-xs">{faTime(d.createdAt)}</td>
                <td className="td text-xs">{d.endpointName ?? "—"}</td>
                <td className="td text-xs">{evLabel(d.event)}</td>
                <td className={`td text-xs ${d.status === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{d.status === "ok" ? "موفق" : `ناموفق: ${d.error ?? ""}`}</td>
              </tr>
            ))}
            {deliveries.length === 0 && <tr><td colSpan={4} className="py-10 text-center text-xs text-ink/72">هنوز ارسالی انجام نشده است.</td></tr>}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}
