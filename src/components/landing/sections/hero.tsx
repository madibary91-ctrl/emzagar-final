"use client";
import { Btn, type Ctx, Wrap, b, delay, s } from "./shared";
import { Check, Fingerprint, ShieldCheck } from "lucide-react";
import { type Props } from "@/modules/landing/schema";

/* ───────── تصویر متحرک قرارداد (هیرو) ───────── */
function MockContract({ brandName }: { brandName: string }) {
  return (
    <div className="relative mx-auto w-full max-w-[460px]" aria-hidden>
      <div className="absolute -inset-10 rounded-full blur-[70px]" style={{ background: "color-mix(in srgb, var(--lp-accent) 24%, transparent)" }} />
      <div className="relative rotate-[-3deg] overflow-hidden bg-[#fafbf7] p-6 text-[#102c31] shadow-[0_50px_100px_rgba(0,0,0,.35)] sm:p-7" style={{ borderRadius: "var(--lp-r)" }}>
        <div className="flex items-center justify-between gap-3 border-b border-black/10 pb-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="grid h-9 w-9 flex-none place-items-center rounded-xl text-sm font-black" style={{ background: "var(--lp-primary)", color: "var(--lp-accent)" }}>{brandName.trim().slice(0, 1) || "ا"}</span>
            <div className="min-w-0"><b className="block truncate text-xs">قرارداد همکاری</b><span className="text-xs opacity-50">EMZ-۱۴۰۵-۱۰۵۱</span></div>
          </div>
          <span className="badge flex-none bg-amber-100 text-amber-800"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" />در انتظار امضا</span>
        </div>
        <div className="space-y-3 py-5">
          <div className="h-2.5 w-2/3 rounded-full bg-black/15" />
          {["w-full", "w-11/12", "w-full", "w-4/5"].map((w, i) => <div key={i} className={`h-2 rounded-full bg-black/[.07] ${w}`} />)}
        </div>
        <div className="rounded-2xl border border-black/10 bg-white p-4">
          <div className="flex items-center justify-between text-xs"><b>محل امضا</b><span className="text-emerald-700">هویت تأیید شد ✓</span></div>
          <svg viewBox="0 0 300 100" className="mt-2 h-20 w-full" fill="none">
            <path pathLength={1} className="lp-sign-path" d="M15 66C47 10 54 11 43 61C37 89 65 65 82 41C96 21 89 75 109 54C130 31 137 31 125 60C150 48 166 32 178 28C164 46 153 67 181 52C213 34 232 49 282 25" stroke="#153a3d" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M18 84H278" stroke="#102c31" strokeOpacity=".15" strokeDasharray="4 5" />
          </svg>
        </div>
      </div>
      <div className="lp-float absolute -left-4 top-20 hidden items-center gap-2 rounded-2xl bg-white/95 p-3 text-[#102c31] shadow-xl sm:flex">
        <span className="grid h-8 w-8 place-items-center rounded-xl" style={{ background: "color-mix(in srgb, var(--lp-accent) 30%, white)" }}><Fingerprint size={16} /></span>
        <div><b className="block text-xs">احراز هویت موفق</b><span className="text-[11px] opacity-50">کد پیامکی</span></div>
      </div>
      <div className="lp-float absolute -right-3 bottom-16 hidden items-center gap-2 rounded-2xl bg-white/95 p-3 text-[#102c31] shadow-xl sm:flex" style={{ animationDelay: "-3s" }}>
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-[#e8e4ff] text-[#5a4d9b]"><ShieldCheck size={16} /></span>
        <div><b className="block text-xs">ردپای دیجیتال</b><span className="text-[11px] opacity-50">IP + SHA-256</span></div>
      </div>
    </div>
  );
}
/* ───────── بخش‌ها ───────── */
export function Hero({ p, ctx }: { p: Props; ctx: Ctx }) {
  const center = s(p, "variant") === "center";
  const brand = s(p, "tone") !== "surface";
  const image = s(p, "image");
  const visual = image ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt="" loading="eager" fetchPriority="high" decoding="async" className="mx-auto max-h-[460px] w-full object-contain" style={{ borderRadius: "var(--lp-r)" }} />
  ) : b(p, "showMock") ? <MockContract brandName={ctx.brandName} /> : null;
  return (
    <div className={`${brand ? "lp-brand-bg" : ""} py-16 sm:py-24`}>
      <Wrap className={visual && !center ? "grid items-center gap-14 lg:grid-cols-[1.05fr_.95fr]" : ""}>
        <div className={`lp-reveal ${center ? "mx-auto max-w-3xl text-center" : ""}`}>
          {s(p, "badge") && <span className="lp-chip">{s(p, "badge")}</span>}
          <h1 className="mt-6 text-[clamp(2rem,5.2vw,3.6rem)] font-black leading-[1.3] tracking-tight text-balance">
            {s(p, "title")}
            {s(p, "titleAccent") && <><br /><span className="lp-accent-text">{s(p, "titleAccent")}</span></>}
          </h1>
          {s(p, "subtitle") && <p className="lp-muted mt-6 max-w-xl text-base leading-9 sm:text-lg" style={center ? { marginInline: "auto" } : undefined}>{s(p, "subtitle")}</p>}
          <div className={`mt-9 flex flex-wrap gap-3 ${center ? "justify-center" : ""}`}>
            <Btn href={s(p, "primaryHref")} label={s(p, "primaryLabel")} kind="lp-btn-accent" ctx={ctx} arrow />
            <Btn href={s(p, "secondaryHref")} label={s(p, "secondaryLabel")} kind={brand ? "lp-btn-light" : "lp-btn-outline"} ctx={ctx} />
          </div>
          {s(p, "note") && <p className="lp-muted mt-5 flex items-center gap-2 text-xs" style={center ? { justifyContent: "center" } : undefined}><Check size={14} className="lp-accent-text" aria-hidden />{s(p, "note")}</p>}
        </div>
        {visual && <div className={`lp-reveal ${center ? "mx-auto mt-14 max-w-xl" : ""}`} style={delay(2)}>{visual}</div>}
      </Wrap>
    </div>
  );
}
