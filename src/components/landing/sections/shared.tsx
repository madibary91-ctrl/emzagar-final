"use client";
import { ArrowLeft } from "lucide-react";
import { type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { type Plan } from "@/modules/billing/plans";
import { type Props } from "@/modules/landing/schema";

export type Ctx = { loggedIn: boolean; panelHref: string; brandName: string; editing: boolean; plans?: Plan[] };
export const s = (p: Props, k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "");
export const b = (p: Props, k: string): boolean => p[k] === true;
export const arr = (p: Props, k: string): Props[] => (Array.isArray(p[k]) ? (p[k] as Props[]) : []);
export const delay = (i: number): CSSProperties => ({ ["--d" as string]: `${Math.min(i, 8) * 70}ms` });
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
export function Btn({ href, label, kind, ctx, arrow }: { href: string; label: string; kind: string; ctx: Ctx; arrow?: boolean }) {
  if (!label || !href) return null;
  const r = resolveLink(href, label, ctx);
  return (
    <SmartLink href={r.href} ctx={ctx} className={`lp-btn ${kind}`}>
      {r.label}
      {arrow && <ArrowLeft size={16} aria-hidden />}
    </SmartLink>
  );
}
export function Heading({ eyebrow, heading, sub, center = true }: { eyebrow?: string; heading?: string; sub?: string; center?: boolean }) {
  if (!eyebrow && !heading && !sub) return null;
  return (
    <div className={`lp-reveal mb-12 max-w-2xl ${center ? "mx-auto text-center" : ""}`}>
      {eyebrow && <span className="lp-chip">{eyebrow}</span>}
      {heading && <h2 className="mt-4 text-3xl font-black leading-[1.35] tracking-tight text-balance sm:text-4xl">{heading}</h2>}
      {sub && <p className="lp-muted mt-4 text-[15px] leading-8">{sub}</p>}
    </div>
  );
}
export const Wrap = ({ children, className = "" }: { children: ReactNode; className?: string }) => <div className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`}>{children}</div>;
