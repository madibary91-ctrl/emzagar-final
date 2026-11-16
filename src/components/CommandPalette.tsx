"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, FileText, LayoutTemplate, Search, Compass } from "lucide-react";

type Hit = { type: string; href: string; title: string; sub: string };
type Page = { href: string; label: string; caption: string };

/** پالت فرمان سراسری: Ctrl/⌘ + K — پرش به صفحه‌ها و جستجوی قرارداد/قالب/مشتری */
export default function CommandPalette({ pages, searchable }: { pages: Page[]; searchable: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!searchable || q.trim().length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/admin/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((j: { results?: Hit[] }) => setHits(j.results ?? []))
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, searchable]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const nav = pages
      .filter((p) => !needle || p.label.toLowerCase().includes(needle) || p.caption.toLowerCase().includes(needle))
      .slice(0, needle ? 5 : 8)
      .map((p) => ({ type: "page", href: p.href, title: p.label, sub: p.caption }));
    const shown = searchable && needle.length >= 2 ? hits : [];
    return [...shown, ...nav];
  }, [hits, pages, q, searchable]);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setHits([]);
    setIdx(0);
  }, []);

  const go = useCallback(
    (href: string) => {
      close();
      router.push(href);
    },
    [router, close],
  );

  const safeIdx = Math.min(idx, Math.max(0, items.length - 1));

  return (
    <>
      <button data-tour="cmdk" onClick={() => setOpen(true)} aria-label="جستجو… Ctrl K" aria-keyshortcuts="Control+K Meta+K" className="flex h-10 items-center gap-2 rounded-xl border border-ink/10 bg-white px-3 text-xs text-ink/75 transition hover:border-ink/25">
        <Search size={15} />
        <span className="hidden md:inline">جستجو…</span>
        <kbd className="hidden rounded bg-stone-100 px-1.5 py-0.5 font-mono text-xs md:inline" dir="ltr">Ctrl K</kbd>
      </button>
      {open && (
        <div className="no-print fixed inset-0 z-[100] flex items-start justify-center bg-ink/50 p-4 pt-[12vh] backdrop-blur-sm" onClick={close} role="presentation">
          <div role="dialog" aria-modal="true" aria-label="جستجو" className="w-full max-w-xl overflow-hidden rounded-3xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 border-b border-ink/10 px-4">
              <Search size={18} className="text-ink/72" />
              <input
                ref={input}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setIdx(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setIdx((i) => Math.min(items.length - 1, i + 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setIdx((i) => Math.max(0, i - 1));
                  } else if (e.key === "Enter" && items[safeIdx]) go(items[safeIdx].href);
                }}
                placeholder={searchable ? "شماره قرارداد، عنوان، نام مشتری یا نام صفحه…" : "نام صفحه…"}
                className="h-14 flex-1 bg-transparent text-sm outline-none"
                aria-label="عبارت جستجو"
              />
            </div>
            <ul className="thin-scroll max-h-[50vh] overflow-y-auto p-2" role="listbox">
              {items.map((it, i) => {
                const Icon = it.type === "contract" ? FileText : it.type === "template" ? LayoutTemplate : Compass;
                return (
                  <li key={`${it.type}-${it.href}`} role="option" aria-selected={i === safeIdx}>
                    <button onMouseEnter={() => setIdx(i)} onClick={() => go(it.href)} className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-right ${i === safeIdx ? "bg-ink text-white" : "hover:bg-ink/[.04]"}`}>
                      <Icon size={16} className={i === safeIdx ? "text-mint" : "text-ink/72"} />
                      <span className="min-w-0 flex-1">
                        <b className="block truncate text-[13px]">{it.title}</b>
                        <span className={`block truncate text-xs ${i === safeIdx ? "text-white/65" : "text-ink/72"}`}>{it.sub}</span>
                      </span>
                      {i === safeIdx && <CornerDownLeft size={14} className="text-white/65" />}
                    </button>
                  </li>
                );
              })}
              {items.length === 0 && <li className="py-8 text-center text-xs text-ink/72">نتیجه‌ای یافت نشد.</li>}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
