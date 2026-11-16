"use client";

import { useActionState } from "react";
import { Check, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import ConfirmButton from "@/components/ConfirmButton";
import CopyButton from "@/components/CopyButton";
import { changeRoleStateAction, removeMemberStateAction, resendInviteAction, revokeInviteStateAction, type TeamState } from "@/modules/tenancy/actions";

/** بازخورد هر عملیات تیم: موفقیت (سبز) یا دلیل رد (قرمز). پیش‌تر عملیات رد‌شده کاملاً «بی‌صدا» بود. */
function Feedback({ s }: { s: TeamState }) {
  if (s.error) return <p role="alert" className="mt-1.5 max-w-xs text-[11px] leading-5 text-rose-700">{s.error}</p>;
  if (!s.message) return null;
  return (
    <div role="status" className="mt-1.5 max-w-xs text-[11px] leading-5 text-emerald-800">
      <span className="flex items-start gap-1"><Check size={13} className="mt-0.5 shrink-0" />{s.message}</span>
      {s.link && (
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg bg-stone-50 p-1.5">
          <code dir="ltr" className="min-w-0 flex-1 break-all text-[10px] text-ink">{s.link}</code>
          <CopyButton text={s.link} />
        </span>
      )}
    </div>
  );
}

export function RoleForm({ memberId, role, options }: { memberId: number; role: string; options: { value: string; label: string }[] }) {
  const [s, action, pending] = useActionState<TeamState, FormData>(changeRoleStateAction, {});
  return (
    <form action={action}>
      <div className="flex items-center gap-2">
        <input type="hidden" name="memberId" value={memberId} />
        <select name="role" defaultValue={role} className="input !min-h-9 !py-1 text-xs" aria-label="نقش">
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button disabled={pending} className="btn-secondary btn-sm">{pending ? <LoaderCircle size={14} className="animate-spin" /> : null}ذخیره</button>
      </div>
      <Feedback s={s} />
    </form>
  );
}

export function RemoveMemberForm({ memberId, name }: { memberId: number; name: string }) {
  const [s, action, pending] = useActionState<TeamState, FormData>(removeMemberStateAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="memberId" value={memberId} />
      <ConfirmButton disabled={pending} message={`«${name}» از تیم حذف شود؟ دسترسی او به این فضای کاری فوراً قطع می‌شود.`} className="btn-danger btn-sm"><Trash2 size={14} />حذف</ConfirmButton>
      <Feedback s={s} />
    </form>
  );
}

export function InviteRowActions({ id, canResend }: { id: number; canResend: boolean }) {
  const [rs, resend, resending] = useActionState<TeamState, FormData>(resendInviteAction, {});
  const [vs, revoke, revoking] = useActionState<TeamState, FormData>(revokeInviteStateAction, {});
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {canResend && (
          <form action={resend}>
            <input type="hidden" name="id" value={id} />
            <button disabled={resending} className="btn-secondary btn-sm">{resending ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}ارسال دوباره و کپی لینک</button>
          </form>
        )}
        <form action={revoke}>
          <input type="hidden" name="id" value={id} />
          <button disabled={revoking} className="btn-ghost btn-sm">لغو دعوت</button>
        </form>
      </div>
      <Feedback s={rs} />
      <Feedback s={vs} />
    </div>
  );
}
