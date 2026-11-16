"use client";
import { AlertTriangle, CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import { type HealthStatus } from "@/modules/health/types";

export const fa = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
export const META: Record<HealthStatus, { label: string; chip: string; dot: string; text: string; Icon: typeof CheckCircle2 }> = {
  ok: { label: "سالم", chip: "bg-emerald-50 text-emerald-800 border-emerald-200", dot: "bg-emerald-500", text: "text-emerald-700", Icon: CheckCircle2 },
  warn: { label: "هشدار", chip: "bg-amber-50 text-amber-800 border-amber-200", dot: "bg-amber-500", text: "text-amber-700", Icon: AlertTriangle },
  fail: { label: "خطا", chip: "bg-red-50 text-red-700 border-red-200", dot: "bg-red-500", text: "text-red-700", Icon: XCircle },
  unconfigured: { label: "تنظیم نشده", chip: "bg-slate-100 text-slate-700 border-slate-200", dot: "bg-slate-400", text: "text-slate-600", Icon: MinusCircle },
};
export const TONE: Record<string, string> = { ok: "text-emerald-700", warn: "text-amber-700", fail: "text-red-700" };
export function rel(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 8) return "هم‌اکنون";
  if (s < 60) return `${fa(s)} ثانیه پیش`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${fa(m)} دقیقه پیش`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${fa(h)} ساعت پیش`;
  return `${fa(Math.floor(h / 24))} روز پیش`;
}
export const dur = (a: string, b: string | null, now: number) => {
  const ms = (b ? new Date(b).getTime() : now) - new Date(a).getTime();
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${fa(m)} دقیقه` : m < 2880 ? `${fa(Math.round(m / 60))} ساعت` : `${fa(Math.round(m / 1440))} روز`;
};
