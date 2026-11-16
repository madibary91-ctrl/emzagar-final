"use client";

import { Component, type ReactNode } from "react";

/**
 * مرز خطای «ساکت» برای اجزای اختیاری (ویجت گفتگو، تزئینات …): اگر رندر بشکند، فقط خودِ جزء ناپدید می‌شود
 * و بقیه‌ی صفحه (فرم امضا/پرداخت) سالم می‌ماند. `fallback` اختیاری است.
 */
export default class SilentBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("[SilentBoundary] جزء اختیاری خطا داد و پنهان شد:", error);
  }
  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
