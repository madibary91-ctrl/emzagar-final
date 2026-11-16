"use client";
import { Heading, Wrap, arr, delay, s } from "./shared";
import { type Props } from "@/modules/landing/schema";
import { Quote } from "lucide-react";

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
