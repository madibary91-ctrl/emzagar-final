"use client";

import { safeCallWith } from "@/lib/safe-call";
import { useState, useTransition } from "react";
import { Activity, PlugZap } from "lucide-react";
import ConfirmButton from "@/components/ConfirmButton";
import { allowReconnectAction, disconnectSiteAction, probeSiteAction } from "@/modules/connect/actions";

type Probe = { state: string; title: string; hint: string; ms?: number };

const TONE: Record<string, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  local: "border-stone-200 bg-stone-50 text-ink/80",
  error: "border-rose-200 bg-rose-50 text-rose-800",
};

/** عملیات هر سایت وردپرس: تست زنده‌ی اتصال، قطع (با تأیید) یا اجازه‌ی اتصال دوباره */
export default function WpSiteActions({ id, status }: { id: number; status: string }) {
  const [res, setRes] = useState<Probe | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex min-w-[180px] flex-col items-start gap-2">
      <div className="flex flex-wrap gap-2">
        {status === "active" && (
          <button type="button" disabled={pending} className="btn-secondary btn-sm" onClick={() => start(async () => setRes(await safeCallWith(() => probeSiteAction(id), (hint) => ({ state: "error" as const, title: "ارتباط برقرار نشد", hint }))))}>
            <Activity size={13} />{pending ? "در حال بررسی…" : "تست اتصال"}
          </button>
        )}
        {status === "active" && (
          <form action={disconnectSiteAction}>
            <input type="hidden" name="id" value={id} />
            <ConfirmButton
              title="قطع اتصال سایت"
              message="اتصال این سایت قطع می‌شود و افزونه تا زمانی که شما «اجازه‌ی اتصال دوباره» ندهید (یا افزونه را دوباره از این پنل دانلود کنید) خودکار وصل نمی‌شود. داده‌های شما حفظ می‌ماند."
              confirmLabel="بله، قطع شود"
              className="btn-danger btn-sm"
            >
              قطع اتصال
            </ConfirmButton>
          </form>
        )}
        {status === "revoked" && (
          <form action={allowReconnectAction}>
            <input type="hidden" name="id" value={id} />
            <button className="btn-primary btn-sm"><PlugZap size={13} />اجازه‌ی اتصال دوباره</button>
          </form>
        )}
      </div>
      {status === "revoked" && <p className="max-w-[260px] text-[11px] leading-5 text-ink/70">پس از اجازه، در وردپرس روی «اتصال دوباره» بزنید یا چند دقیقه صبر کنید؛ افزونه خودش وصل می‌شود.</p>}
      {res && (
        <div role={res.state === "ok" ? "status" : "alert"} className={`max-w-[300px] rounded-xl border p-2.5 text-[11px] leading-5 ${TONE[res.state] ?? "border-amber-200 bg-amber-50 text-amber-900"}`} data-probe={res.state}>
          <b className="block">{res.title}</b>
          {res.hint}
          {typeof res.ms === "number" && res.state === "ok" && <span className="mt-1 block text-ink/60">زمان پاسخ: {res.ms.toLocaleString("fa-IR")} میلی‌ثانیه</span>}
        </div>
      )}
    </div>
  );
}
