"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ArrowRight, Home, RotateCcw, TriangleAlert, WifiOff } from "lucide-react";
import { useOnline } from "@/lib/use-online";

/** مرز خطای سراسری: پیام قابل‌فهم، تلاش مجدد، خروج امن (بازگشت/صفحه‌ی اصلی) و کد پیگیری برای پشتیبانی */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const online = useOnline();
  useEffect(() => {
    console.error(error);
  }, [error]);

  // U-14: با برگشت اینترنت، تلاش دوباره خودکار انجام می‌شود (کاربر موبایل نباید دکمه‌ای را حدس بزند)
  useEffect(() => {
    if (!online) return;
    const onOnline = () => reset();
    window.addEventListener("online", onOnline, { once: true });
    return () => window.removeEventListener("online", onOnline);
  }, [online, reset]);

  const goBack = () => {
    if (window.history.length > 1) window.history.back();
    else window.location.assign("/");
  };

  return (
    <main className="grid min-h-screen place-items-center bg-paper px-4 py-10">
      <div className="w-full max-w-md text-center">
        <div className="panel-solid p-8 sm:p-10" role="alert">
          <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-rose-50 text-rose-600">
            {online ? <TriangleAlert size={30} aria-hidden="true" /> : <WifiOff size={30} aria-hidden="true" />}
          </span>
          <h1 className="mt-5 text-xl font-black">{online ? "مشکلی پیش آمد" : "اینترنت شما قطع است"}</h1>
          <p className="mt-2 text-sm leading-7 text-ink/70">
            {online
              ? "بارگذاری این بخش با خطا روبه‌رو شد. اطلاعات شما از بین نرفته است. دوباره تلاش کنید؛ اگر ادامه داشت با پشتیبانی تماس بگیرید."
              : "اتصال برقرار نیست. به‌محض وصل‌شدن اینترنت، صفحه خودکار دوباره بارگذاری می‌شود. اطلاعات شما از بین نرفته است."}
          </p>
          {error.digest && (
            <p className="mt-4 rounded-xl bg-stone-100 px-3 py-2 text-xs text-ink/70">
              کد پیگیری: <span dir="ltr" className="font-mono font-bold">{error.digest}</span>
            </p>
          )}
          <div className="mt-7 flex flex-wrap justify-center gap-2">
            <button type="button" onClick={reset} className="btn-primary"><RotateCcw size={16} aria-hidden="true" />تلاش دوباره</button>
            <button type="button" onClick={goBack} className="btn-secondary"><ArrowRight size={16} aria-hidden="true" />بازگشت</button>
            <Link href="/" className="btn-secondary"><Home size={16} aria-hidden="true" />صفحه‌ی اصلی</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
