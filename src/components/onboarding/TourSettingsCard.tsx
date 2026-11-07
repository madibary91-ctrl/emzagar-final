"use client";

import { useState, useTransition } from "react";
import { Compass, RotateCcw } from "lucide-react";
import { resetTourAction } from "@/modules/onboarding/actions";
import { START_TOUR_EVENT } from "./OnboardingTour";

/** اجرای دوباره‌ی راهنمای پنل از تنظیمات */
export default function TourSettingsCard() {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);

  function run() {
    start(async () => {
      await resetTourAction();
      setDone(true);
      window.dispatchEvent(new Event(START_TOUR_EVENT));
    });
  }

  return (
    <section className="card flex flex-wrap items-center justify-between gap-4" aria-labelledby="tour-card-title">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-ink text-mint"><Compass size={20} aria-hidden="true" /></span>
        <div>
          <h2 id="tour-card-title" className="font-bold">راهنمای تعاملی پنل</h2>
          <p className="mt-0.5 text-xs text-stone-600">آشنایی قدم‌به‌قدم با بخش‌های اصلی؛ می‌توانید هر زمان آن را رد یا ببندید.</p>
          {done && <p role="status" className="mt-1 text-xs text-emerald-700">راهنما دوباره فعال شد.</p>}
        </div>
      </div>
      <button onClick={run} disabled={pending} className="btn-secondary" data-testid="tour-restart">
        <RotateCcw size={15} aria-hidden="true" />
        اجرای دوباره‌ی راهنما
      </button>
    </section>
  );
}
