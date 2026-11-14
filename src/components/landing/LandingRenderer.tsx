"use client";

import { useLayoutEffect, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { Menu, X } from "lucide-react";
import { contrastRatio, type LandingDoc, type Section } from "@/modules/landing/schema";
import type { Plan } from "@/modules/billing/plans";
import { Cta, Faq, Features, Hero, Logos, Pricing, Showcase, SmartLink, Stats, Steps, TextBlock, Testimonials, arr, b, resolveLink, s, type Ctx } from "./sections";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export type RendererCtx = { loggedIn: boolean; panelHref: string; brandName: string; /** طرح‌های عمومی از کاتالوگ دیتابیس (اگر ندهید، طرح‌های اولیه) */ plans?: Plan[] };

function SectionView({ section, ctx }: { section: Section; ctx: Ctx }) {
  const p = section.props;
  switch (section.type) {
    case "hero": return <Hero p={p} ctx={ctx} />;
    case "logos": return <Logos p={p} />;
    case "stats": return <Stats p={p} />;
    case "features": return <Features p={p} />;
    case "steps": return <Steps p={p} />;
    case "showcase": return <Showcase p={p} ctx={ctx} />;
    case "testimonials": return <Testimonials p={p} />;
    case "pricing": return <Pricing p={p} ctx={ctx} />;
    case "faq": return <Faq p={p} />;
    case "cta": return <Cta p={p} ctx={ctx} />;
    case "text": return <TextBlock p={p} />;
  }
}

function BrandMark({ doc, name, light }: { doc: LandingDoc; name: string; light?: boolean }) {
  const logo = s(doc.theme, "logo");
  return (
    <span className="flex items-center gap-3">
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt={name} className="h-9 w-auto max-w-[150px] object-contain" />
      ) : (
        <span className="grid h-10 w-10 place-items-center rounded-xl text-lg font-black" style={{ background: "var(--lp-primary)", color: "var(--lp-accent)" }}>{name.trim().slice(0, 1) || "ا"}</span>
      )}
      <b className={`text-lg font-black ${light ? "text-white" : ""}`}>{name}</b>
    </span>
  );
}

export function LandingRenderer({
  doc, ctx: base, editing = false, selected = null, onSelect,
}: {
  doc: LandingDoc;
  ctx: RendererCtx;
  editing?: boolean;
  selected?: string | null;
  onSelect?: (selection: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const ctx: Ctx = { ...base, brandName: s(doc.theme, "brandName") || base.brandName, editing };
  const primary = s(doc.theme, "primary") || "#102c31";
  const accent = s(doc.theme, "accent") || "#41e4ad";
  const dark = "#0b1a1d";
  const onAccent = contrastRatio(accent, dark) >= contrastRatio(accent, "#ffffff") ? dark : "#ffffff";
  const accentOnLight = contrastRatio(accent, "#fbfbf8") >= 3 ? accent : primary;
  const style = {
    "--lp-primary": primary,
    "--lp-accent": accent,
    "--lp-on-accent": onAccent,
    "--lp-accent-on-light": accentOnLight,
  } as CSSProperties;

  // منوی موبایل با Esc بسته می‌شود
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);

  // ظاهر شدن بخش‌ها هنگام اسکرول: پیش از اولین رنگ‌آمیزی تعیین می‌شود تا بخش‌های بالای صفحه پرش نکنند
  useIsoLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (editing) {
      root.removeAttribute("data-anim");
      return;
    }
    root.setAttribute("data-anim", "1");
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } }),
      { rootMargin: "0px 0px -6% 0px" },
    );
    root.querySelectorAll(".lp-reveal").forEach((el) => {
      if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add("is-in");
      else io.observe(el);
    });
    return () => io.disconnect();
  }, [editing, doc]);

  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (!editing) return;
    const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-sid],[data-gid]");
    e.preventDefault();
    e.stopPropagation();
    if (!hit) return;
    onSelect?.(hit.dataset.sid ? `sec:${hit.dataset.sid}` : `g:${hit.dataset.gid}`);
  };

  const mark = (key: string) => ({ "data-selected": selected === key ? "1" : undefined });
  const links = arr(doc.nav, "links").filter((l) => s(l, "label") && s(l, "href"));
  const navCta = resolveLink(s(doc.nav, "ctaHref") || "/login", s(doc.nav, "ctaLabel") || "ورود", ctx);
  const ann = b(doc.announcement, "enabled") && s(doc.announcement, "text");
  const brandName = ctx.brandName;

  return (
    <div ref={ref} className="lp" dir="rtl" data-mode={s(doc.theme, "mode") || "light"} data-radius={s(doc.theme, "radius") || "round"} data-editing={editing ? "1" : undefined} style={style} onClickCapture={onClickCapture}>
      {!editing && <a href="#main-content" className="skip-link">پرش به محتوای صفحه</a>}
      {ann && (
        <div data-gid="announcement" {...mark("g:announcement")} className="px-4 py-2.5 text-center text-sm font-bold" style={{ background: "var(--lp-accent)", color: "var(--lp-on-accent)" }}>
          {s(doc.announcement, "link") ? <SmartLink href={s(doc.announcement, "link")} ctx={ctx} className="underline-offset-4 hover:underline">{s(doc.announcement, "text")}</SmartLink> : s(doc.announcement, "text")}
        </div>
      )}

      <header data-gid="nav" {...mark("g:nav")} className="lp-line-b sticky top-0 z-40 backdrop-blur-xl" style={{ background: "color-mix(in srgb, var(--lp-bg) 82%, transparent)" }}>
        <div className="mx-auto flex h-[68px] max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
          <SmartLink href="/" ctx={ctx} className="flex-none"><BrandMark doc={doc} name={brandName} /></SmartLink>
          <nav className="hidden items-center gap-1 md:flex" aria-label="منوی اصلی">
            {links.map((l, i) => <SmartLink key={i} href={s(l, "href")} ctx={ctx} className="rounded-xl px-3.5 py-2 text-sm font-bold opacity-75 transition hover:opacity-100">{s(l, "label")}</SmartLink>)}
          </nav>
          <div className="flex items-center gap-2">
            <SmartLink href={navCta.href} ctx={ctx} className="lp-btn lp-btn-accent lp-btn-sm">{navCta.label}</SmartLink>
            <button type="button" className="grid h-11 w-11 place-items-center rounded-xl md:hidden" style={{ border: "1px solid var(--lp-line)" }} aria-label={menu ? "بستن منو" : "باز کردن منو"} aria-expanded={menu} aria-controls="lp-mobile-nav" onClick={() => setMenu((v) => !v)}>
              {menu ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>
        {menu && (
          <nav id="lp-mobile-nav" className="lp-line-t px-5 pb-4 pt-2 md:hidden" aria-label="منوی موبایل" style={{ background: "var(--lp-bg)" }} onClick={() => setMenu(false)}>
            {links.map((l, i) => <SmartLink key={i} href={s(l, "href")} ctx={ctx} className="block rounded-xl px-3 py-3 text-sm font-bold">{s(l, "label")}</SmartLink>)}
          </nav>
        )}
      </header>

      <main id="main-content" tabIndex={-1} className="outline-none">
        {doc.sections.filter((sec) => editing || sec.enabled).map((sec) => (
          <section key={sec.id} id={sec.id} data-sid={sec.id} {...mark(`sec:${sec.id}`)} data-off={sec.enabled ? undefined : "1"}>
            <SectionView section={sec} ctx={ctx} />
          </section>
        ))}
        {doc.sections.length === 0 && <div className="grid min-h-[50vh] place-items-center p-10 text-center"><p className="lp-muted">هنوز بخشی اضافه نشده است.</p></div>}
      </main>

      <footer data-gid="footer" {...mark("g:footer")} className="lp-alt lp-line-t">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:px-8 md:grid-cols-[1.4fr_repeat(2,1fr)]">
          <div>
            <BrandMark doc={doc} name={brandName} />
            {s(doc.footer, "about") && <p className="lp-muted mt-4 max-w-sm text-sm leading-8">{s(doc.footer, "about")}</p>}
          </div>
          {arr(doc.footer, "columns").map((col, i) => (
            <div key={i}>
              <b className="text-sm font-black">{s(col, "title")}</b>
              <ul className="mt-4 space-y-3">
                {arr(col, "links").filter((l) => s(l, "label") && s(l, "href")).map((l, j) => (
                  <li key={j}><SmartLink href={s(l, "href")} ctx={ctx} className="lp-muted text-sm transition hover:opacity-100">{s(l, "label")}</SmartLink></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {s(doc.footer, "copyright") && <div className="lp-line-t px-5 py-5 text-center text-xs"><span className="lp-muted">{s(doc.footer, "copyright")}</span></div>}
      </footer>
    </div>
  );
}
