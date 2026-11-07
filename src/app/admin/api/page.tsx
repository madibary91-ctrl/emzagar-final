import { desc, eq } from "drizzle-orm";
import Shell from "@/components/Shell";
import ApiKeyForm from "@/components/ApiKeyForm";
import { db } from "@/db";
import { apiKeys, templates } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { revokeKeyAction } from "@/modules/api/actions";
import { getSetting } from "@/modules/settings/service";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";

export default async function ApiPage() {
  const admin = await requireTeam("settings");
  const [keys, tpls, appUrl] = await Promise.all([
    db.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, active: apiKeys.active, lastUsedAt: apiKeys.lastUsedAt, createdAt: apiKeys.createdAt }).from(apiKeys).where(eq(apiKeys.workspaceId, admin.workspaceId)).orderBy(desc(apiKeys.createdAt)),
    db.select({ id: templates.id, title: templates.title }).from(templates).where(eq(templates.workspaceId, admin.workspaceId)),
    getSetting("app_url", admin.workspaceId),
  ]);
  const base = appUrl.replace(/\/+$/, "") || "https://YOUR-DOMAIN";
  const example = `curl -X POST ${base}/api/v1/contracts \\
  -H "Authorization: Bearer emz_..." -H "Content-Type: application/json" \\
  -d '{"templateId": ${tpls[0]?.id ?? 1}, "customer": {"name": "علی رضایی", "email": "ali@example.com", "mobile": "09121111111"}, "expiryDays": 14}'`;
  return (
    <Shell user={admin}>
      <h1 className="mb-1 text-2xl font-black">API و اتصال به سیستم‌های دیگر</h1>
      <p className="mb-4 text-xs text-ink/72">فروشگاه، CRM یا نرم‌افزار حسابداری شما می‌تواند قرارداد صادر کند و وضعیت امضا را پیگیری کند.</p>
      <ApiKeyForm />

      <section className="panel-solid mt-5 overflow-x-auto">
        <h2 className="px-5 pt-5 font-bold">کلیدهای ساخته‌شده</h2>
        <table className="w-full">
          <thead><tr><th className="th">نام</th><th className="th">پیشوند</th><th className="th">آخرین استفاده</th><th className="th">وضعیت</th><th className="th"></th></tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="border-t border-ink/[.07]">
                <td className="td">{k.name}</td>
                <td className="td font-mono text-xs" dir="ltr">{k.prefix}…</td>
                <td className="td text-xs">{k.lastUsedAt ? faTime(k.lastUsedAt) : "—"}</td>
                <td className="td text-xs">{k.active ? "فعال" : "باطل‌شده"}</td>
                <td className="td">
                  {k.active && (
                    <form action={revokeKeyAction}>
                      <input type="hidden" name="id" value={k.id} />
                      <button className="btn-danger btn-sm">ابطال</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {keys.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-xs text-ink/72">کلیدی ساخته نشده است.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card mt-5 space-y-3">
        <h2 className="font-bold">مستندات سریع</h2>
        <p className="text-xs leading-7 text-ink/75">
          <b>POST /api/v1/contracts</b> — صدور قرارداد از روی قالب (فیلد draft=true برای ساخت پیش‌نویس). اگر مشتری با این ایمیل وجود نداشته باشد، با نام و موبایل ساخته می‌شود.<br />
          <b>GET /api/v1/contracts/{"{id}"}</b> — وضعیت قرارداد، امضاکنندگان و لینک کوتاه.<br />
          <b>GET /api/v1/contracts?email=&amp;status=&amp;page=&amp;limit=</b> — فهرست قراردادها (فیلتر بر اساس ایمیل مشتری).<br />
          <b>GET /api/v1/templates</b> و <b>GET /api/v1/stats</b> — قالب‌ها و آمار/تست اتصال. محدودیت: ۶۰ درخواست در دقیقه برای هر کلید.
        </p>
        <pre dir="ltr" className="thin-scroll overflow-x-auto rounded-2xl bg-stone-50 p-4 text-xs leading-6">{example}</pre>
        <p className="rounded-xl bg-emerald-50 p-3 text-xs leading-7 text-emerald-800">
          <b>افزونه‌ی وردپرس / ووکامرس / المنتور:</b> دیگر نیازی به ساخت یا کپی کلید نیست؛ افزونه را از صفحه‌ی <a href="/admin/wordpress" className="font-bold underline">وردپرس و ووکامرس</a> دانلود و فعال کنید تا خودکار وصل شود. این صفحه فقط برای اتصال سیستم‌های دیگر (CRM، حسابداری و …) است.
        </p>
        <p className="text-xs text-ink/72">شناسه‌ی قالب‌ها: {tpls.map((t) => `${t.id} = ${t.title}`).join(" • ")}</p>
      </section>
    </Shell>
  );
}
