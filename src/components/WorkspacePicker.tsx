"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { searchWorkspaces, type WorkspaceOption } from "@/lib/workspace-search";
import { normalizeDigits } from "@/lib/numbers";

/**
 * انتخاب فضای کاری با جستجو (نام / ایمیل مالک / نشانی / شناسه).
 * مقدار ارسالی همان `workspaceId` عددی است؛ تایپ مستقیم شناسه هم مثل قبل کار می‌کند.
 */
export default function WorkspacePicker({ options, id = "as-ws", name = "workspaceId" }: { options: WorkspaceOption[]; id?: string; name?: string }) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<WorkspaceOption | null>(null);
  const results = useMemo(() => (picked ? [] : searchWorkspaces(options, text)), [options, text, picked]);
  const typedId = /^\d+$/.test(normalizeDigits(text)) ? Number(normalizeDigits(text)) : null;
  const byId = typedId ? options.find((o) => o.id === typedId) : undefined;
  const current = picked ?? byId ?? null;
  const textNotId = !picked && text.trim() !== "" && typedId === null;

  return (
    <div className="relative">
      <label className="label" htmlFor={id}>فضای کاری</label>
      <div className="relative">
        <input
          id={id}
          name={name}
          required
          value={picked ? String(picked.id) : text}
          onChange={(e) => {
            setPicked(null);
            setText(e.target.value);
          }}
          autoComplete="off"
          dir="auto"
          className="input pl-9"
          placeholder="نام، ایمیل مالک یا شناسه"
          aria-describedby={`${id}-hint`}
        />
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/50" aria-hidden="true" />
      </div>
      {results.length > 0 && (
        <ul role="listbox" aria-label="نتایج جستجوی فضای کاری" className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-2xl border border-ink/10 bg-white p-1 shadow-lg">
          {results.map((w) => (
            <li key={w.id} role="option" aria-selected="false">
              <button type="button" onClick={() => setPicked(w)} className="flex w-full flex-col items-start rounded-xl px-3 py-2 text-right text-xs hover:bg-ink/5">
                <span className="font-bold">{w.name} <span className="font-normal text-ink/60" dir="ltr">#{w.id}</span></span>
                <span className="text-ink/65"><span dir="ltr">{w.owner}</span> · طرح فعلی: {w.plan}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p id={`${id}-hint`} data-testid="ws-picker-hint" className={`mt-1.5 text-[11px] ${current ? "text-emerald-700" : textNotId && results.length === 0 ? "text-rose-700" : "text-ink/65"}`}>
        {current
          ? `✓ «${current.name}» — مالک: ${current.owner} — طرح فعلی: ${current.plan}`
          : textNotId && results.length === 0
            ? "فضای کاری‌ای با این مشخصات پیدا نشد."
            : typedId
              ? "این شناسه در فهرست نیست؛ اگر مطمئن هستید ادامه دهید."
              : "چند حرف از نام فضای کاری یا ایمیل مالک را بنویسید و از فهرست انتخاب کنید."}
      </p>
    </div>
  );
}
