"use client";

import Link from "next/link";
import { ArrowRight, Home, RotateCcw } from "lucide-react";

/**
 * U-14 — کارت‌های خطا/وضعیت (لینک نامعتبر، مهلت تمام‌شده، قرارداد لغوشده …) پیش‌تر هیچ خروجی نداشتند و کاربر موبایل
 * (به‌ویژه در مرورگر داخلی تلگرام بدون نوار آدرس) در بن‌بست می‌ماند. این بلوک همیشه سه راه خروج می‌دهد:
 * تازه‌سازی، بازگشت به صفحه‌ی قبل، و صفحه‌ی اصلی.
 */
export default function ExitActions({ home = "/", compact = false, onRetry }: { home?: string; compact?: boolean; onRetry?: () => void }) {
  const size = compact ? "btn-sm" : "";
  return (
    <div className="mt-6 flex flex-wrap justify-center gap-2" data-testid="exit-actions">
      <button type="button" onClick={onRetry ?? (() => window.location.reload())} className={`btn-primary ${size}`}>
        <RotateCcw size={15} aria-hidden="true" />
        {onRetry ? "تلاش دوباره" : "تازه‌سازی صفحه"}
      </button>
      <button
        type="button"
        onClick={() => {
          if (window.history.length > 1) window.history.back();
          else window.location.assign(home);
        }}
        className={`btn-secondary ${size}`}
      >
        <ArrowRight size={15} aria-hidden="true" />
        بازگشت
      </button>
      <Link href={home} className={`btn-secondary ${size}`}>
        <Home size={15} aria-hidden="true" />
        صفحه‌ی اصلی
      </Link>
    </div>
  );
}
