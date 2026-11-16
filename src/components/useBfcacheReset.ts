"use client";

import { useEffect } from "react";

/**
 * بن‌بست «دکمه‌ی بازگشت مرورگر از صفحه‌ی درگاه»: مرورگر صفحه را از bfcache با همان حالت قبلی (دکمه‌ی در حال بارگذاری/غیرفعال) برمی‌گرداند
 * و کاربر نمی‌تواند دوباره پرداخت کند. هنگام بازگشت از cache صفحه از نو بارگذاری می‌شود تا وضعیت تازه و دکمه‌ها فعال باشند.
 */
export function useBfcacheReset(): void {
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
}
