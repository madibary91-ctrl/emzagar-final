"use client";

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
const DISMISS_KEY = "emz_pwa_dismissed";

/** ثبت Service Worker (فقط production) و نمایش دعوت به نصب اپلیکیشن */
export default function PwaRegister() {
  const [evt, setEvt] = useState<InstallEvent | null>(null);

  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      let dismissed = false;
      try {
        dismissed = Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) < 14 * 86400_000;
      } catch {}
      if (!dismissed) setEvt(e as InstallEvent);
    };
    const onInstalled = () => setEvt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!evt) return null;
  const close = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {}
    setEvt(null);
  };
  return (
    <div role="dialog" aria-label="نصب اپلیکیشن" className="no-print fixed inset-x-3 bottom-3 z-[90] mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-ink/10 bg-white p-3 shadow-2xl">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ink text-mint"><Download size={18} /></span>
      <div className="min-w-0 flex-1">
        <b className="block text-[13px]">نصب اپلیکیشن امضاگیر</b>
        <span className="text-xs text-ink/75">دسترسی سریع‌تر، تمام‌صفحه و بدون نوار مرورگر</span>
      </div>
      <button
        className="btn-primary btn-sm"
        onClick={async () => {
          await evt.prompt();
          await evt.userChoice.catch(() => null);
          setEvt(null);
        }}
      >
        نصب
      </button>
      <button onClick={close} aria-label="بستن" className="grid h-8 w-8 place-items-center rounded-lg text-ink/72 hover:bg-ink/5"><X size={16} /></button>
    </div>
  );
}
