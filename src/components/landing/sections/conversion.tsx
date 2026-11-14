"use client";
import { ArrowLeft, Check, ChevronDown } from "lucide-react";
import { Btn, type Ctx, Heading, SmartLink, Wrap, arr, delay, resolveLink, s } from "./shared";
import { DEFAULT_PLANS, planFeatures } from "@/modules/billing/plans";
import { type Props } from "@/modules/landing/schema";

const money = (n: number) => `${n.toLocaleString("fa-IR")} تومان`;
export function Pricing({ p, ctx }: { p: Props; ctx: Ctx }) {
  const plans = ctx.plans ?? DEFAULT_PLANS.filter((x) => x.isPublic);
  const cols = plans.length >= 4 ? "md:grid-cols-2 xl:grid-cols-4" : plans.length === 3 ? "md:grid-cols-3" : plans.length === 2 ? "md:grid-cols-2 md:mx-auto md:max-w-3xl" : "mx-auto max-w-md";
  return (
    <div className="py-20">
      <Wrap>
        <Heading eyebrow={s(p, "eyebrow")} heading={s(p, "heading")} sub={s(p, "subheading")} />
        <div className={`grid gap-5 ${cols}`}>
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
                  {planFeatures(plan).map((f) => <li key={f} className="flex items-start gap-2.5 text-sm"><Check size={17} className="lp-accent-text mt-0.5 flex-none" aria-hidden />{f}</li>)}
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
