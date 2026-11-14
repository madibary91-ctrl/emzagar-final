"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Landmark } from "lucide-react";
import { saveMerchantAction } from "@/modules/contract-pay/actions";

type G = { id: string; label: string; credentialLabel: string; configured: boolean };

/** مرچنت اختصاصی: وجه پرداخت‌های قرارداد مستقیم به حساب خود صادرکننده واریز می‌شود */
export default function MerchantForm({ gateways, usingPlatform }: { gateways: G[]; usingPlatform: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = (id: string, clear = false) =>
    start(async () => {
      const r = await saveMerchantAction(id, clear ? "" : (vals[id] ?? ""));
      setMsg(r.ok ? { ok: true, text: clear ? "حذف شد" : "ذخیره شد" } : { ok: false, text: r.error || "ذخیره نشد" });
      if (r.ok) {
        setVals((v) => ({ ...v, [id]: "" }));
        router.refresh();
      }
    });
  return (
    <section className="panel-solid space-y-4 p-5 sm:p-6" aria-labelledby="merchant-title">
      <h2 id="merchant-title" className="flex items-center gap-2 text-sm font-black"><Landmark size={16} />درگاه دریافت وجه شما</h2>
      {usingPlatform ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-7 text-amber-900" role="status">هنوز مرچنت اختصاصی ثبت نکرده‌اید؛ پرداخت‌های قرارداد از درگاه‌های پلتفرم انجام می‌شود و وجه به حساب پلتفرم می‌رود. برای دریافت مستقیم، کد مرچنت درگاه خودتان را ثبت کنید.</p>
      ) : (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-7 text-emerald-900" role="status">پرداخت‌های قرارداد مستقیم به درگاه ثبت‌شده‌ی شما انجام می‌شود.</p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {gateways.map((g) => (
          <div key={g.id} className="rounded-2xl border border-ink/10 p-4">
            <div className="mb-2 flex items-center justify-between"><b className="text-sm">{g.label}</b><span className={`badge border ${g.configured ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-ink/10 bg-stone-50 text-ink/60"}`}>{g.configured ? "فعال" : "ثبت نشده"}</span></div>
            <label htmlFor={`m-${g.id}`} className="label">{g.credentialLabel}</label>
            <input id={`m-${g.id}`} dir="ltr" autoComplete="off" className="input" value={vals[g.id] ?? ""} onChange={(e) => setVals({ ...vals, [g.id]: e.target.value })} placeholder={g.configured ? "برای تغییر، مقدار جدید را وارد کنید" : ""} />
            <div className="mt-3 flex gap-2">
              <button type="button" className="btn-primary btn-sm" disabled={pending || !(vals[g.id] ?? "").trim()} onClick={() => save(g.id)}>ذخیره</button>
              {g.configured && <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => save(g.id, true)}>حذف</button>}
            </div>
          </div>
        ))}
      </div>
      {msg && <p role="status" className={`text-xs font-bold ${msg.ok ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</p>}
    </section>
  );
}
