"use client";

import type { ClipboardEvent, FocusEvent, KeyboardEvent } from "react";
import { normalizeOtp, OTP_PLACEHOLDER } from "@/lib/otp-client";
import { normalizeDigits } from "@/lib/numbers";

const FA = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (s: string) => s.replace(/\d/g, (d) => FA[Number(d)]);

/**
 * فیلد واحد کد تأیید (U-01…U-05): طول را از سرور می‌پذیرد (تا ۸ رقم)، ارقام فارسی/عربی را یکسان می‌کند،
 * هنگام چسباندن پیامک کامل فقط خود کد را برمی‌دارد، و هنگام فوکوس (کیبورد موبایل) فیلد را وسط صفحه نگه می‌دارد
 * تا دکمه‌ی «تأیید» زیر کیبورد گم نشود (U-17/U-18).
 */
export default function OtpInput({
  id,
  value,
  onChange,
  onSubmit,
  autoFocus,
  className = "input otp-input w-full max-w-64",
  describedBy,
  ariaLabel,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  autoFocus?: boolean;
  className?: string;
  describedBy?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = normalizeDigits(e.clipboardData.getData("text"));
    const m = text.match(/\d{5,8}/);
    if (!m) return; // الگوی ناآشنا: رفتار پیش‌فرض + پاک‌سازی در onChange
    e.preventDefault();
    onChange(normalizeOtp(m[0]));
  };
  const onFocus = (e: FocusEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    // پس از باز شدن کیبورد، فیلد (و دکمه‌ی زیرش) در دید بماند
    window.setTimeout(() => el.scrollIntoView?.({ block: "center", behavior: "smooth" }), 320);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };
  return (
    <input
      id={id}
      value={faDigits(value)}
      onChange={(e) => onChange(normalizeOtp(e.target.value))}
      onPaste={onPaste}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      inputMode="numeric"
      pattern="[0-9۰-۹]*"
      autoComplete="one-time-code"
      enterKeyHint="done"
      autoFocus={autoFocus}
      dir="ltr"
      placeholder={OTP_PLACEHOLDER}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      disabled={disabled}
      className={className}
    />
  );
}
