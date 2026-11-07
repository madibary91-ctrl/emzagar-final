import { CheckCircle2, Circle, Download, Globe, Gauge, PlugZap, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import Shell from "@/components/Shell";
import ConfirmButton from "@/components/ConfirmButton";
import { requireTeam } from "@/modules/tenancy/context";
import { listConnections } from "@/modules/connect/service";
import { disconnectSiteAction } from "@/modules/connect/actions";
import { faTime } from "@/lib/jalali";
import { depthForWorkspace } from "@/modules/hub/service";

export const dynamic = "force-dynamic";

const STEPS = [
  { n: "۱", title: "دانلود افزونه", text: "فایل ZIP زیر را دانلود کنید؛ آدرس و کد اتصال شما از قبل داخل آن قرار دارد." },
  { n: "۲", title: "نصب و فعال‌سازی", text: "در وردپرس: افزونه‌ها ← افزودن ← بارگذاری افزونه ← فعال‌سازی." },
  { n: "۳", title: "تمام!", text: "افزونه خودش وصل می‌شود. نه کلیدی کپی می‌کنید، نه تنظیماتی دارید." },
];

export default async function WordPressPage() {
  const admin = await requireTeam("settings");
  const conns = await listConnections(admin.workspaceId);
  const active = conns.filter((c) => c.status === "active");
  const depths = await depthForWorkspace(admin.workspaceId);
  return (
    <Shell user={admin}>
      <h1 className="mb-1 text-2xl font-black">وردپرس، ووکامرس و المنتور</h1>
      <p className="mb-5 text-xs text-ink/72">نصب، فعال‌سازی، کار می‌کند — بدون کلید API و بدون تنظیمات فنی.</p>

      <section className="card relative overflow-hidden">
        <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr] lg:items-center">
          <div>
            <span className="badge inline-flex items-center gap-1 bg-emerald-50 text-emerald-700">
              <Sparkles size={13} /> نصب سه‌مرحله‌ای
            </span>
            <h2 className="mt-3 text-xl font-black leading-9">افزونه‌ی اختصاصی شما، آماده‌ی نصب</h2>
            <p className="mt-2 text-xs leading-7 text-ink/75">
              این بسته به حساب «{admin.workspaceName}» جفت شده است؛ پس از فعال‌سازی، سایت وردپرس شما خودکار به همین فضای کاری (قالب‌ها، قراردادها و مشتریان فعلی) وصل می‌شود. کد جفت‌سازی یک‌بارمصرف است و ۷ روز اعتبار دارد.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <a href="/api/wordpress/plugin?pair=1" className="btn-primary" download>
                <Download size={16} /> دانلود افزونه (emzagar-contracts.zip)
              </a>
              <a href="/api/wordpress/plugin" className="text-xs text-ink/72 underline underline-offset-4" download>
                دانلود نسخه‌ی عمومی (برای ساخت فضای کاری جدید)
              </a>
            </div>
          </div>
          <ol className="space-y-3">
            {STEPS.map((s) => (
              <li key={s.n} className="flex gap-3 rounded-2xl bg-stone-50 p-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-ink text-sm font-black text-mint">{s.n}</span>
                <div>
                  <b className="block text-sm">{s.title}</b>
                  <span className="text-xs leading-6 text-ink/75">{s.text}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mt-5 grid gap-4 md:grid-cols-3">
        {[
          [ShieldCheck, "امن و خودکار", "مالکیت دامنه با یک چالش خودکار تایید می‌شود و کلید فقط روی سرور وردپرس شما می‌ماند."],
          [PlugZap, "خودترمیم", "اگر اتصال قطع یا کلید باطل شود، افزونه بی‌صدا دوباره وصل می‌شود."],
          [Globe, "ورود یک‌کلیکی", "از منوی «امضاگیر» در وردپرس با یک کلیک وارد این پنل شوید."],
        ].map(([Icon, title, text]) => {
          const I = Icon as typeof Globe;
          return (
            <div key={title as string} className="card !p-4">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><I size={17} /></span>
              <b className="mt-3 block text-sm">{title as string}</b>
              <p className="mt-1 text-xs leading-6 text-ink/75">{text as string}</p>
            </div>
          );
        })}
      </section>

      {depths.map(({ conn, features, depth, reportedAt }) => (
        <section key={conn.id} className="card mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><Gauge size={18} /></span>
              <div>
                <h2 className="text-sm font-black">عمق یکپارچگی — <span dir="ltr">{conn.siteHost}</span></h2>
                <p className="text-xs text-ink/72">
                  سطح فعلی: <b>{depth.level}</b>
                  {reportedAt ? ` • آخرین گزارش افزونه: ${faTime(reportedAt)}` : " • هنوز گزارشی از افزونه نرسیده (مرکز فرماندهی را در وردپرس باز کنید)"}
                </p>
              </div>
            </div>
            <div className="text-left">
              <b className="block text-3xl font-black leading-none text-emerald-700">{depth.score.toLocaleString("fa-IR")}٪</b>
            </div>
          </div>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-valuenow={depth.score} aria-valuemin={0} aria-valuemax={100} aria-label="عمق یکپارچگی">
            <div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${depth.score}%` }} />
          </div>
          {depth.next && (
            <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900">
              <b>گام پیشنهادی بعدی:</b> {depth.next.label} — {depth.next.hint}
            </p>
          )}
          <ul className="mt-3 grid gap-2 md:grid-cols-2">
            {depth.steps.map((st) => (
              <li key={st.key} className="flex items-start gap-2 rounded-xl bg-stone-50 px-3 py-2 text-xs leading-6">
                {st.done ? <CheckCircle2 size={15} className="mt-1 shrink-0 text-emerald-700" /> : <Circle size={15} className="mt-1 shrink-0 text-ink/30" />}
                <span><b className={st.done ? "" : "text-ink/80"}>{st.label}</b><span className="block text-ink/65">{st.hint}</span></span>
              </li>
            ))}
          </ul>
          {(features.gateChecks > 0 || features.gates > 0) && (
            <p className="mt-3 text-xs text-ink/72">
              تا امروز <b>{features.gateChecks.toLocaleString("fa-IR")}</b> بار دسترسی مشتریان سایت بر پایه‌ی امضای قرارداد کنترل شده و <b>{features.gateAllowed.toLocaleString("fa-IR")}</b> بار به‌دلیل امضا باز شده است ({features.gates.toLocaleString("fa-IR")} دروازه‌ی فعال).
            </p>
          )}
          {(features.actions > 0 || features.automations > 0 || features.forms > 0) && (
            <p className="mt-2 text-xs text-ink/72">
              مدیر سایت <b>{features.actions.toLocaleString("fa-IR")}</b> کنش (یادآوری، لغو، صدور، دانلود) را بدون خروج از وردپرس انجام داده؛ <b>{features.automations.toLocaleString("fa-IR")}</b> قانون اتوماسیون فعال است و <b>{features.automationRuns.toLocaleString("fa-IR")}</b> بار اجرا شده؛ <b>{features.forms.toLocaleString("fa-IR")}</b> فرم سایت به صدور خودکار قرارداد وصل است.
            </p>
          )}
        </section>
      ))}

      <section className="panel-solid mt-5 overflow-x-auto">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="font-bold">سایت‌های متصل</h2>
          <span className="text-xs text-ink/72">{active.length.toLocaleString("fa-IR")} سایت فعال</span>
        </div>
        <table className="mt-2 w-full min-w-[640px]">
          <thead>
            <tr><th className="th">سایت</th><th className="th">وضعیت</th><th className="th">نسخه‌ها</th><th className="th">آخرین ارتباط</th><th className="th"></th></tr>
          </thead>
          <tbody>
            {conns.map((c) => (
              <tr key={c.id} className="border-t border-ink/[.07]">
                <td className="td">
                  <b className="block text-xs" dir="ltr">{c.siteHost}</b>
                  <span className="text-xs text-ink/72">{c.siteName}{c.wcActive ? " • ووکامرس" : ""}</span>
                </td>
                <td className="td text-xs">
                  {c.status !== "active" ? (
                    <span className="text-ink/72">قطع شده</span>
                  ) : c.verified ? (
                    <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={14} /> متصل و تاییدشده</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-amber-700"><TriangleAlert size={14} /> آزمایشی (سایت محلی)</span>
                  )}
                </td>
                <td className="td text-xs text-ink/75" dir="ltr">افزونه {c.pluginVersion || "—"} · WP {c.wpVersion || "—"}</td>
                <td className="td text-xs">{c.lastSeenAt ? faTime(c.lastSeenAt) : "—"}</td>
                <td className="td">
                  {c.status === "active" && (
                    <form action={disconnectSiteAction}>
                      <input type="hidden" name="id" value={c.id} />
                      <ConfirmButton message="اتصال این سایت قطع شود؟ داده‌های شما حفظ می‌شود و افزونه با فعال‌سازی دوباره وصل می‌شود." className="btn-danger btn-sm">قطع اتصال</ConfirmButton>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {conns.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-xs text-ink/72">هنوز سایتی متصل نشده است. افزونه را نصب کنید؛ همین‌جا ظاهر می‌شود.</td></tr>}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}
