"use client";

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Check, ChevronDown, Fingerprint, Quote, ShieldCheck } from "lucide-react";
import { PLANS } from "@/modules/billing/plans";
import type { Props } from "@/modules/landing/schema";
import { Icon } from "./icons";

export type Ctx = { loggedIn: boolean; panelHref: string; brandName: string; editing: boolean };

export const s = (p: Props, k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "");
export const b = (p: Props, k: string): boolean => p[k] === true;
export const arr = (p: Props, k: string): Props[] => (Array.isArray(p[k]) ? (p[k] as Props[]) : []);

const delay = (i: number): CSSProperties => ({ ["--d" as string]: `${Math.min(i, 8) * 70}ms` });

/** لینک هوشمند: داخلی با Link، بیرونی با a؛ برای کاربر واردشده «ثبت‌نام/ورود» به پنل تبدیل می‌شود */
export function resolveLink(href: string, label: string, ctx: Ctx): { href: string; label: string } {
  if (ctx.loggedIn && (href === "/register" || href === "/login")) return { href: ctx.panelHref, label: "ورود به پنل" };
  return { href, label };
}

export function SmartLink({ href, className, children, ctx }: { href: string; className?: string; children: ReactNode; ctx: Ctx }) {
  if (ctx.editing) return <span role="link" className={className}>{children}</span>;
  if (/^\/(?!\/)/.test(href)) return <Link href={href} className={className}>{children}</Link>;
  const external = /^https?:/i.test(href);
  return <a href={href} className={className} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>;
}

function Btn({ href, label, kind, ctx, arrow }: { href: string; label: string; kind: string; ctx: Ctx; arrow?: boolean }) {
  if (!label || !href) return null;
  const r = resolveLink(href, label, ctx);
  return (
    <SmartLink href={r.href} ctx={ctx} className={`lp-btn ${kind}`}>
      {r.label}
      {arrow && <ArrowLeft size={16} aria-hidden />}
    </SmartLink>
  );
}

function Heading({ eyebrow, heading, sub, center = true }: { eyebrow?: string; heading?: string; sub?: string; center?: boolean }) {
  if (!eyebrow && !heading && !sub) return null;
  return (
    <div className={`lp-reveal mb-12 max-w-2xl ${center ? "mx-auto text-center" : ""}`}>
      {eyebrow && <span className="lp-chip">{eyebrow}</span>}
      {heading && <h2 className="mt-4 text-3xl font-black leading-[1.35] tracking-tight text-balance sm:text-4xl">{heading}</h2>}
      {sub && <p className="lp-muted mt-4 text-[15px] leading-8">{sub}</p>}
    </div>
  );
}

const Wrap = ({ children, className = "" }: { children: ReactNode; className?: string }) => <div className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`}>{children}</div>;

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

export function Logos({ p }: { p: Props }) {
  const items = arr(p, "items");
  if (!items.length && !s(p, "heading")) return null;
  return (
    <div className="lp-line-b py-12">
      <Wrap>
        {s(p, "heading") && <p className="lp-muted lp-reveal mb-7 text-center text-sm font-bold">{s(p, "heading")}</p>}
        <div className="lp-reveal flex flex-wrap items-center justify-center gap-x-10 gap-y-5" style={delay(1)}>
          {items.map((it, i) =>
            s(it, "image") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={s(it, "image")} alt={s(it, "label")} loading="lazy" decoding="async" className="h-9 w-auto max-w-[140px] object-contain opacity-70" />
            ) : (
              <span key={i} className="lp-muted text-lg font-black">{s(it, "label")}</span>
            ),
          )}
        </div>
      </Wrap>
    </div>
  );
}

export function Stats({ p }: { p: Props }) {
  const items = arr(p, "items");
  if (!items.length) return null;
  return (
    <div className="py-14">
      <Wrap>
        <div className="grid grid-cols-2 gap-y-10 lg:[grid-template-columns:repeat(var(--n),minmax(0,1fr))]" style={{ ["--n" as string]: items.length }}>
          {items.map((it, i) => (
            <div key={i} className="lp-reveal px-3 text-center" style={delay(i)}>
              <div className="lp-accent-text text-3xl font-black tracking-tight sm:text-4xl" dir="auto">{s(it, "value")}</div>
              <p className="lp-muted mt-2 text-sm leading-6">{s(it, "label")}</p>
            </div>
          ))}
        </div>
      </Wrap>
    </div>
  );
}

const COLS: Record<string, string> = { "2": "sm:grid-cols-2", "3": "sm:grid-cols-2 lg:grid-cols-3", "4": "sm:grid-cols-2 lg:grid-cols-4" };

export function Features({ p }: { p: Props }) {
  const minimal = s(p, "style") === "minimal";
  return (
    <div className="py-20">
      <Wrap>
        <Heading eyebrow={s(p, "eyebrow")} heading={s(p, "heading")} sub={s(p, "subheading")} />
        <div className={`grid gap-5 ${COLS[s(p, "columns")] ?? COLS["3"]}`}>
          {arr(p, "items").map((it, i) => (
            <article key={i} className={`lp-reveal ${minimal ? "p-2" : "lp-card p-6 transition hover:-translate-y-1"}`} style={delay(i)}>
              <span className="lp-icon-box"><Icon name={s(it, "icon")} /></span>
              <h3 className="mt-5 text-lg font-black">{s(it, "title")}</h3>
              <p className="lp-muted mt-2 text-sm leading-8">{s(it, "text")}</p>
            </article>
          ))}
        </div>
      </Wrap>
    </div>
  );
}

export function Steps({ p }: { p: Props }) {
  const items = arr(p, "items");
  return (
    <div className="lp-alt py-20">
      <Wrap>
        <Heading eyebrow={s(p, "eyebrow")} heading={s(p, "heading")} sub={s(p, "subheading")} />
        <ol className={`grid gap-6 sm:grid-cols-2 ${items.length >= 4 ? "lg:grid-cols-4" : items.length === 3 ? "lg:grid-cols-3" : ""}`}>
          {items.map((it, i) => (
            <li key={i} className="lp-reveal lp-card relative p-6" style={delay(i)}>
              <span className="grid h-11 w-11 place-items-center rounded-full text-lg font-black" style={{ background: "var(--lp-accent)", color: "var(--lp-on-accent)" }}>{(i + 1).toLocaleString("fa-IR")}</span>
              <h3 className="mt-5 text-base font-black">{s(it, "title")}</h3>
              <p className="lp-muted mt-2 text-sm leading-8">{s(it, "text")}</p>
            </li>
          ))}
        </ol>
      </Wrap>
    </div>
  );
}

export function Showcase({ p, ctx }: { p: Props; ctx: Ctx }) {
  return (
    <div className="py-20">
      <Wrap>
        <Heading eyebrow={s(p, "eyebrow")} heading={s(p, "heading")} />
        <div className="space-y-20">
          {arr(p, "items").map((it, i) => {
            const bullets = s(it, "bullets").split("\n").map((x) => x.trim()).filter(Boolean);
            return (
              <div key={i} className="grid items-center gap-10 md:grid-cols-2 md:gap-16">
                <div className={`lp-reveal ${i % 2 ? "md:order-2" : ""}`}>
                  <span className="lp-icon-box"><Icon name={s(it, "icon")} /></span>
                  <h3 className="mt-5 text-2xl font-black leading-[1.5] text-balance">{s(it, "title")}</h3>
                  <p className="lp-muted mt-3 text-[15px] leading-9">{s(it, "text")}</p>
                  {bullets.length > 0 && (
                    <ul className="mt-5 space-y-3">
                      {bullets.map((x, j) => <li key={j} className="flex items-start gap-3 text-sm font-semibold"><Check size={18} className="lp-accent-text mt-0.5 flex-none" aria-hidden />{x}</li>)}
                    </ul>
                  )}
                  {s(it, "ctaLabel") && s(it, "ctaHref") && <div className="mt-7"><Btn href={s(it, "ctaHref")} label={s(it, "ctaLabel")} kind="lp-btn-outline" ctx={ctx} arrow /></div>}
                </div>
                <div className={`lp-reveal ${i % 2 ? "md:order-1" : ""}`} style={delay(2)}>
                  {s(it, "image") ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={s(it, "image")} alt={s(it, "title")} loading="lazy" decoding="async" className="w-full object-cover" style={{ borderRadius: "var(--lp-r)", border: "1px solid var(--lp-line)" }} />
                  ) : (
                    <div className="lp-brand-bg grid aspect-[4/3] place-items-center" style={{ borderRadius: "var(--lp-r)" }}>
                      <span className="grid h-24 w-24 place-items-center rounded-[28px]" style={{ background: "var(--lp-accent)", color: "var(--lp-on-accent)" }}><Icon name={s(it, "icon")} size={44} /></span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Wrap>
    </div>
  );
}

export function Testimonials({ p }: { p: Props }) {
  const items = arr(p, "items");
  return (
    <div className="lp-alt py-20">
      <Wrap>
        <Heading eyebrow={s(p, "eyebrow")} heading={s(p, "heading")} />
        <div className={`grid gap-5 ${items.length === 1 ? "mx-auto max-w-xl" : items.length === 2 ? "md:grid-cols-2" : "md:grid-cols-2 lg:grid-cols-3"}`}>
          {items.map((it, i) => (
            <figure key={i} className="lp-reveal lp-card flex flex-col p-7" style={delay(i)}>
              <Quote size={28} className="lp-accent-text opacity-70" aria-hidden />
              <blockquote className="mt-4 flex-1 text-[15px] leading-9">{s(it, "quote")}</blockquote>
              <figcaption className="mt-6 flex items-center gap-3">
                {s(it, "avatar") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s(it, "avatar")} alt="" loading="lazy" decoding="async" className="h-11 w-11 rounded-full object-cover" />
                ) : (
                  <span className="grid h-11 w-11 place-items-center rounded-full font-black" style={{ background: "var(--lp-accent)", color: "var(--lp-on-accent)" }}>{s(it, "name").slice(0, 1)}</span>
                )}
                <div><b className="block text-sm">{s(it, "name")}</b><span className="lp-muted text-xs">{s(it, "role")}</span></div>
              </figcaption>
            </figure>
          ))}
        </div>
      </Wrap>
    </div>
  );
}

const money = (n: number) => `${n.toLocaleString("fa-IR")} تومان`;

export function Pricing({ p, ctx }: { p: Props; ctx: Ctx }) {
  const plans = Object.values(PLANS);
  return (
    <div className="py-20">
      <Wrap>
        <Heading eyebrow={s(p, "eyebrow")} heading={s(p, "heading")} sub={s(p, "subheading")} />
        <div className="grid gap-5 md:grid-cols-3">
          {plans.map((plan, i) => {
            const hl = !!plan.highlight;
            const cta = resolveLink("/register", plan.priceToman === 0 ? "شروع رایگان" : "انتخاب طرح", ctx);
            return (
              <article key={plan.id} className="lp-reveal lp-card relative flex flex-col p-7" style={{ ...delay(i), ...(hl ? { borderColor: "var(--lp-accent)", boxShadow: "0 24px 60px color-mix(in srgb, var(--lp-accent) 22%, transparent)" } : {}) }}>
                {hl && <span className="lp-chip absolute -top-3 right-6" style={{ background: "var(--lp-accent)", color: "var(--lp-on-accent)" }}>محبوب‌ترین</span>}
                <h3 className="text-lg font-black">{plan.name}</h3>
                <p className="lp-muted mt-1 text-xs">{plan.tagline}</p>
                <div className="mt-6 flex items-baseline gap-2">
                  <span className="text-3xl font-black">{plan.priceToman === 0 ? "رایگان" : money(plan.priceToman)}</span>
                  {plan.priceToman > 0 && <span className="lp-muted text-xs">/ ماه</span>}
                </div>
                <ul className="mt-6 flex-1 space-y-3">
                  {plan.features.map((f) => <li key={f} className="flex items-start gap-2.5 text-sm"><Check size={17} className="lp-accent-text mt-0.5 flex-none" aria-hidden />{f}</li>)}
                </ul>
                <SmartLink href={cta.href} ctx={ctx} className={`lp-btn mt-8 ${hl ? "lp-btn-accent" : "lp-btn-outline"}`}>{cta.label}</SmartLink>
              </article>
            );
          })}
        </div>
        <div className="lp-reveal mt-9 text-center">
          {s(p, "footnote") && <p className="lp-muted mb-4 text-xs">{s(p, "footnote")}</p>}
          {s(p, "ctaLabel") && <SmartLink href="/pricing" ctx={ctx} className="lp-btn lp-btn-outline lp-btn-sm">{s(p, "ctaLabel")}<ArrowLeft size={15} aria-hidden /></SmartLink>}
        </div>
      </Wrap>
    </div>
  );
}

export function Faq({ p }: { p: Props }) {
  return (
    <div className="lp-alt py-20">
      <Wrap className="max-w-3xl">
        <Heading eyebrow={s(p, "eyebrow")} heading={s(p, "heading")} />
        <div className="space-y-3">
          {arr(p, "items").map((it, i) => (
            <details key={i} className="lp-reveal lp-faq lp-card group px-6 py-5" style={{ ...delay(i), borderRadius: "var(--lp-r-sm)" }}>
              <summary className="flex items-center justify-between gap-4 text-[15px] font-black">
                <span>{s(it, "q")}</span>
                <ChevronDown size={20} className="lp-faq-chevron lp-muted flex-none transition-transform" aria-hidden />
              </summary>
              <p className="lp-muted mt-4 text-sm leading-9">{s(it, "a")}</p>
            </details>
          ))}
        </div>
      </Wrap>
    </div>
  );
}

export function Cta({ p, ctx }: { p: Props; ctx: Ctx }) {
  const accent = s(p, "tone") === "accent";
  return (
    <div className="px-5 py-16 sm:px-8">
      <div className={`${accent ? "lp-accent-bg" : "lp-brand-bg"} lp-reveal mx-auto max-w-6xl px-6 py-16 text-center sm:px-12`} style={{ borderRadius: "calc(var(--lp-r) + 8px)" }}>
        <h2 className="mx-auto max-w-2xl text-3xl font-black leading-[1.4] text-balance sm:text-4xl">{s(p, "heading")}</h2>
        {s(p, "text") && <p className={`mx-auto mt-4 max-w-xl text-[15px] leading-8 ${accent ? "opacity-80" : "lp-muted"}`}>{s(p, "text")}</p>}
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Btn href={s(p, "primaryHref")} label={s(p, "primaryLabel")} kind={accent ? "lp-btn-solid" : "lp-btn-accent"} ctx={ctx} arrow />
          <Btn href={s(p, "secondaryHref")} label={s(p, "secondaryLabel")} kind={accent ? "lp-btn-outline" : "lp-btn-light"} ctx={ctx} />
        </div>
      </div>
    </div>
  );
}

export function TextBlock({ p }: { p: Props }) {
  const center = s(p, "align") === "center";
  const paras = s(p, "body").split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  return (
    <div className="py-16">
      <Wrap className="max-w-3xl">
        <div className={`lp-reveal ${center ? "text-center" : ""}`}>
          {s(p, "eyebrow") && <span className="lp-chip">{s(p, "eyebrow")}</span>}
          {s(p, "heading") && <h2 className="mt-4 text-3xl font-black leading-[1.4] text-balance">{s(p, "heading")}</h2>}
          <div className="mt-5 space-y-5">{paras.map((x, i) => <p key={i} className="lp-muted whitespace-pre-line text-[15px] leading-9">{x}</p>)}</div>
        </div>
      </Wrap>
    </div>
  );
}
