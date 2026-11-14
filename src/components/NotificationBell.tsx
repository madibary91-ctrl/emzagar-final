"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Bell, BellRing, CheckCheck, CheckCircle2, Info, LoaderCircle, ShieldAlert } from "lucide-react";

type Item = { id: number; kind: string; title: string; body: string; href: string | null; read: boolean; at: string };

const FA = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (n: number | string) => String(n).replace(/\d/g, (d) => FA[Number(d)]);

function ago(iso: string): string {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat("fa", { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 60) return "هم‌اکنون";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === "success") return <CheckCircle2 size={16} className="text-emerald-700" />;
  if (kind === "warning") return <AlertTriangle size={16} className="text-amber-600" />;
  if (kind === "security") return <ShieldAlert size={16} className="text-rose-600" />;
  if (kind === "action") return <BellRing size={16} className="text-sky-600" />;
  return <Info size={16} className="text-ink/72" />;
}

/** زنگوله‌ی مرکز اعلان: شمارنده با پولینگ سبک (هر ۴۵ ثانیه، فقط وقتی تب فعال است) */
export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Item[] | null>(null);
  const [loading, setLoading] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  const refreshCount = useCallback(async () => {
    try {
      const r = await fetch("/api/notifications?count=1", { cache: "no-store" });
      if (r.ok) setUnread(((await r.json()) as { unread: number }).unread);
    } catch {
      /* آفلاین: بی‌صدا */
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/notifications", { cache: "no-store" });
      if (r.ok) {
        const d = (await r.json()) as { unread: number; items: Item[] };
        setItems(d.items);
        setUnread(d.unread);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshCount();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refreshCount();
    }, 45_000);
    return () => clearInterval(t);
  }, [refreshCount]);

  useEffect(() => {
    if (!open) return;
    void loadList();
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, loadList]);

  const markAll = async () => {
    await fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    setItems((l) => l?.map((i) => ({ ...i, read: true })) ?? l);
    setUnread(0);
  };

  const markOne = (id: number) => {
    void fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [id] }) });
    setItems((l) => l?.map((i) => (i.id === id ? { ...i, read: true } : i)) ?? l);
    setUnread((u) => Math.max(0, u - 1));
    setOpen(false);
  };

  return (
    <div ref={wrap} className="relative">
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={unread > 0 ? `اعلان‌ها — ${faDigits(unread)} اعلان خوانده‌نشده` : "اعلان‌ها"}
        className="relative grid h-10 w-10 place-items-center rounded-xl border border-ink/10 bg-white transition hover:border-ink/25"
      >
        <Bell size={17} />
        {unread > 0 && (
          <span className="absolute -left-1 -top-1 grid min-w-[18px] place-items-center rounded-full bg-rose-600 px-1 text-[10px] font-black leading-[18px] text-white" aria-hidden="true">
            {unread > 99 ? "۹۹+" : faDigits(unread)}
          </span>
        )}
      </button>
      {open && (
        <div role="region" aria-label="فهرست اعلان‌ها" className="fixed inset-x-3 top-[76px] z-50 overflow-hidden rounded-2xl border border-ink/10 bg-white shadow-2xl sm:absolute sm:inset-x-auto sm:left-0 sm:top-12 sm:w-[380px]">
          <div className="flex items-center justify-between border-b border-ink/10 px-4 py-3">
            <b className="text-sm">اعلان‌ها</b>
            <button type="button" onClick={markAll} disabled={unread === 0} className="flex items-center gap-1 text-xs font-semibold text-emerald-700 disabled:opacity-40">
              <CheckCheck size={14} />
              خوانده‌شدن همه
            </button>
          </div>
          <div className="thin-scroll max-h-[min(70vh,420px)] overflow-y-auto">
            {loading && !items && <p className="flex items-center justify-center gap-2 p-6 text-xs text-ink/72"><LoaderCircle size={15} className="animate-spin" />در حال بارگذاری…</p>}
            {items && items.length === 0 && <p className="p-8 text-center text-xs leading-7 text-ink/72">اعلانی ندارید. رویدادهای مهم (نوبت امضا، تکمیل قرارداد، تمدید و امنیت) اینجا نمایش داده می‌شود.</p>}
            <ul>
              {items?.map((n) => {
                const body = (
                  <div className="flex gap-3">
                    <span className="mt-1 shrink-0"><KindIcon kind={n.kind} /></span>
                    <div className="min-w-0 flex-1">
                      <b className={`block text-xs leading-6 ${n.read ? "font-semibold text-ink/75" : "text-ink"}`}>{n.title}</b>
                      {n.body && <p className="mt-0.5 line-clamp-2 text-xs leading-6 text-ink/72">{n.body}</p>}
                      <span className="mt-1 block text-[11px] text-ink/72">{ago(n.at)}</span>
                    </div>
                    {!n.read && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-sky-500" aria-label="خوانده‌نشده" />}
                  </div>
                );
                return (
                  <li key={n.id} className={`border-b border-ink/[.06] last:border-0 ${n.read ? "" : "bg-sky-50/50"}`}>
                    {n.href ? (
                      <Link href={n.href} onClick={() => markOne(n.id)} className="block px-4 py-3 transition hover:bg-stone-50">{body}</Link>
                    ) : (
                      <button type="button" onClick={() => markOne(n.id)} className="block w-full px-4 py-3 text-right transition hover:bg-stone-50">{body}</button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          <Link href="/notifications" onClick={() => setOpen(false)} className="block border-t border-ink/10 px-4 py-3 text-center text-xs font-bold text-ink hover:bg-stone-50">
            مشاهده‌ی همه‌ی اعلان‌ها
          </Link>
        </div>
      )}
    </div>
  );
}
