"use client";

import { useEffect, useState, type ComponentType } from "react";
import type { ChatWidgetContext } from "@/modules/chat/meta";
import SilentBoundary from "@/components/ui/SilentBoundary";

type Loaded = ComponentType<{ context: ChatWidgetContext }>;

/**
 * P-2x: ویجت گفتگو (~۲۰ کیلوبایت + وابستگی‌ها) عنصر «غیربحرانی» است ولی در باندل اولیه‌ی صفحه‌ی امضا، پرداخت، قیمت‌ها و همه‌ی
 * صفحه‌های پنل می‌رفت و (به‌ویژه روی موبایل ضعیف امضاکننده) با محتوای اصلی رقابت می‌کرد.
 * اکنون chunk جدا است و فقط پس از بیکاری مرورگر (یا حداکثر ۲ ثانیه) بارگذاری می‌شود.
 *
 * U-07: پیش‌تر از `next/dynamic` استفاده می‌شد؛ اگر کاربر در فاصله‌ی بارگذاری آفلاین می‌شد، `import()` با ChunkLoadError رد می‌شد،
 * خطا در رندر پرتاب می‌شد و کل صفحه‌ی امضا/پرداخت سقوط می‌کرد — فقط به‌خاطر یک دکمه‌ی گفتگو!
 * اکنون: بارگذاری با `import()` دستی، خطا بلعیده می‌شود، با برگشت اینترنت (و حداکثر ۳ بار) دوباره تلاش می‌شود،
 * و هر خطای رندر ویجت داخل مرز خطای «ساکت» می‌ماند (ویجت ناپدید می‌شود، صفحه سالم می‌ماند).
 */
export default function LazyChatWidget({ context }: { context: ChatWidgetContext }) {
  const [Comp, setComp] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let dead = false;
    let retryOnOnline: (() => void) | null = null;
    const load = () => {
      import("./ChatWidget")
        .then((m) => {
          if (!dead) setComp(() => m.default as Loaded);
        })
        .catch(() => {
          if (dead || attempt >= 3) return; // ویجت اختیاری است؛ بی‌صدا رها می‌شود
          retryOnOnline = () => setAttempt((n) => n + 1);
          window.addEventListener("online", retryOnOnline, { once: true });
        });
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (w.requestIdleCallback) idle = w.requestIdleCallback(load, { timeout: 2000 });
    else timer = setTimeout(load, 1200);
    return () => {
      dead = true;
      if (idle !== undefined) w.cancelIdleCallback?.(idle);
      if (timer) clearTimeout(timer);
      if (retryOnOnline) window.removeEventListener("online", retryOnOnline);
    };
  }, [attempt]);

  if (!Comp) return null;
  return (
    <SilentBoundary>
      <Comp context={context} />
    </SilentBoundary>
  );
}
