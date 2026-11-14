"use client";
import { Btn, type Ctx, Heading, Wrap, arr, delay, s } from "./shared";
import { Check } from "lucide-react";
import { Icon } from "../icons";
import { type Props } from "@/modules/landing/schema";

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
