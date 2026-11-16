"use client";

import { useActionState } from "react";
import { Database, FileSignature, LifeBuoy, ScrollText, Sparkles, Trash2, Users } from "lucide-react";
import ConfirmButton from "@/components/ConfirmButton";
import { clearDemoAction, seedDemoAction, type DemoState } from "@/modules/demo/actions";

type Counts = { users: number; contracts: number; tickets: number; logs: number; products: number; notifications: number };

const fa = (n: number) => n.toLocaleString("fa-IR");

/** مدیریت داده‌های نمونه: ساخت با یک دکمه، پاک‌سازی کامل با تأیید */
export default function DemoPanel({ seeded, counts }: { seeded: boolean; counts: Counts }) {
  const [seedState, seed, seeding] = useActionState<DemoState, FormData>(seedDemoAction, {});
  const [clearState, clear, clearing] = useActionState<DemoState, FormData>(clearDemoAction, {});
  const msg = seedState.ok || clearState.ok;
  const err = seedState.error || clearState.error;
  const stats = [
    { icon: FileSignature, label: "قرارداد", n: counts.contracts },
    { icon: Users, label: "مشتری", n: counts.users },
    { icon: LifeBuoy, label: "تیکت", n: counts.tickets },
    { icon: ScrollText, label: "لاگ و رویداد", n: counts.logs },
  ];

  return (
    <section className="card space-y-5" aria-labelledby="demo-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-ink text-mint"><Database size={20} aria-hidden="true" /></span>
          <div>
            <h2 id="demo-title" className="font-bold">داده‌های نمونه</h2>
            <p className="mt-0.5 text-xs text-stone-600">پنل را با قرارداد، مشتری، تیکت و لاگ واقع‌گرایانه پر کنید؛ هر زمان خواستید با یک دکمه همه را پاک کنید.</p>
          </div>
        </div>
        <span className={`badge ${seeded ? "bg-amber-50 text-amber-700" : "bg-stone-100 text-stone-600"}`}>{seeded ? "داده‌ی نمونه فعال است" : "پنل خالی از داده‌ی نمونه"}</span>
      </div>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <li key={s.label} className="rounded-2xl border border-ink/10 bg-white p-3.5">
            <s.icon size={16} aria-hidden="true" className="text-ink/72" />
            <b className="mt-2 block text-xl font-black">{fa(s.n)}</b>
            <span className="text-xs text-stone-600">{s.label}</span>
          </li>
        ))}
      </ul>

      <div className="rounded-2xl bg-stone-50 p-4 text-xs leading-7 text-ink/75">
        <b className="text-ink">این ابزار چه می‌کند؟</b>
        <ul className="mr-4 mt-1 list-disc">
          <li>۱۴ قرارداد در همه‌ی وضعیت‌ها (امضاشده، منتظر امضا، پیش‌نویس، ردشده، منقضی، لغوشده) با تاریخ‌های پراکنده در ۵۰ روز گذشته.</li>
          <li>۸ مشتری با نام و شماره‌ی نمونه که امکان ورود ندارند، ۴ تیکت پشتیبانی با پاسخ، لاگ امنیتی و اعلان.</li>
          <li>قراردادهای امضاشده‌ی نمونه در صفحه‌ی «استعلام اصالت» معتبر نمایش داده می‌شوند و سهمیه‌ی ماهانه‌ی طرح شما را مصرف <b>نمی‌کنند</b>.</li>
          <li>پاک‌سازی فقط همین داده‌ها را حذف می‌کند؛ قراردادها و مشتریان واقعی شما هرگز لمس نمی‌شوند.</li>
        </ul>
      </div>

      {msg && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-800">{msg}</p>}
      {err && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-xs text-rose-700">{err}</p>}

      <div className="flex flex-wrap gap-2">
        <form action={seed}>
          <button disabled={seeding || seeded} className="btn-primary" data-testid="demo-seed">
            <Sparkles size={15} aria-hidden="true" />
            {seeding ? "در حال ساخت…" : "ساخت داده‌های نمونه"}
          </button>
        </form>
        <form action={clear}>
          <ConfirmButton
            disabled={clearing || !seeded}
            title="پاک‌سازی داده‌های نمونه"
            message="همه‌ی قراردادها، مشتریان، تیکت‌ها و لاگ‌های نمونه برای همیشه حذف می‌شوند. داده‌های واقعی شما دست‌نخورده می‌ماند. ادامه می‌دهید؟"
            confirmLabel="بله، پاک شود"
            className="btn-secondary !text-rose-700"
            data-testid="demo-clear"
          >
            <Trash2 size={15} aria-hidden="true" />
            {clearing ? "در حال پاک‌سازی…" : "پاک‌سازی کامل داده‌های نمونه"}
          </ConfirmButton>
        </form>
      </div>
    </section>
  );
}
