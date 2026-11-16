"use client";

import { useEffect } from "react";

/**
 * قفل اسکرول بدنه با «شمارنده» (F-04).
 *
 * باگ قبلی: هر لایه (منوی موبایل، مودال، دستیار AI) هنگام باز شدن مقدار فعلیِ `body.style.overflow` را ذخیره و هنگام بستن
 * برمی‌گرداند. اگر منو باز بود، مودال بالای آن باز می‌شد (ذخیره‌ی «hidden») و منو پیش از مودال بسته می‌شد،
 * آخرین بازگردانی مقدار «hidden» را برای همیشه روی بدنه جا می‌گذاشت ← صفحه تا رفرش قفل می‌ماند.
 *
 * اکنون مقدار اولیه فقط توسط «اولین» قفل ذخیره و فقط توسط «آخرین» آزادسازی برگردانده می‌شود؛
 * ترتیب باز/بسته‌شدن لایه‌ها دیگر مهم نیست.
 */
let locks = 0;
let saved: { overflow: string; paddingRight: string } | null = null;

export function lockBodyScroll(): () => void {
  if (typeof document === "undefined") return () => undefined;
  const body = document.body;
  if (locks === 0) {
    saved = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
    // جلوگیری از «پرش» صفحه هنگام ناپدید شدن نوار اسکرول در دسکتاپ
    const gap = window.innerWidth - document.documentElement.clientWidth;
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    body.style.overflow = "hidden";
  }
  locks += 1;
  let released = false;
  return () => {
    if (released) return; // آزادسازی تکراری شمارنده را خراب نکند
    released = true;
    locks = Math.max(0, locks - 1);
    if (locks === 0 && saved) {
      body.style.overflow = saved.overflow;
      body.style.paddingRight = saved.paddingRight;
      saved = null;
    }
  };
}

/** در حالی که `active` درست است اسکرول پس‌زمینه قفل می‌ماند. */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return lockBodyScroll();
  }, [active]);
}
