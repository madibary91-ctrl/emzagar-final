"use client";

import { useRef } from "react";
import { Building2, Plus } from "lucide-react";

export type WorkspaceInfo = { activeId: number; activeName: string; roleLabel: string; list: { id: number; name: string }[] };

/** تعویض فضای کاری فعال و ساخت فضای جدید (عضویت در سرور دوباره بررسی می‌شود) */
export default function WorkspaceSwitcher({
  info, switchAction, createAction,
}: {
  info: WorkspaceInfo;
  switchAction: (fd: FormData) => Promise<void>;
  createAction: (fd: FormData) => Promise<void>;
}) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <div className="mt-6 rounded-2xl border border-ink/10 bg-white p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-bold text-ink/72">
        <Building2 size={13} />
        فضای کاری · {info.roleLabel}
      </div>
      <form ref={form} action={switchAction}>
        <select
          name="workspaceId"
          defaultValue={info.activeId}
          onChange={() => form.current?.requestSubmit()}
          aria-label="فضای کاری فعال"
          className="input !min-h-10 !py-1.5 text-xs font-bold"
        >
          {info.list.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
      </form>
      <details className="mt-2">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold text-ink/72 hover:text-ink">
          <Plus size={12} />فضای کاری جدید
        </summary>
        <form action={createAction} className="mt-2 flex gap-2">
          <input name="name" required maxLength={60} placeholder="نام فروشگاه" className="input !min-h-9 !py-1 text-xs" aria-label="نام فضای کاری جدید" />
          <button className="btn-secondary btn-sm">ساخت</button>
        </form>
      </details>
    </div>
  );
}
