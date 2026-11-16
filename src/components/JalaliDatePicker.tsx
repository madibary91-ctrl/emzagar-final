"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import {
  JALALI_MONTHS,
  JALALI_WEEKDAYS,
  JALALI_WEEKDAYS_SHORT,
  digitsToFa,
  formatJalali,
  isoToJalali,
  jalaliMonthLength,
  jalaliToIso,
  jalaliWeekday,
  parseJalaliInput,
  todayJalali,
  type JalaliDate,
} from "@/lib/jalali";

/**
 * تقویم شمسی یکپارچه‌ی همه‌ی فرم‌های سامانه.
 *
 *  format="iso"    (پیش‌فرض) — کاربر تاریخ شمسی می‌بیند/تایپ می‌کند؛ مقدارِ فرم تاریخ میلادی «YYYY-MM-DD» است
 *                  (دقیقاً همان قرارداد <input type="date"> پیشین؛ پس سرور و اکشن‌ها بدون تغییر کار می‌کنند).
 *  format="jalali" — مقدار همان متن شمسی «YYYY/MM/DD» است (فیلدهای تاریخ داخل قرارداد/فرم‌های جمع‌آوری)؛
 *                    متن دستی کاربر دست‌نخورده می‌ماند و اعتبارسنجی همچنان سمت سرور است.
 *
 * هم کنترل‌شده (value/onChange) و هم کنترل‌نشده (defaultValue + name برای فرم‌های سرور) کار می‌کند.
 * تایپ مستقیم (ارقام فارسی/لاتین، جداکننده‌ی / - .)، صفحه‌کلید کامل (فلش‌ها، PageUp/Down، Enter، Esc)،
 * حالت تیره، پنجره‌ی شناور بیرون از کادرهای overflow (جدول‌ها) و موبایل پشتیبانی می‌شود.
 */
export type JalaliDatePickerProps = {
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  format?: "iso" | "jalali";
  /** حداقل/حداکثر تاریخ مجاز (ISO میلادی) */
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  clearable?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
};

const POP_W = 304;
const YEAR_SPAN_BACK = 70;
const YEAR_SPAN_FWD = 30;

function toDisplay(canonical: string, format: "iso" | "jalali"): string {
  if (format === "jalali") return canonical;
  const j = isoToJalali(canonical);
  return j ? formatJalali(j, { persian: true }) : "";
}

function addDays(j: JalaliDate, delta: number): JalaliDate {
  const iso = jalaliToIso(j.jy, j.jm, j.jd);
  if (!iso) return j;
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return isoToJalali(d.toISOString().slice(0, 10)) ?? j;
}

function addMonths(j: { jy: number; jm: number }, delta: number): { jy: number; jm: number } {
  const idx = j.jy * 12 + (j.jm - 1) + delta;
  return { jy: Math.floor(idx / 12), jm: ((idx % 12) + 12) % 12 + 1 };
}

export default function JalaliDatePicker(props: JalaliDatePickerProps) {
  const { id, name, value, defaultValue, onChange, format = "iso", min, max, required, disabled, clearable = true, placeholder, className = "input", ...aria } = props;
  const autoId = useId();
  const inputId = id ?? `jdp-${autoId}`;
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue ?? "");
  const current = controlled ? (value as string) : inner;

  const [text, setText] = useState(() => toDisplay(current, format));
  const [synced, setSynced] = useState(current);
  if (current !== synced) {
    // تغییر از بیرون (مثلاً بازنشانی فرم یا بارگذاری ردیف دیگر): متن را با مقدار تازه هماهنگ کن
    setSynced(current);
    setText(toDisplay(current, format));
  }

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ jy: number; jm: number }>({ jy: 1400, jm: 1 });
  const [focusJd, setFocusJd] = useState(1);
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const parsed: JalaliDate | null = useMemo(() => {
    if (format === "iso") return isoToJalali(current);
    return parseJalaliInput(current);
  }, [current, format]);
  const invalid = text.trim() !== "" && (format === "iso" ? !isoToJalali(current) : !parseJalaliInput(text));

  const outOfRange = useCallback(
    (j: JalaliDate) => {
      const iso = jalaliToIso(j.jy, j.jm, j.jd);
      if (!iso) return true;
      return (!!min && iso < min) || (!!max && iso > max);
    },
    [min, max],
  );

  /* اعتبارسنجی بومی فرم: متن ناقص/نامعتبر ارسال فرم را متوقف می‌کند (فقط حالت iso؛ در حالت jalali سرور داور است) */
  useEffect(() => {
    inputRef.current?.setCustomValidity(invalid && format === "iso" ? "تاریخ شمسی معتبر نیست (مثلاً ۱۴۰۵/۰۲/۱۵)" : "");
  }, [invalid, text, format]);

  const emit = (next: string) => {
    setSynced(next);
    if (!controlled) setInner(next);
    onChange?.(next);
  };

  const onType = (raw: string) => {
    setText(raw);
    if (format === "jalali") {
      emit(raw);
      return;
    }
    const j = parseJalaliInput(raw);
    emit(j ? (jalaliToIso(j.jy, j.jm, j.jd) ?? "") : "");
  };

  const onBlur = () => {
    if (format === "iso") {
      if (current) setText(toDisplay(current, "iso"));
      return;
    }
    const j = parseJalaliInput(text);
    if (j) {
      const norm = formatJalali(j);
      if (norm !== text) {
        setText(norm);
        emit(norm);
      }
    }
  };

  function close(refocus = false) {
    setOpen(false);
    if (refocus) inputRef.current?.focus();
  }

  const pick = (j: JalaliDate) => {
    if (outOfRange(j)) return;
    const next = format === "iso" ? (jalaliToIso(j.jy, j.jm, j.jd) ?? "") : formatJalali(j);
    setText(toDisplay(next, format));
    emit(next);
    close(true);
  };

  const clear = () => {
    setText("");
    emit("");
    close(true);
  };

  const openPicker = () => {
    if (disabled) return;
    const base = parsed ?? todayJalali();
    setView({ jy: base.jy, jm: base.jm });
    setFocusJd(base.jd);
    setOpen(true);
  };

  /*
   * جای‌گذاری پنجره‌ی شناور (بیرون از هر overflow).
   * F-14: «ناحیه‌ی دیدنی» از visualViewport خوانده می‌شود، نه window.inner*: در iOS با باز شدن کیبورد (یا زوم)،
   * innerHeight کوچک نمی‌شود و تقویم زیر کیبورد/بیرون صفحه می‌افتاد. اگر ناحیه‌ی دیدنی از ارتفاع تقویم کمتر باشد،
   * تقویم خودش اسکرول‌پذیر می‌شود (maxH). تراز RTL: لبه‌ی راست تقویم هم‌تراز لبه‌ی راست فیلد و در صورت لزوم به داخل کشیده می‌شود.
   */
  const place = useCallback(() => {
    const w = wrapRef.current;
    if (!w) return;
    const r = w.getBoundingClientRect();
    const vv = window.visualViewport;
    const vw = vv?.width ?? window.innerWidth;
    const vh = vv?.height ?? window.innerHeight;
    const ox = vv?.offsetLeft ?? 0;
    const oy = vv?.offsetTop ?? 0;
    const m = 8;
    const natural = popRef.current?.scrollHeight ?? 400;
    const maxH = Math.max(160, vh - m * 2);
    const h = Math.min(natural, maxH);
    const width = Math.min(POP_W, vw - m * 2);
    let left = r.right - width; // لبه‌ی راست پنجره هم‌تراز لبه‌ی راست فیلد (RTL)
    left = Math.max(ox + m, Math.min(left, ox + vw - width - m));
    let top = r.bottom + 6;
    if (top + h > oy + vh - m && r.top - h - 6 >= oy + m) top = r.top - h - 6;
    top = Math.max(oy + m, Math.min(top, oy + vh - h - m));
    setPos({ top, left, maxH });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place, view.jy, view.jm]);

  useEffect(() => {
    if (!open) return;
    const onScrollResize = (e: Event) => {
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) return;
      place();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || wrapRef.current?.contains(t)) return;
      setOpen(false);
    };
    const vv = window.visualViewport;
    window.addEventListener("resize", onScrollResize);
    window.addEventListener("scroll", onScrollResize, true);
    vv?.addEventListener("resize", onScrollResize); // کیبورد iOS/اندروید، زوم، نوار آدرس
    vv?.addEventListener("scroll", onScrollResize);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("resize", onScrollResize);
      window.removeEventListener("scroll", onScrollResize, true);
      vv?.removeEventListener("resize", onScrollResize);
      vv?.removeEventListener("scroll", onScrollResize);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, place]);

  /* فوکوس روی روز جاری هنگام باز شدن و حرکت با صفحه‌کلید */
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLButtonElement>(`button[data-d="${focusJd}"]`)?.focus({ preventScroll: true }); // بدون پرش صفحه‌ی زیرین (iOS)
  }, [open, focusJd, view.jy, view.jm]);

  const moveFocus = (delta: number) => {
    const next = addDays({ jy: view.jy, jm: view.jm, jd: focusJd }, delta);
    setView({ jy: next.jy, jm: next.jm });
    setFocusJd(next.jd);
  };
  const moveMonth = (delta: number) => {
    const v = addMonths(view, delta);
    setView(v);
    setFocusJd(Math.min(focusJd, jalaliMonthLength(v.jy, v.jm)));
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // صفحه RTL است: فلش چپ = روز بعد، فلش راست = روز قبل
    const map: Record<string, () => void> = {
      ArrowLeft: () => moveFocus(1),
      ArrowRight: () => moveFocus(-1),
      ArrowDown: () => moveFocus(7),
      ArrowUp: () => moveFocus(-7),
      PageDown: () => moveMonth(1),
      PageUp: () => moveMonth(-1),
      Home: () => setFocusJd(1),
      End: () => setFocusJd(jalaliMonthLength(view.jy, view.jm)),
    };
    const fn = map[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  const onPopKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && (e.altKey || !text)) {
      e.preventDefault();
      openPicker();
    } else if (e.key === "Escape" && open) {
      setOpen(false);
    }
  };

  const today = open ? todayJalali() : null;
  const monthLen = jalaliMonthLength(view.jy, view.jm);
  const lead = jalaliWeekday(view.jy, view.jm, 1);
  const years = useMemo(() => {
    const t = todayJalali().jy;
    const from = Math.min(t - YEAR_SPAN_BACK, view.jy);
    const to = Math.max(t + YEAR_SPAN_FWD, view.jy);
    const out: number[] = [];
    for (let y = from; y <= to; y++) out.push(y);
    return out;
  }, [view.jy]);

  const gregLabel = (() => {
    const a = jalaliToIso(view.jy, view.jm, 1);
    const b = jalaliToIso(view.jy, view.jm, monthLen);
    if (!a || !b) return "";
    const f = (s: string) => new Date(`${s}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
    return f(a) === f(b) ? f(a) : `${f(a)} – ${f(b)}`;
  })();

  const popover =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label="تقویم شمسی"
            data-testid="jdp-popover"
            className="jdp-pop"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, maxHeight: pos?.maxH, overflowY: "auto", overscrollBehavior: "contain", visibility: pos ? "visible" : "hidden" }}
            onKeyDown={onPopKey}
          >
            <div className="jdp-head">
              <button type="button" className="jdp-nav" aria-label="ماه بعد" onClick={() => moveMonth(1)}>
                <ChevronLeft size={16} aria-hidden />
              </button>
              <select
                className="jdp-sel"
                aria-label="ماه"
                value={view.jm}
                onChange={(e) => {
                  const jm = Number(e.target.value);
                  setView({ jy: view.jy, jm });
                  setFocusJd(Math.min(focusJd, jalaliMonthLength(view.jy, jm)));
                }}
              >
                {JALALI_MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </select>
              <select
                className="jdp-sel"
                aria-label="سال"
                value={view.jy}
                onChange={(e) => {
                  const jy = Number(e.target.value);
                  setView({ jy, jm: view.jm });
                  setFocusJd(Math.min(focusJd, jalaliMonthLength(jy, view.jm)));
                }}
              >
                {years.map((y) => (
                  <option key={y} value={y}>{digitsToFa(String(y))}</option>
                ))}
              </select>
              <button type="button" className="jdp-nav" aria-label="ماه قبل" onClick={() => moveMonth(-1)}>
                <ChevronRight size={16} aria-hidden />
              </button>
            </div>

            <div className="jdp-grid" role="group" aria-label={`${JALALI_MONTHS[view.jm - 1]} ${digitsToFa(String(view.jy))}`} onKeyDown={onGridKey}>
              {JALALI_WEEKDAYS_SHORT.map((w, i) => (
                <div key={w} className={`jdp-wd${i === 6 ? " is-fri" : ""}`} title={JALALI_WEEKDAYS[i]} aria-hidden>{w}</div>
              ))}
              {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} aria-hidden />)}
              {Array.from({ length: monthLen }, (_, i) => {
                const jd = i + 1;
                const cell: JalaliDate = { jy: view.jy, jm: view.jm, jd };
                const selected = !!parsed && parsed.jy === view.jy && parsed.jm === view.jm && parsed.jd === jd;
                const isToday = !!today && today.jy === view.jy && today.jm === view.jm && today.jd === jd;
                const fri = (lead + i) % 7 === 6;
                return (
                  <button
                    key={jd}
                    type="button"
                    data-d={jd}
                    data-date={formatJalali(cell)}
                    tabIndex={jd === focusJd ? 0 : -1}
                    disabled={outOfRange(cell)}
                    aria-pressed={selected}
                    aria-current={isToday ? "date" : undefined}
                    aria-label={`${JALALI_WEEKDAYS[(lead + i) % 7]} ${digitsToFa(String(jd))} ${JALALI_MONTHS[view.jm - 1]} ${digitsToFa(String(view.jy))}`}
                    className={`jdp-day${fri ? " is-fri" : ""}${isToday ? " is-today" : ""}`}
                    onClick={() => pick(cell)}
                  >
                    {digitsToFa(String(jd))}
                  </button>
                );
              })}
            </div>

            <div className="jdp-greg" aria-hidden>{gregLabel}</div>
            <div className="jdp-foot">
              <button type="button" className="jdp-link" onClick={() => today && pick(today)} disabled={!today || outOfRange(today)}>امروز</button>
              {clearable && !required && current !== "" ? <button type="button" className="jdp-link" onClick={clear}>پاک کردن</button> : <span />}
              <button type="button" className="jdp-link" onClick={() => close(true)}>بستن</button>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div ref={wrapRef} className="jdp" data-testid="jdp" data-value={current}>
      <input
        ref={inputRef}
        id={inputId}
        name={format === "jalali" ? name : undefined}
        type="text"
        dir="ltr"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        maxLength={16}
        className={`${className} jdp-input`}
        value={text}
        required={required}
        disabled={disabled}
        placeholder={placeholder ?? "۱۴۰۵/۰۲/۱۵"}
        aria-invalid={invalid || undefined}
        aria-haspopup="dialog"
        aria-label={aria["aria-label"]}
        aria-describedby={aria["aria-describedby"]}
        onChange={(e) => onType(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onInputKey}
      />
      {format === "iso" && name ? <input type="hidden" name={name} value={current} /> : null}
      <button
        type="button"
        className="jdp-trigger"
        aria-label="باز کردن تقویم شمسی"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : openPicker())}
      >
        <CalendarDays size={18} aria-hidden />
      </button>
      {popover}
    </div>
  );
}
