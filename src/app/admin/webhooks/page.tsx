import Shell from "@/components/Shell";
import { WebhookForm, EndpointActions, RetryAllButton, RetryButton } from "@/components/WebhookForm";
import { requireTeam } from "@/modules/tenancy/context";
import { listEndpointsSafe, recentDeliveries } from "@/modules/webhooks/service";
import { EVENTS, PROVIDERS } from "@/modules/webhooks/meta";
import { faTime } from "@/lib/jalali";
import { explainDeliveryError } from "@/modules/webhooks/explain";

export const dynamic = "force-dynamic";

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

const evLabel = (id: string) => EVENTS.find((e) => e.id === id)?.label ?? id;

export default async function WebhooksPage() {
  const admin = await requireTeam("settings");
  const [endpoints, deliveries] = await Promise.all([listEndpointsSafe(admin.workspaceId), recentDeliveries(admin.workspaceId, 25)]);
  const retryableCount = deliveries.filter((d) => d.status !== "ok" && d.retryable).length;
  return (
    <Shell user={admin}>
      <h1 className="mb-1 text-2xl font-black">اعلان پیام‌رسان‌ها</h1>
      <p className="mb-4 text-xs text-ink/72">رویدادهای قرارداد را به تلگرام، بله، روبیکا یا هر سیستم دیگر (وب‌هوک JSON) ارسال کنید. متن پیام‌ها هرگز شامل کد تایید یا اطلاعات تماس نیست.</p>

      <div className="space-y-3">
        {endpoints.map((e) => (
          <div key={e.id} className="panel-solid flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="min-w-0">
              <b className="text-sm">{e.name}</b>
              <span className={`badge mr-2 ${e.active ? "bg-emerald-50 text-emerald-800" : "bg-stone-100 text-stone-600"}`}>{e.active ? "فعال" : "غیرفعال"}</span>
              {e.active && e.health.last === "ok" && <span className="badge mr-1 bg-emerald-50 text-emerald-800" data-health="ok">آخرین ارسال موفق</span>}
              {e.active && e.health.last === "queued" && <span className="badge mr-1 bg-amber-50 text-amber-800" data-health="queued">در صف تلاش مجدد</span>}
              {e.active && e.health.last === "dead" && <span className="badge mr-1 bg-rose-50 text-rose-700" data-health="dead">نیازمند اصلاح</span>}
              {e.active && e.health.last === "none" && <span className="badge mr-1 bg-stone-100 text-stone-600" data-health="none">هنوز ارسالی نشده — «تست» بزنید</span>}
              <div className="mt-1 text-xs text-ink/72">
                {PROVIDERS.find((p) => p.id === e.provider)?.label} • {e.provider === "generic" ? "" : "مقصد: "}
                <span dir="ltr" className="font-mono">{e.provider === "generic" ? hostOf(e.target) : e.target}</span>
                {e.hasSecret && " • توکن/کلید ثبت شده"} • {e.events === "*" ? "همه‌ی رویدادها" : e.events.split(",").map(evLabel).join("، ")}
              </div>
              {(e.health.okCount > 0 || e.health.badCount > 0) && (
                <div className="mt-1 text-[11px] text-ink/65">۷ روز اخیر: {e.health.okCount.toLocaleString("fa-IR")} موفق • {e.health.badCount.toLocaleString("fa-IR")} ناموفق{e.health.lastAt ? ` • آخرین تلاش: ${faTime(e.health.lastAt)}` : ""}</div>
              )}
              {e.active && e.health.explained && (
                <p className="mt-2 max-w-xl rounded-xl bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900" data-testid="endpoint-explained">
                  <b>{e.health.explained.title}.</b> {e.health.explained.hint}
                </p>
              )}
              {!e.active && <p className="mt-2 text-xs text-ink/65">این مقصد غیرفعال است و هیچ پیامی دریافت نمی‌کند.</p>}
            </div>
            <EndpointActions id={e.id} active={e.active} endpoint={{ id: e.id, name: e.name, provider: e.provider, target: e.target, baseUrl: e.baseUrl, events: e.events, active: e.active }} />
          </div>
        ))}
        {endpoints.length === 0 && <div className="panel-solid p-8 text-center text-xs text-ink/72">هنوز مقصدی تعریف نشده است.</div>}
      </div>

      <div className="mt-5"><WebhookForm /></div>

      <details className="card mt-5 text-xs leading-7">
        <summary className="cursor-pointer text-sm font-bold">راهنمای گیرنده‌ی وب‌هوک عمومی: راستی‌آزمایی امضا</summary>
        <p className="mt-3">هر درخواست <code dir="ltr">POST</code> با بدنه‌ی JSON می‌آید و دو هدر مهم دارد: <code dir="ltr">X-Emzagar-Signature: sha256=…</code> (HMAC-SHA256 کل بدنه با کلید شما) و <code dir="ltr">X-Emzagar-Delivery</code> (شناسه‌ی یکتا؛ برای حذف تکراری‌ها در تلاش‌های مجدد). پاسخ <code dir="ltr">2xx</code> یعنی «دریافت شد»؛ هر پاسخ دیگر دوباره تلاش می‌شود.</p>
        <pre dir="ltr" className="mt-3 overflow-x-auto rounded-xl bg-ink p-3 text-left text-[11px] leading-6 text-mint">{`// PHP (وردپرس)
$body = file_get_contents('php://input');
$sig  = 'sha256=' . hash_hmac('sha256', $body, $secret);
if (!hash_equals($sig, $_SERVER['HTTP_X_EMZAGAR_SIGNATURE'] ?? '')) { http_response_code(401); exit; }

// Node.js
const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(req.headers['x-emzagar-signature'] || ''))) return res.sendStatus(401);`}</pre>
      </details>

      <section className="panel-solid mt-5 overflow-x-auto">
        <h2 className="px-5 pt-5 font-bold">آخرین ارسال‌ها</h2>
        <RetryAllButton count={retryableCount} />
        <table className="w-full">
          <thead><tr><th className="th">زمان</th><th className="th">مقصد</th><th className="th">رویداد</th><th className="th">نتیجه</th><th className="th">تلاش</th></tr></thead>
          <tbody>
            {deliveries.map((d) => (
              <tr key={d.id} className="border-t border-ink/[.07]">
                <td className="td whitespace-nowrap text-xs">{faTime(d.createdAt)}</td>
                <td className="td text-xs">{d.endpointName ?? "—"}</td>
                <td className="td text-xs">{evLabel(d.event)}</td>
                <td className={`td text-xs ${d.status === "ok" ? "text-emerald-700" : d.status === "failed" ? "text-amber-700" : "text-rose-600"}`}>
                  {d.status === "ok" ? "موفق" : (
                    <>
                      <b>{d.status === "failed" ? `در صف تلاش مجدد${d.nextRetryAt ? ` (تلاش بعدی: ${faTime(d.nextRetryAt)})` : ""}` : d.event === "test" ? "آزمایش ناموفق" : "ناموفق (متوقف شد)"}</b>
                      {d.error && (() => {
                        const x = explainDeliveryError(d.error, d.provider);
                        return (
                          <span className="mt-0.5 block leading-6">
                            {x.title}. {x.hint}
                            <span dir="ltr" className="mr-1 font-mono text-[10px] text-ink/55">({x.raw})</span>
                          </span>
                        );
                      })()}
                    </>
                  )}
                </td>
                <td className="td whitespace-nowrap text-xs">
                  {d.attempts.toLocaleString("fa-IR")}×
                  {d.status !== "ok" && d.retryable && (
                    <RetryButton id={d.id} />
                  )}
                </td>
              </tr>
            ))}
            {deliveries.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-xs text-ink/72">هنوز ارسالی انجام نشده است.</td></tr>}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}
