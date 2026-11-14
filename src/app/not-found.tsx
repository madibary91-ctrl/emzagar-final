import type { Metadata } from "next";
import Link from "next/link";

/** صفحه‌ی ۴۰۴ فارسی؛ هرگز ایندکس نمی‌شود (جلوگیری از «soft 404» در موتورهای جست‌وجو) */
export const metadata: Metadata = { title: "صفحه پیدا نشد", robots: { index: false, follow: false, nocache: true } };

export default function NotFound() {
  return (
    <main id="main-content" className="grid min-h-screen place-items-center p-6 text-center">
      <div>
        <h1 className="text-3xl font-black text-ink">۴۰۴ — صفحه پیدا نشد</h1>
        <p className="mt-3 text-sm text-stone-600">آدرس را بررسی کنید یا به صفحه‌ی اصلی برگردید.</p>
        <Link href="/" className="btn-primary mt-6 inline-flex">صفحه‌ی اصلی</Link>
      </div>
    </main>
  );
}
