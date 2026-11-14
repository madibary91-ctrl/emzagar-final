"use client";

import { useActionState } from "react";
import { LoaderCircle, Send, UserPlus } from "lucide-react";
import { addClientAction, inviteMemberAction, type TeamState } from "@/modules/tenancy/actions";
import CopyButton from "@/components/CopyButton";

function Result({ s }: { s: TeamState }) {
  return (
    <>
      {s.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 sm:col-span-full">{s.error}</p>}
      {s.message && (
        <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-6 text-emerald-800 sm:col-span-full">
          {s.message}
          {s.link && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-white/70 p-2">
              <code dir="ltr" className="min-w-0 flex-1 break-all text-xs">{s.link}</code>
              <CopyButton text={s.link} />
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function InviteMemberForm({ isOwner }: { isOwner: boolean }) {
  const [s, action, pending] = useActionState<TeamState, FormData>(inviteMemberAction, {});
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_190px_auto]">
      <input name="email" type="email" dir="ltr" required placeholder="email@example.com" className="input" aria-label="ایمیل عضو جدید" />
      <select name="role" className="input" defaultValue="member" aria-label="نقش">
        {isOwner && <option value="admin">مدیر</option>}
        <option value="member">عضو</option>
        <option value="viewer">ناظر (فقط مشاهده)</option>
      </select>
      <button disabled={pending} className="btn-primary">
        {pending ? <LoaderCircle size={16} className="animate-spin" /> : <Send size={16} />}
        ارسال دعوت
      </button>
      <Result s={s} />
    </form>
  );
}

export function AddClientForm() {
  const [s, action, pending] = useActionState<TeamState, FormData>(addClientAction, {});
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto]">
      <input name="name" placeholder="نام و نام خانوادگی" className="input" aria-label="نام مشتری" />
      <input name="email" type="email" dir="ltr" required placeholder="email@example.com" className="input" aria-label="ایمیل مشتری" />
      <input name="mobile" dir="ltr" placeholder="09123456789" inputMode="numeric" className="input" aria-label="موبایل مشتری" />
      <button disabled={pending} className="btn-primary">
        {pending ? <LoaderCircle size={16} className="animate-spin" /> : <UserPlus size={16} />}
        افزودن مشتری
      </button>
      <Result s={s} />
    </form>
  );
}
