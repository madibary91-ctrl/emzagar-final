"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BookMarked, Plus, Search, X } from "lucide-react";
import { listClausesAction, saveClauseQuickAction, type ClauseOption } from "@/modules/clauses/actions";

/**
 * انتخابگر «کتابخانه‌ی بندها» داخل ویرایشگر: جستجو، دسته‌بندی، درج با یک کلیک در محل مکان‌نما،
 * و ذخیره‌ی متن انتخاب‌شده به‌عنوان بند اختصاصی.
 */
export default function ClausePicker({ areaRef, onChange }: { areaRef: React.RefObject<HTMLDivElement | null>; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ClauseOption[] | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const rangeRef = useRef<Range | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const rememberSelection = () => {
    const sel = window.getSelection();
    const area = areaRef.current;
    if (sel && sel.rangeCount && area && area.contains(sel.anchorNode)) rangeRef.current = sel.getRangeAt(0).cloneRange();
  };

  const toggle = async () => {
    if (!open) {
      rememberSelection();
      setOpen(true);
      if (!items) {
        try {
          setItems(await listClausesAction());
        } catch {
          setItems([]);
          setMsg("بارگذاری بندها ممکن نشد");
        }
      }
    } else setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const insert = (c: ClauseOption) => {
    const area = areaRef.current;
    if (!area) return;
    area.focus();
    const sel = window.getSelection();
    if (sel && rangeRef.current) {
      sel.removeAllRanges();
      sel.addRange(rangeRef.current);
    } else if (sel) {
      const r = document.createRange();
      r.selectNodeContents(area);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    document.execCommand("insertHTML", false, c.body);
    onChange();
    setOpen(false);
  };

  const saveSelection = async () => {
    const sel = window.getSelection();
    const area = areaRef.current;
    const range = rangeRef.current ?? (sel && sel.rangeCount ? sel.getRangeAt(0) : null);
    if (!range || !area || range.collapsed || !area.contains(range.commonAncestorContainer)) {
      setMsg("ابتدا بخشی از متن را در ویرایشگر انتخاب کنید");
      return;
    }
    const holder = document.createElement("div");
    holder.appendChild(range.cloneContents());
    const title = prompt("عنوان بند جدید:", holder.textContent?.trim().slice(0, 40) ?? "");
    if (!title) return;
    setSaving(true);
    const res = await saveClauseQuickAction(title, "general", holder.innerHTML);
    setSaving(false);
    if (res.ok) {
      setItems(await listClausesAction());
      setMsg("بند ذخیره شد و در کتابخانه‌ی شما قرار گرفت");
    } else setMsg(res.error ?? "خطا در ذخیره");
  };

  const cats = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items ?? []) m.set(i.category, i.categoryLabel);
    return [...m.entries()];
  }, [items]);
  const shown = (items ?? []).filter((i) => (cat === "all" || i.category === cat) && (!q || (i.title + " " + i.body.replace(/<[^>]*>/g, " ")).includes(q)));

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault();
          rememberSelection();
        }}
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="کتابخانه‌ی بندهای آماده"
        className="flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-900 hover:bg-emerald-100"
      >
        <BookMarked size={13} />
        کتابخانه‌ی بندها
      </button>
      {open && (
        <div role="dialog" aria-label="کتابخانه‌ی بندها" className="absolute right-0 top-full z-30 mt-1 w-[min(92vw,380px)] rounded-2xl border border-ink/10 bg-white p-3 shadow-xl">
          <div className="mb-2 flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink/60" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجو در بندها…" aria-label="جستجوی بند" className="input !min-h-9 !py-1 !pr-9 text-xs" autoFocus />
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="بستن" className="grid h-8 w-8 place-items-center rounded-lg hover:bg-stone-100"><X size={15} /></button>
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {[["all", "همه"] as [string, string], ...cats].map(([k, l]) => (
              <button key={k} type="button" onClick={() => setCat(k)} className={`rounded-full border px-2 py-0.5 text-[11px] ${cat === k ? "border-ink bg-ink text-white" : "border-ink/15 bg-white hover:bg-stone-50"}`}>{l}</button>
            ))}
          </div>
          <ul className="thin-scroll max-h-64 space-y-1 overflow-y-auto">
            {items === null && <li className="p-3 text-center text-xs text-ink/70">در حال بارگذاری…</li>}
            {items && shown.length === 0 && <li className="p-3 text-center text-xs text-ink/70">بندی یافت نشد.</li>}
            {shown.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => insert(c)} className="block w-full rounded-xl border border-transparent p-2 text-right hover:border-ink/10 hover:bg-stone-50">
                  <span className="flex items-center gap-2 text-xs font-bold">
                    {c.title}
                    <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-normal text-ink/70">{c.builtin ? "آماده" : "اختصاصی"}</span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[11px] leading-5 text-ink/65">{c.body.replace(/<[^>]*>/g, " ").slice(0, 140)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-ink/10 pt-2">
            <button type="button" disabled={saving} onClick={saveSelection} className="flex items-center gap-1 text-[11px] font-bold text-emerald-800 hover:underline"><Plus size={12} />ذخیره‌ی متن انتخاب‌شده به‌عنوان بند</button>
            <a href="/admin/clauses" className="text-[11px] text-ink/70 underline">مدیریت</a>
          </div>
          {msg && <p role="status" className="mt-2 text-[11px] text-ink/75">{msg}</p>}
        </div>
      )}
    </div>
  );
}
