"use client";

import { Moon, Sun } from "lucide-react";
import { setThemeAction } from "@/modules/branding/actions";

/** تغییر لحظه‌ای تم + ذخیره‌ی انتخاب کاربر در کوکی */
export default function ThemeToggle() {
  const toggle = () => {
    const root = document.documentElement;
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    void setThemeAction(next);
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="تغییر حالت تاریک/روشن"
      title="تغییر حالت تاریک/روشن"
      className="grid h-10 w-10 place-items-center rounded-xl border border-ink/10 bg-white text-ink/70 transition hover:text-ink"
    >
      <Sun size={17} className="hidden [html[data-theme=dark]_&]:block" />
      <Moon size={17} className="block [html[data-theme=dark]_&]:hidden" />
    </button>
  );
}
