"use client";
import { type HistoryInfo } from "@/modules/health/types";
import { META, fa } from "./format";

export function Spark({ h }: { h?: HistoryInfo }) {
  const s = h?.samples ?? [];
  if (s.length < 2) return <div className="flex h-7 items-center text-[11px] text-ink/60">تاریخچه در حال جمع‌آوری است…</div>;
  const max = Math.max(200, ...s.map((x) => x.ms ?? 0));
  return (
    <div className="flex h-7 items-end gap-[2px]" role="img" aria-label={`نمودار تأخیر ${fa(s.length)} نمونه‌ی اخیر`}>
      {s.map((x, i) => (
        <span key={i} title={`${new Date(x.t).toLocaleTimeString("fa-IR")} · ${META[x.s].label}${x.ms != null ? ` · ${fa(x.ms)}ms` : ""}`} className={`w-[5px] rounded-sm ${META[x.s].dot} ${x.s === "ok" ? "opacity-60" : ""}`} style={{ height: `${Math.max(14, Math.min(100, ((x.ms ?? 0) / max) * 100))}%` }} />
      ))}
    </div>
  );
}
export function Ring({ score, verdict }: { score: number; verdict: string }) {
  const r = 52, c = 2 * Math.PI * r;
  const color = verdict === "ready" ? "#10b981" : verdict === "almost" ? "#f59e0b" : "#ef4444";
  return (
    <div className="relative h-36 w-36 shrink-0" role="img" aria-label={`امتیاز آمادگی ${fa(score)} از ۱۰۰`}>
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(16,44,49,.09)" strokeWidth="10" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} style={{ transition: "stroke-dashoffset .8s ease" }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <b className="text-3xl font-black tabular">{fa(score)}</b>
        <span className="text-[11px] font-semibold text-ink/70">از ۱۰۰</span>
      </div>
    </div>
  );
}
export type Toast = { kind: "ok" | "err"; text: string } | null;
