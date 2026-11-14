"use client";

import { useActionState } from "react";
import { LoaderCircle, UserRoundPlus } from "lucide-react";
import { addGuestAction } from "@/modules/guests/actions";
import type { TeamState } from "@/modules/tenancy/actions";

/** فرم افزودن امضاکننده‌ی مهمان: فقط نام و موبایل */
export function AddGuestForm() {
  const [s, action, pending] = useActionState<TeamState, FormData>(addGuestAction, {});
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto]">
      <input name="name" required placeholder="نام و نام خانوادگی" className="input" aria-label="نام امضاکننده مهمان" autoComplete="off" />
      <input name="mobile" required dir="ltr" placeholder="09123456789" inputMode="tel" className="input" aria-label="موبایل امضاکننده مهمان" autoComplete="off" />
      <button disabled={pending} className="btn-primary">
        {pending ? <LoaderCircle size={16} className="animate-spin" /> : <UserRoundPlus size={16} />}
        افزودن مهمان
      </button>
      {s.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 sm:col-span-full">{s.error}</p>}
      {s.message && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-6 text-emerald-800 sm:col-span-full">{s.message}</p>}
    </form>
  );
}
