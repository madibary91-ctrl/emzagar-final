import { LoaderCircle } from "lucide-react";

/** نمایش سبک هنگام بارگذاری صفحه‌های عمومی و احراز هویت */
export default function Loading() {
  return (
    <main className="grid min-h-screen place-items-center bg-paper px-4" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-3 text-ink/70">
        <LoaderCircle size={28} className="animate-spin" aria-hidden="true" />
        <span className="text-sm font-semibold">در حال بارگذاری…</span>
      </div>
    </main>
  );
}
