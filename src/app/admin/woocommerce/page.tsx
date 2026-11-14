import Link from "next/link";
import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, FileSignature, KeyRound, Pause, Play, Radio, RefreshCw, RotateCw, ShoppingCart, TriangleAlert, Users, Wallet } from "lucide-react";
import Shell from "@/components/Shell";
import ConfirmButton from "@/components/ConfirmButton";
import LiveRefresh from "@/components/LiveRefresh";
import StatusBadge from "@/components/StatusBadge";
import { requireTeam } from "@/modules/tenancy/context";
import { listSyncedOrders, recentSyncLog, syncOverview, type Health } from "@/modules/sync/service";
import { pingSiteAction, resyncSiteAction, retryOutboxAction, rotateSecretAction, toggleSyncAction } from "@/modules/sync/actions";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";

const nf = (n: number) => n.toLocaleString("fa-IR");

const HEALTH_STYLE: Record<Health["state"], string> = {
  healthy: "bg-emerald-50 text-emerald-700",
  degraded: "bg-amber-50 text-amber-800",
  stale: "bg-amber-50 text-amber-800",
  offline: "bg-rose-50 text-rose-700",
  disconnected: "bg-stone-100 text-ink/72",
  paused: "bg-stone-100 text-ink/72",
};

const ORDER_STATUS: Record<string, string> = {
  pending: "در انتظار پرداخت",
  processing: "در حال انجام",
  "on-hold": "در انتظار بررسی",
  completed: "تکمیل‌شده",
  cancelled: "لغو شده",
  refunded: "مسترد شده",
  failed: "ناموفق",
  trash: "حذف‌شده",
};

const EVENT_LABEL: Record<string, string> = {
  "order.upserted": "سفارش ثبت/به‌روز شد",
  "order.status_changed": "تغییر وضعیت سفارش",
  "order.refunded": "استرداد سفارش",
  "order.deleted": "حذف سفارش",
  "customer.upserted": "به‌روزرسانی مشتری",
  "contract.issued": "قرارداد صادر شد",
  "contract.signed": "امضای یک طرف",
  "contract.completed": "قرارداد تکمیل شد",
  "contract.rejected": "قرارداد رد شد",
  "contract.expired": "قرارداد منقضی شد",
  "contract.cancelled": "قرارداد لغو شد",
  "contract.reminder": "یادآوری امضا",
  "sync.ping": "آزمایش اتصال",
  "sync.resync": "درخواست هم‌ترازسازی کامل",
};

function logStatus(s: string) {
  if (s === "ok" || s === "delivered:push") return ["text-emerald-700", s === "ok" ? "پردازش شد" : "ارسال شد (Push)"] as const;
  if (s === "delivered:pull") return ["text-emerald-700", "تحویل (Pull)"] as const;
  if (s === "ignored") return ["text-ink/60", "نادیده (بدون تغییر)"] as const;
  if (s === "pending") return ["text-amber-700", "در صف"] as const;
  return ["text-rose-700", s === "dead" ? "منقضی" : "خطا"] as const;
}

export default async function WooCommercePage() {
  const admin = await requireTeam("settings");
  const [ov, orders, log] = await Promise.all([syncOverview(admin.workspaceId), listSyncedOrders(admin.workspaceId, 25), recentSyncLog(admin.workspaceId, 30)]);
  const s = ov.stats;
  const signRate = s.contracts ? Math.round((s.signed / s.contracts) * 100) : 0;
  const kpis = [
    { icon: ShoppingCart, label: "سفارش‌های همگام‌شده", value: nf(s.orders), tone: "text-sky-700 bg-sky-50" },
    { icon: Wallet, label: "فروش خالص (ووکامرس)", value: nf(Math.round(s.revenue)), tone: "text-emerald-700 bg-emerald-50" },
    { icon: Users, label: "مشتریان یکتا", value: nf(s.customers), tone: "text-violet-700 bg-violet-50" },
    { icon: FileSignature, label: "قرارداد از فروشگاه", value: `${nf(s.contracts)} · ${nf(signRate)}٪ امضاشده`, tone: "text-teal-700 bg-teal-50" },
  ];
  return (
    <Shell user={admin}>
      <LiveRefresh seconds={20} />
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="mb-1 text-2xl font-black">مرکز همگام‌سازی ووکامرس</h1>
          <p className="text-xs text-ink/72">سفارش‌ها و مشتریان از ووکامرس به این‌جا می‌آیند و وضعیت امضا لحظه‌ای به سفارش برمی‌گردد — دوطرفه، امضاشده و تکرارپذیر.</p>
        </div>
        <Link href="/admin/wordpress" className="btn-ghost btn-sm">نصب افزونه و سایت‌های متصل</Link>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="card !p-4">
            <span className={`grid h-9 w-9 place-items-center rounded-xl ${k.tone}`}><k.icon size={17} /></span>
            <b className="mt-3 block text-lg font-black">{k.value}</b>
            <span className="text-xs text-ink/72">{k.label}</span>
          </div>
        ))}
      </section>

      <section className="mt-5 grid gap-4 lg:grid-cols-2">
        {ov.connections.length === 0 && (
          <div className="card lg:col-span-2 text-center text-xs text-ink/72">
            هنوز سایتی وصل نیست. <Link className="underline underline-offset-4" href="/admin/wordpress">افزونه را نصب کنید</Link>؛ به‌محض فعال‌سازی، همگام‌سازی خودکار شروع می‌شود.
          </div>
        )}
        {ov.connections.map(({ conn: c, backlog, health }) => (
          <div key={c.id} className="card">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <b className="block text-sm" dir="ltr">{c.siteHost}</b>
                <span className="text-xs text-ink/72">{c.siteName}{c.wcActive ? " • ووکامرس فعال" : " • ووکامرس نصب نیست"}</span>
              </div>
              <span className={`badge inline-flex items-center gap-1 ${HEALTH_STYLE[health.state]}`}>
                {health.state === "healthy" ? <CheckCircle2 size={13} /> : <TriangleAlert size={13} />} {health.label}
              </span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div><dt className="text-ink/60">آخرین ارتباط</dt><dd className="font-semibold">{c.lastSeenAt ? faTime(c.lastSeenAt) : "—"}</dd></div>
              <div><dt className="text-ink/60">نسخه‌ی افزونه</dt><dd className="font-semibold" dir="ltr">{c.pluginVersion || "—"}</dd></div>
              <div><dt className="flex items-center gap-1 text-ink/60"><ArrowDownToLine size={12} /> آخرین دریافت از وردپرس</dt><dd className="font-semibold">{c.lastSyncInAt ? faTime(c.lastSyncInAt) : "—"}</dd></div>
              <div><dt className="flex items-center gap-1 text-ink/60"><ArrowUpFromLine size={12} /> آخرین ارسال به وردپرس</dt><dd className="font-semibold">{c.lastSyncOutAt || c.lastPullAt ? faTime((c.lastSyncOutAt ?? c.lastPullAt) as Date) : "—"}</dd></div>
              <div><dt className="text-ink/60">روش تحویل رویداد</dt><dd className="font-semibold">{c.capabilities.includes("push") && !c.lastPushError ? "Push فوری + Pull" : "Pull دوره‌ای"}</dd></div>
              <div><dt className="text-ink/60">در صف تحویل</dt><dd className="font-semibold">{nf(backlog)}</dd></div>
            </dl>
            {health.hints.length > 0 && (
              <ul className="mt-3 space-y-1 rounded-xl bg-stone-50 p-3 text-xs leading-6 text-ink/80">
                {health.hints.map((h) => <li key={h}>• {h}</li>)}
              </ul>
            )}
            {c.status === "active" && (
              <div className="mt-4 flex flex-wrap gap-2">
                <form action={pingSiteAction}><input type="hidden" name="id" value={c.id} /><button className="btn-ghost btn-sm"><Radio size={14} /> آزمایش اتصال</button></form>
                <form action={resyncSiteAction}><input type="hidden" name="id" value={c.id} /><button className="btn-ghost btn-sm"><RefreshCw size={14} /> هم‌ترازسازی کامل سفارش‌ها</button></form>
                <form action={retryOutboxAction}><input type="hidden" name="id" value={c.id} /><button className="btn-ghost btn-sm"><RotateCw size={14} /> ارسال مجدد صف</button></form>
                <form action={toggleSyncAction}>
                  <input type="hidden" name="id" value={c.id} /><input type="hidden" name="enabled" value={c.syncEnabled ? "0" : "1"} />
                  <button className="btn-ghost btn-sm">{c.syncEnabled ? <><Pause size={14} /> توقف همگام‌سازی</> : <><Play size={14} /> ازسرگیری</>}</button>
                </form>
                <form action={rotateSecretAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <ConfirmButton message="راز امضای همگام‌سازی چرخانده شود؟ افزونه به‌صورت خودکار راز جدید را دریافت می‌کند." className="btn-ghost btn-sm"><KeyRound size={14} /> چرخش راز امضا</ConfirmButton>
                </form>
              </div>
            )}
          </div>
        ))}
      </section>

      {(s.pending > 0 || s.dead > 0 || s.errors24 > 0) && (
        <section className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl bg-amber-50 p-4 text-xs text-amber-900">
          <TriangleAlert size={16} />
          <span>
            {s.pending > 0 && <>{nf(s.pending)} رویداد در انتظار تحویل · </>}
            {s.dead > 0 && <>{nf(s.dead)} رویداد منقضی‌شده · </>}
            {s.errors24 > 0 && <>{nf(s.errors24)} خطای پردازش در ۲۴ ساعت اخیر</>}
          </span>
          <form action={retryOutboxAction}><button className="btn-primary btn-sm">تلاش مجدد همه</button></form>
        </section>
      )}

      <section className="panel-solid mt-5 overflow-x-auto">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="font-bold">آخرین سفارش‌ها و وضعیت امضا</h2>
          <span className="text-xs text-ink/72">به‌روزرسانی خودکار هر ۲۰ ثانیه</span>
        </div>
        <table className="mt-2 w-full min-w-[760px]">
          <thead><tr><th className="th">سفارش</th><th className="th">مشتری</th><th className="th">مبلغ</th><th className="th">وضعیت سفارش</th><th className="th">قرارداد</th><th className="th">زمان</th></tr></thead>
          <tbody>
            {orders.map(({ order: o, contracts: cs }) => (
              <tr key={o.id} className="border-t border-ink/[.07]">
                <td className="td text-xs font-bold" dir="ltr">#{o.number}</td>
                <td className="td text-xs"><b className="block">{o.customerName || "—"}</b><span className="text-ink/65" dir="ltr">{o.customerEmail}</span></td>
                <td className="td text-xs" dir="ltr">{nf(Number(o.total))} {o.currency}</td>
                <td className="td text-xs">{ORDER_STATUS[o.status] ?? o.status}</td>
                <td className="td text-xs">
                  {cs.length === 0 ? <span className="text-ink/50">—</span> : (
                    <div className="flex flex-wrap gap-1">
                      {cs.map((c) => (
                        <Link key={c.contractId} href={`/contracts/${c.contractId}`} className="inline-flex items-center gap-1"><span dir="ltr" className="text-[11px] text-ink/70">{c.number}</span><StatusBadge status={c.status} /></Link>
                      ))}
                    </div>
                  )}
                </td>
                <td className="td text-xs">{o.wcCreatedAt ? faTime(o.wcCreatedAt) : "—"}</td>
              </tr>
            ))}
            {orders.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-xs text-ink/72">هنوز سفارشی همگام نشده است. در وردپرس: امضاگیر ← همگام‌سازی ← «همگام‌سازی کامل».</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="panel-solid mt-5 overflow-x-auto">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="font-bold">گزارش زنده‌ی همگام‌سازی</h2>
          <span className="text-xs text-ink/72">{nf(s.in24)} دریافتی و {nf(s.delivered24)} ارسالی در ۲۴ ساعت اخیر</span>
        </div>
        <table className="mt-2 w-full min-w-[640px]">
          <thead><tr><th className="th">جهت</th><th className="th">رویداد</th><th className="th">نتیجه</th><th className="th">جزئیات</th><th className="th">زمان</th></tr></thead>
          <tbody>
            {log.map((r) => {
              const [tone, text] = logStatus(r.status);
              return (
                <tr key={r.key} className="border-t border-ink/[.07]">
                  <td className="td text-xs">{r.dir === "in" ? <span className="inline-flex items-center gap-1 text-sky-700"><ArrowDownToLine size={13} /> وردپرس ← ابر</span> : <span className="inline-flex items-center gap-1 text-teal-700"><ArrowUpFromLine size={13} /> ابر ← وردپرس</span>}</td>
                  <td className="td text-xs">{EVENT_LABEL[r.event] ?? r.event}</td>
                  <td className={`td text-xs font-semibold ${tone}`}>{text}</td>
                  <td className="td text-xs text-ink/70" dir="ltr">{r.detail || "—"}</td>
                  <td className="td text-xs">{faTime(r.at)}</td>
                </tr>
              );
            })}
            {log.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-xs text-ink/72">هنوز رویدادی رد و بدل نشده است.</td></tr>}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}
