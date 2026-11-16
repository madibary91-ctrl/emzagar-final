"use client";

import "@fontsource/vazirmatn/400.css";
import "@fontsource/vazirmatn/700.css";
import "@fontsource/vazirmatn/900.css";
import "./globals.css";

/** آخرین خط دفاع: وقتی خود layout هم خطا بدهد (مثلاً قطعی دیتابیس) */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="fa" dir="rtl" data-theme="light">
      <body>
        <main className="grid min-h-screen place-items-center bg-paper px-4 py-10">
          <div className="panel-solid w-full max-w-md p-8 text-center sm:p-10" role="alert">
            <h1 className="text-xl font-black">سرویس موقتاً در دسترس نیست</h1>
            <p className="mt-2 text-sm leading-7 text-ink/70">اتصال به سامانه برقرار نشد. چند لحظه بعد دوباره تلاش کنید.</p>
            {error.digest && <p className="mt-4 text-xs text-ink/70">کد پیگیری: <span dir="ltr" className="font-mono font-bold">{error.digest}</span></p>}
            <div className="mt-7 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={reset} className="btn-primary">تلاش دوباره</button>
              <button type="button" onClick={() => window.location.reload()} className="btn-secondary">تازه‌سازی صفحه</button>
              <button type="button" onClick={() => window.location.assign("/")} className="btn-secondary">صفحه‌ی اصلی</button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
