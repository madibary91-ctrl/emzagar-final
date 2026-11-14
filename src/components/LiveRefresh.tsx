"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** تازه‌سازی دوره‌ای داده‌های صفحه‌ی سرور (فقط وقتی تب فعال است) */
export default function LiveRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
