"use client";

import NotificationBell from "@/components/NotificationBell";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity, BarChart3, Bell, Boxes, Brain, CreditCard, ScanSearch, FileClock, FilePlus2, Files, FileText, Inbox, KeyRound, LayoutDashboard, LifeBuoy, LogOut, Menu, Palette, Plug, Settings, ShieldCheck, ShoppingBag, Timer, Users, UsersRound, X, LayoutTemplate, UserCog, Database, BadgeCheck, Store, CircleHelp, Wallet, Gift, UserCheck, HeartPulse, QrCode, FileUp, Zap, FileSpreadsheet, Coins, MessagesSquare,
} from "lucide-react";
import { Brand } from "@/components/Brand";
import ThemeToggle from "@/components/ThemeToggle";
import CommandPalette from "@/components/CommandPalette";
import OnboardingTour, { START_TOUR_EVENT } from "@/components/onboarding/OnboardingTour";
import WorkspaceSwitcher, { type WorkspaceInfo } from "@/components/WorkspaceSwitcher";

const ICONS = { files: Files, plus: FilePlus2, text: FileText, boxes: Boxes, logs: FileClock, settings: Settings, dash: LayoutDashboard, shop: ShoppingBag, bell: Bell, palette: Palette, timer: Timer, key: KeyRound, users: Users, team: UsersRound, chart: BarChart3, support: LifeBuoy, shield: ShieldCheck, inbox: Inbox, plug: Plug, pulse: Activity, scan: ScanSearch, brain: Brain, card: CreditCard, layout: LayoutTemplate, database: Database, license: BadgeCheck, store: Store, wallet: Wallet, gift: Gift, idcard: UserCheck, health: HeartPulse, qr: QrCode, upload: FileUp, zap: Zap, sheet: FileSpreadsheet, coins: Coins, chat: MessagesSquare };
export type NavItem = { href: string; label: string; caption: string; icon: keyof typeof ICONS; badge?: number; group?: string };

export type BrandInfo = { name: string; logoUrl: string | null; tagline: string };

export default function ShellNav({
  items, name, isAdmin, logout, children, wide, brand, workspace, switchAction, createAction, tourAuto,
}: {
  tourAuto?: boolean;
  workspace?: WorkspaceInfo;
  switchAction?: (fd: FormData) => Promise<void>;
  createAction?: (fd: FormData) => Promise<void>;
  brand: BrandInfo;
  items: NavItem[];
  name: string;
  isAdmin: boolean;
  logout: () => Promise<void>;
  children: ReactNode;
  wide?: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const home = isAdmin ? "/admin" : "/dashboard";
  const isActive = (href: string) => (href === "/admin" || href === "/dashboard" || href === "/platform" ? pathname === href : pathname.startsWith(href));
  const current = items.find((i) => isActive(i.href)) ?? (pathname.startsWith("/account") ? { label: "حساب من", caption: "مشخصات، رمز عبور و ورود دومرحله‌ای" } : undefined);
  const initials = name.trim().slice(0, 1);
  const drawerRef = useRef<HTMLElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);

  // منوی موبایل: Esc برای بستن، قفل اسکرول پس‌زمینه، تله‌ی فوکوس و بازگرداندن فوکوس
  useEffect(() => {
    if (!open) return;
    const el = drawerRef.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    el?.querySelector<HTMLElement>("a[href],button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); return; }
      if (e.key !== "Tab" || !el) return;
      const nodes = [...el.querySelectorAll<HTMLElement>("a[href],button:not([disabled]),input,select,textarea")].filter((n) => n.getClientRects().length > 0);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    const btn = menuBtn.current;
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      btn?.focus();
    };
  }, [open]);

  const renderNav = (onPick?: () => void) => (
    <nav aria-label="منوی اصلی" className="mt-3 pb-2">
      {items.map((item, i) => {
        const Icon = ICONS[item.icon];
        const active = isActive(item.href);
        const heading = item.group && item.group !== items[i - 1]?.group ? item.group : null;
        return (
          <div key={item.href}>
            {heading && <p className={`px-3 pb-1.5 text-xs font-extrabold tracking-wide text-ink/75 ${i === 0 ? "pt-1" : "pt-5"}`}>{heading}</p>}
            <Link
              href={item.href}
              onClick={onPick}
              data-tour={`nav:${item.href}`}
              title={item.caption}
              aria-current={active ? "page" : undefined}
              className={`group relative mb-0.5 flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-right transition ${active ? "bg-ink text-white shadow-md" : "text-ink/75 hover:bg-ink/[.06] hover:text-ink"}`}
            >
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg transition ${active ? "bg-white/10 text-mint" : "bg-stone-100 text-ink/75 group-hover:bg-white group-hover:text-ink"}`}>
                <Icon size={17} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-bold">{item.label}</span>
              {!!item.badge && (
                <span aria-label={`${item.badge.toLocaleString("fa-IR")} مورد جدید`} className="grid h-5 min-w-5 place-items-center rounded-full bg-coral px-1.5 text-xs font-black text-white">
                  {item.badge > 99 ? "99+" : item.badge.toLocaleString("fa-IR")}
                </span>
              )}
            </Link>
          </div>
        );
      })}
    </nav>
  );

  const userCard = (
    <div className="space-y-3">
      <Link href="/account" onClick={() => setOpen(false)} title="حساب من" className="flex items-center gap-3 rounded-2xl bg-[#e8eee8] p-3 transition hover:brightness-95">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-sm font-black text-mint">{initials}</span>
        <div className="min-w-0 flex-1">
          <b className="block truncate text-sm">{name}</b>
          <span className="text-xs text-ink/72">{isAdmin ? workspace?.roleLabel ?? "تیم" : "کاربر"} • حساب من</span>
        </div>
        <UserCog size={16} aria-hidden="true" className="shrink-0 text-ink/75" />
      </Link>
      <form action={logout}>
        <button className="btn-secondary w-full !min-h-10 !text-sm">
          <LogOut size={15} />
          خروج از حساب
        </button>
      </form>
    </div>
  );

  return (
    <div className="min-h-screen bg-paper">
      <a href="#main-content" className="skip-link">پرش به محتوای صفحه</a>
      <aside aria-label="نوار کناری" className="no-print fixed inset-y-0 right-0 z-50 hidden w-[252px] flex-col border-l border-ink/10 bg-[#f9faf6] p-5 lg:flex">
        <div className="px-2 py-2"><Brand href={home} name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} /></div>
        {workspace && switchAction && createAction && <WorkspaceSwitcher info={workspace} switchAction={switchAction} createAction={createAction} />}
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">{renderNav()}</div>
        <div className="pt-3">{userCard}</div>
      </aside>

      <div className="lg:mr-[252px]">
        <header className="no-print sticky top-0 z-40 border-b border-ink/10 bg-paper/90 backdrop-blur-xl">
          <div className="flex h-[70px] items-center justify-between gap-2 px-3 sm:gap-4 sm:px-7">
            <div className="flex min-w-0 items-center gap-3">
              <button ref={menuBtn} onClick={() => setOpen(true)} aria-label="باز کردن منو" aria-haspopup="dialog" aria-expanded={open} className="grid h-11 w-11 place-items-center rounded-xl border border-ink/10 bg-white lg:hidden">
                <Menu size={18} />
              </button>
              <div className="min-w-0">
                <b className="block truncate text-[15px]">{current?.label ?? brand.name}</b>
                <p className="mt-0.5 hidden text-xs text-ink/72 sm:block">{current?.caption ?? "سامانه‌ی امضای آنلاین قرارداد"}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
              <NotificationBell />
              <CommandPalette pages={[...items.map((i) => ({ href: i.href, label: i.label, caption: i.caption })), { href: "/account", label: "حساب من", caption: "رمز عبور و ورود دومرحله‌ای" }]} searchable={isAdmin} />
              <ThemeToggle />
              {isAdmin && (
                <button type="button" onClick={() => window.dispatchEvent(new Event(START_TOUR_EVENT))} aria-label="راهنمای پنل" title="راهنمای پنل" data-testid="tour-help" className="hidden h-10 w-10 place-items-center rounded-xl border border-ink/10 bg-white text-ink/75 transition hover:border-ink/25 sm:grid">
                  <CircleHelp size={17} aria-hidden="true" />
                </button>
              )}
              {isAdmin && (
                <Link href="/admin/new" aria-label="صدور جدید" className="btn-primary !min-h-10 !px-4 max-sm:!w-10 max-sm:!px-0 max-sm:!text-xs">
                  <FilePlus2 size={15} />
                  <span className="max-sm:sr-only">صدور جدید</span>
                </Link>
              )}
              <Link href="/account" title="حساب من" className="hidden items-center gap-2 rounded-xl border border-ink/10 bg-white px-3 py-2 text-xs font-semibold transition hover:border-ink/25 sm:flex">
                <span className="grid h-6 w-6 place-items-center rounded-lg bg-ink text-xs font-black text-mint">{initials}</span>
                {name}
              </Link>
            </div>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className={`mx-auto p-4 outline-none sm:p-7 ${wide ? "max-w-[1500px]" : "max-w-6xl"}`}>
          <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
            {children}
          </motion.div>
        </main>
      </div>

      {isAdmin && <OnboardingTour autoStart={!!tourAuto} />}
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="no-print fixed inset-0 z-[70] bg-ink/50 backdrop-blur-sm lg:hidden" onClick={() => setOpen(false)}>
            <motion.aside
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="منوی ناوبری"
              initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", damping: 28 }}
              onClick={(e) => e.stopPropagation()}
              className="flex h-full w-[290px] flex-col bg-[#f9faf6] p-5 shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <Brand href={home} name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} />
                <button onClick={() => setOpen(false)} aria-label="بستن منو" className="grid h-10 w-10 place-items-center rounded-xl bg-stone-100"><X size={17} /></button>
              </div>
              {workspace && switchAction && createAction && <WorkspaceSwitcher info={workspace} switchAction={switchAction} createAction={createAction} />}
              <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">{renderNav(() => setOpen(false))}</div>
              <div className="pt-3">{userCard}</div>
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
