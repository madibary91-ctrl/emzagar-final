"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { setTourStateAction } from "@/modules/onboarding/actions";
import { TOUR_STEPS, type TourStep } from "./steps";

export const START_TOUR_EVENT = "emz:start-tour";

type Box = { top: number; left: number; width: number; height: number };

const visible = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).getClientRects().length > 0;
const faNum = (n: number) => n.toLocaleString("fa-IR");

/** اولین عنصر «قابل‌دیدن» با این انتخاب‌گر (منوی کناری و کشوی موبایل هر دو یک data-tour دارند) */
function findTarget(selector: string): { present: boolean; el: HTMLElement | null } {
  const all = [...document.querySelectorAll(selector)];
  return { present: all.length > 0, el: (all.find(visible) as HTMLElement | undefined) ?? null };
}

/**
 * راهنمای تعاملی پنل: گام‌به‌گام، کنترل‌پذیر (بعدی/قبلی/رد کردن/بستن/Esc/کلیدهای جهت)،
 * ماندگار (پس از رد یا پایان دیگر خودکار باز نمی‌شود) و قابل‌اجرای دوباره (رویداد START_TOUR_EVENT).
 * عنصر مقصد پنهان (موبایل) ⇒ کارت وسط صفحه؛ عنصر ناموجود (نبود دسترسی) ⇒ گام حذف می‌شود.
 */
export default function OnboardingTour({ autoStart }: { autoStart: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<TourStep[]>([]);
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const [, startTransition] = useTransition();
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const autoTried = useRef(false);

  const step = steps[index];

  // پرچم هیدریشن (فقط سمت کلاینت پورتال رندر شود)
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  const begin = useCallback(() => {
    // گام‌هایی که مقصدشان در این صفحه/نقش وجود ندارد حذف می‌شوند
    const list = TOUR_STEPS.filter((s) => !s.target || findTarget(s.target).present);
    if (list.length === 0) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSteps(list);
    setIndex(0);
    setOpen(true);
  }, []);

  const close = useCallback(
    (state: "completed" | "dismissed") => {
      setOpen(false);
      startTransition(() => {
        void setTourStateAction(state);
      });
      returnFocus.current?.focus?.();
    },
    [startTransition],
  );

  // اجرای دستی (دکمه‌ی «؟» و صفحه‌ی تنظیمات)
  useEffect(() => {
    const on = () => begin();
    window.addEventListener(START_TOUR_EVENT, on);
    return () => window.removeEventListener(START_TOUR_EVENT, on);
  }, [begin]);

  // اجرای خودکار: فقط یک‌بار، فقط در صفحه‌های پنل، و نه در مرورگرهای خودکار (تست E2E)
  useEffect(() => {
    if (!autoStart || autoTried.current || !pathname.startsWith("/admin")) return;
    if (navigator.webdriver && !window.localStorage.getItem("emz_tour_force")) return;
    autoTried.current = true;
    const t = window.setTimeout(begin, 900);
    return () => window.clearTimeout(t);
  }, [autoStart, pathname, begin]);

  // محاسبه‌ی جعبه‌ی روشن‌شده‌ی عنصر مقصد
  const measure = useCallback(() => {
    if (!open || !step) return;
    const t = step.target ? findTarget(step.target).el : null;
    if (!t) {
      setBox(null);
      return;
    }
    const r = t.getBoundingClientRect();
    setBox({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 });
  }, [open, step]);

  useLayoutEffect(() => {
    if (!open || !step) return;
    const t = step.target ? findTarget(step.target).el : null;
    t?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // اندازه‌گیری همگام DOM پیش از paint (از پرش جایگاه جلوگیری می‌کند)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    measure();
    const on = () => requestAnimationFrame(measure);
    window.addEventListener("resize", on);
    window.addEventListener("scroll", on, true);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("scroll", on, true);
    };
  }, [open, step, measure]);

  // جای کارت توضیح کنار عنصر مقصد (در موبایل پایین صفحه چسبیده است)
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!open || !card) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!box || vw < 640) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPos(null);
      return;
    }
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const gap = 14;
    const m = 12;
    const cy = box.top + box.height / 2 - h / 2;
    const cx = box.left + box.width / 2 - w / 2;
    const candidates = [
      { ok: box.left - gap - w >= m, top: cy, left: box.left - gap - w },
      { ok: box.left + box.width + gap + w <= vw - m, top: cy, left: box.left + box.width + gap },
      { ok: box.top + box.height + gap + h <= vh - m, top: box.top + box.height + gap, left: cx },
      { ok: box.top - gap - h >= m, top: box.top - gap - h, left: cx },
    ];
    const pick = candidates.find((c) => c.ok) ?? { top: vh / 2 - h / 2, left: vw / 2 - w / 2 };
    setPos({ top: Math.min(Math.max(m, pick.top), vh - h - m), left: Math.min(Math.max(m, pick.left), vw - w - m) });
  }, [open, box, index]);

  // فوکوس روی دکمه‌ی اصلی هر گام
  useEffect(() => {
    if (open) primaryRef.current?.focus({ preventScroll: true });
  }, [open, index]);

  const last = index === steps.length - 1;
  const next = useCallback(() => (last ? close("completed") : setIndex((i) => i + 1)), [last, close]);
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // صفحه‌کلید: Esc بستن، جهت‌ها (راست‌به‌چپ: ← بعدی، → قبلی)، تله‌ی فوکوس
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close("dismissed");
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        prev();
      } else if (e.key === "Tab") {
        const nodes = [...(cardRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
        if (!nodes.length) return;
        const first = nodes[0];
        const lastEl = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          first.focus();
        } else if (!cardRef.current?.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close, next, prev]);

  if (!mounted || !open || !step) return null;

  const hiddenTarget = !!step.target && !box;
  const docked = !pos;
  const style = docked ? undefined : { top: pos.top, left: pos.left };

  return createPortal(
    <div className="no-print fixed inset-0 z-[400]" data-testid="tour-root">
      {/* لایه‌ی مسدودکننده‌ی کلیک پس‌زمینه */}
      <div className="absolute inset-0" aria-hidden="true" onClick={() => undefined} style={box ? undefined : { background: "rgba(10,22,24,.62)" }} />
      {box && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed rounded-2xl border-2 border-mint motion-safe:transition-all motion-safe:duration-300"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height, boxShadow: "0 0 0 9999px rgba(10,22,24,.62)" }}
        />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        data-testid="tour-card"
        style={style}
        className={
          docked
            ? "fixed inset-x-3 bottom-3 max-h-[75vh] overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-[380px] sm:-translate-x-1/2 sm:-translate-y-1/2"
            : "fixed w-[340px] max-w-[calc(100vw-24px)] rounded-3xl bg-white p-5 shadow-2xl"
        }
      >
        <div className="mb-2 flex items-start justify-between gap-3">
          <span className="rounded-full bg-ink px-2.5 py-1 text-[11px] font-bold text-mint" aria-live="polite">
            {faNum(index + 1)} از {faNum(steps.length)}
          </span>
          <button onClick={() => close("dismissed")} aria-label="بستن راهنما" className="grid h-9 w-9 place-items-center rounded-xl text-ink/70 hover:bg-ink/5" data-testid="tour-close">
            <X size={17} aria-hidden="true" />
          </button>
        </div>
        <h2 id="tour-title" className="text-base font-black">{step.title}</h2>
        <p id="tour-body" className="mt-2 text-[13px] leading-7 text-ink/80">{step.body}</p>
        {hiddenTarget && step.where && <p className="mt-2 rounded-xl bg-stone-100 p-2 text-xs text-ink/70">محل: {step.where} (با دکمه‌ی ☰ منو را باز کنید)</p>}

        <div className="mt-3 flex gap-1" aria-hidden="true">
          {steps.map((s, i) => (
            <span key={s.id} className={`h-1.5 flex-1 rounded-full ${i <= index ? "bg-mint" : "bg-stone-200"}`} />
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <button onClick={() => close("dismissed")} className="rounded-xl px-3 py-2 text-xs font-bold text-ink/72 hover:bg-ink/5" data-testid="tour-skip">
            رد کردن
          </button>
          <div className="flex gap-2">
            {index > 0 && (
              <button onClick={prev} className="btn-secondary !min-h-10 !px-3 !text-xs" data-testid="tour-prev">
                <ChevronRight size={14} aria-hidden="true" /> قبلی
              </button>
            )}
            <button ref={primaryRef} onClick={next} className="btn-primary !min-h-10 !px-4 !text-xs" data-testid="tour-next">
              {last ? "پایان" : "بعدی"} {!last && <ChevronLeft size={14} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
