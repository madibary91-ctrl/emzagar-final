"use client";

import { useEffect, useRef, useState } from "react";
import { Wifi, WifiOff } from "lucide-react";
import { useOnline } from "@/lib/use-online";

/**
 * U-08 — نوار وضعیت اتصال برای کل برنامه. وقتی اینترنت قطع شود، کاربر همان لحظه می‌فهمد (به‌جای اسپینر بی‌پایان)
 * و پس از وصل‌شدن، یک پیام کوتاه «اتصال برقرار شد» می‌بیند. فرم‌ها دست‌نخورده می‌مانند.
 */
export default function OfflineBanner() {
  const online = useOnline();
  const wasOffline = useRef(false);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      return;
    }
    if (!wasOffline.current) return;
    wasOffline.current = false;
    const show = window.setTimeout(() => setRestored(true), 0);
    const hide = window.setTimeout(() => setRestored(false), 3500);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [online]);

  if (online && !restored) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className={`no-print fixed inset-x-0 top-0 z-[120] flex items-center justify-center gap-2 px-4 py-2 text-center text-xs font-bold shadow-md ${online ? "bg-emerald-600 text-white" : "bg-amber-400 text-ink"}`}
    >
      {online ? <Wifi size={15} aria-hidden="true" /> : <WifiOff size={15} aria-hidden="true" />}
      {online ? "اتصال برقرار شد؛ می‌توانید ادامه دهید." : "اینترنت شما قطع است. اطلاعاتی که وارد کرده‌اید حفظ می‌شود؛ پس از وصل‌شدن دوباره تلاش کنید."}
    </div>
  );
}
