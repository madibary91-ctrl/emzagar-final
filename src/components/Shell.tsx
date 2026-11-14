import type { ReactNode } from "react";
import type { SessionUser } from "@/modules/auth/session";
import { logoutAction } from "@/modules/auth/actions";
import ShellNav, { type NavItem } from "@/components/ShellNav";
import { getBranding } from "@/modules/branding/service";
import { getTeamContext } from "@/modules/tenancy/context";
import { createWorkspaceAction, switchWorkspaceAction } from "@/modules/tenancy/actions";
import { can, ROLE_LABELS, type Permission } from "@/modules/tenancy/roles";
import { isPlatformAdmin } from "@/modules/platform/admin";
import { ticketCounts, userAttentionCount } from "@/modules/tickets/service";
import { kycCounts } from "@/modules/kyc/service";
import { openIncidentCount } from "@/modules/health/service";
import { licenseServerEnabled } from "@/modules/license/server";
import { getLicenseInfo } from "@/modules/license/client";
import { getUpdateInfo } from "@/modules/license/updater";
import Link from "next/link";
import { getPref } from "@/modules/prefs/service";
import { TOUR_PREF } from "@/modules/onboarding/constants";
import PanelChatWidget from "@/components/chat/PanelChatWidget";
import { unreadStaffChats } from "@/modules/chat/service";

type Item = NavItem & { perm: Permission };

const G_WORK = "کار روزانه";
const G_INSIGHT = "تحلیل و کنترل";
const G_BIZ = "کسب‌وکار";
const G_CONNECT = "اتوماسیون و اتصال";
const G_SETUP = "تنظیمات";
const G_HELP = "راهنما و نما";

// ترتیب مهم است: آیتم‌های هر گروه پشت‌سرهم قرار می‌گیرند تا عنوان گروه یک‌بار نمایش داده شود
const ADMIN_NAV: Item[] = [
  { href: "/admin", label: "قراردادها", caption: "پیگیری و عملیات گروهی", icon: "files", perm: "view", group: G_WORK },
  { href: "/admin/new", label: "صدور قرارداد", caption: "تکی و گروهی", icon: "plus", perm: "write", group: G_WORK },
  { href: "/admin/chat", label: "گفتگوی زنده", caption: "پاسخ آنلاین به امضاکنندگان", icon: "chat", perm: "write", group: G_WORK },
  { href: "/admin/new/file", label: "امضا روی فایل", caption: "PDF/Word با جانمایی بصری", icon: "upload", perm: "write", group: G_WORK },
  { href: "/admin/merge", label: "ارسال انبوه (اکسل)", caption: "یک قالب، صدها گیرنده", icon: "sheet", perm: "view", group: G_WORK },
  { href: "/admin/collect", label: "امضای عمومی (QR)", caption: "یک لینک، ده‌ها امضا", icon: "qr", perm: "view", group: G_WORK },
  { href: "/quick", label: "ارسال سریع", caption: "بدون ثبت‌نام، در چند دقیقه", icon: "zap", perm: "view", group: G_WORK },
  { href: "/admin/templates", label: "قالب‌ها", caption: "متن، متغیرها و هوش مصنوعی", icon: "text", perm: "view", group: G_WORK },
  { href: "/admin/library", label: "کتابخانه‌ی قالب‌ها", caption: "۳۲ قالب آماده‌ی فارسی", icon: "boxes", perm: "view", group: G_WORK },
  { href: "/admin/clauses", label: "کتابخانه‌ی بندها", caption: "بندهای آماده‌ی قرارداد", icon: "text", perm: "view", group: G_WORK },
  { href: "/admin/knowledge", label: "حافظه‌ی حقوقی", caption: "اسناد و لحن شما برای AI", icon: "brain", perm: "view", group: G_WORK },
  { href: "/admin/customers", label: "مشتریان", caption: "طرف‌های قرارداد", icon: "users", perm: "view", group: G_WORK },
  { href: "/admin/renewals", label: "تمدید قراردادها", caption: "پایان مدت و یادآوری", icon: "timer", perm: "view", group: G_WORK },
  { href: "/admin/reports", label: "گزارش‌ها", caption: "عملکرد و روند", icon: "chart", perm: "view", group: G_INSIGHT },
  { href: "/admin/insights", label: "هوش تجاری", caption: "قیف تبدیل و توصیه‌ها", icon: "pulse", perm: "view", group: G_INSIGHT },
  { href: "/admin/risk", label: "تحلیل ریسک", caption: "ممیزی هوشمند قرارداد", icon: "scan", perm: "view", group: G_INSIGHT },
  { href: "/admin/logs", label: "لاگ‌ها", caption: "رویدادهای امن", icon: "logs", perm: "view", group: G_INSIGHT },
  { href: "/admin/products", label: "محصولات", caption: "فروشگاه و سفارش", icon: "boxes", perm: "view", group: G_BIZ },
  { href: "/admin/team", label: "تیم و دسترسی", caption: "اعضا و نقش‌ها", icon: "team", perm: "view", group: G_BIZ },
  { href: "/admin/receivables", label: "مطالبات و اقساط", caption: "بیعانه، اقساط و وصول", icon: "coins", perm: "view", group: G_BIZ },
  { href: "/admin/billing", label: "اشتراک و پرداخت", caption: "طرح، مصرف، ارتقا", icon: "card", perm: "settings", group: G_BIZ },
  { href: "/admin/wallet", label: "کیف پول", caption: "شارژ و بسته‌های اعتباری", icon: "wallet", perm: "settings", group: G_BIZ },
  { href: "/admin/referrals", label: "دعوت دوستان", caption: "لینک اختصاصی و پاداش", icon: "gift", perm: "view", group: G_BIZ },
  { href: "/admin/kyc", label: "احراز هویت", caption: "مدارک برای قراردادهای پرمبلغ", icon: "idcard", perm: "settings", group: G_BIZ },
  { href: "/admin/automation", label: "یادآوری و انقضا", caption: "زمان‌بندی", icon: "timer", perm: "settings", group: G_CONNECT },
  { href: "/admin/messengers", label: "ربات بله و تلگرام", caption: "لینک امضا، وضعیت و اعلان در پیام‌رسان", icon: "bell", perm: "settings", group: G_CONNECT },
  { href: "/admin/webhooks", label: "اعلان پیام‌رسان", caption: "تلگرام، بله، روبیکا", icon: "bell", perm: "settings", group: G_CONNECT },
  { href: "/admin/wordpress", label: "وردپرس و ووکامرس", caption: "نصب افزونه (یک‌کلیکی)", icon: "plug", perm: "settings", group: G_CONNECT },
  { href: "/admin/woocommerce", label: "همگام‌سازی ووکامرس", caption: "سفارش‌ها و وضعیت امضا", icon: "pulse", perm: "settings", group: G_CONNECT },
  { href: "/admin/api", label: "API و اتصال", caption: "کلید و مستندات", icon: "key", perm: "settings", group: G_CONNECT },
  { href: "/admin/branding", label: "برندینگ", caption: "لوگو، رنگ، تم", icon: "palette", perm: "settings", group: G_SETUP },
  { href: "/admin/settings", label: "تنظیمات", caption: "پیامک، ایمیل، هوش مصنوعی", icon: "settings", perm: "settings", group: G_SETUP },
  { href: "/admin/demo", label: "داده‌های نمونه", caption: "ساخت و پاک‌سازی، راهنما", icon: "database", perm: "settings", group: G_SETUP },
  { href: "/support", label: "پشتیبانی", caption: "ثبت و پیگیری تیکت", icon: "support", perm: "view", group: G_HELP },
  { href: "/dashboard", label: "نمای کاربری", caption: "قراردادهای من", icon: "dash", perm: "view", group: G_HELP },
];
const USER_NAV: NavItem[] = [
  { href: "/dashboard", label: "قراردادهای من", caption: "امضا و پیگیری", icon: "dash" },
  { href: "/shop", label: "فروشگاه", caption: "خرید و امضا", icon: "shop" },
  { href: "/support", label: "پشتیبانی", caption: "ثبت و پیگیری تیکت", icon: "support" },
];

/** فقط نام و برچسب نقش به کلاینت می‌رسد؛ هرگز کل رکورد کاربر (مثل passwordHash) سریالایز نمی‌شود */
export default async function Shell({ user, children, wide }: { user: SessionUser; children: ReactNode; wide?: boolean }) {
  const team = await getTeamContext();
  const isAdmin = !!team;
  const b = await getBranding(team?.workspaceId ?? 0);
  const base: NavItem[] = team
    ? ADMIN_NAV.filter((i) => can(team.wsRole, i.perm)).map(({ perm: _perm, ...i }) => i)
    : USER_NAV;
  // نشان تعداد: پاسخ‌های جدید پشتیبانی برای کاربر؛ تیکت‌های منتظر پاسخ برای مدیر کل
  const platform = isPlatformAdmin(user);
  const canChat = !!team && can(team.wsRole, "write");
  const [attention, counts, tourPref, kycC, healthOpen, chatPlatform, chatTeam] = await Promise.all([
    userAttentionCount(user.id),
    platform ? ticketCounts() : null,
    isAdmin ? getPref(user.id, TOUR_PREF) : null,
    platform ? kycCounts().catch(() => null) : null,
    platform ? openIncidentCount() : 0,
    platform ? unreadStaffChats({ queue: "platform", workspaceId: 0, userId: user.id, name: user.name }).catch(() => 0) : 0,
    canChat && team ? unreadStaffChats({ queue: "workspace", workspaceId: team.workspaceId, userId: user.id, name: user.name }).catch(() => 0) : 0,
  ]);
  const kycPending = kycC?.pending ?? 0;
  const items: NavItem[] = base.map((i) => (i.href === "/support" ? { ...i, badge: attention } : i.href === "/admin/chat" ? { ...i, badge: chatTeam } : i));
  if (platform) {
    items.push(
      { href: "/platform", label: "مدیریت پلتفرم", caption: "آمار کل سامانه", icon: "shield", group: "پلتفرم" },
      { href: "/admin/landing", label: "ویرایشگر صفحه اصلی", caption: "طراحی ویترین سایت", icon: "layout", group: "پلتفرم" },
      { href: "/platform/chat", label: "گفتگوی زنده", caption: "پشتیبانی آنلاین کاربران", icon: "chat", badge: chatPlatform, group: "پلتفرم" },
      { href: "/platform/tickets", label: "صندوق تیکت‌ها", caption: "پاسخ به کاربران", icon: "inbox", badge: counts?.waiting ?? 0, group: "پلتفرم" },
      { href: "/platform/plans", label: "طرح‌های اشتراک", caption: "قیمت، سقف‌ها و مدت پلن‌ها", icon: "wallet", group: "پلتفرم" },
      { href: "/platform/commerce", label: "تجارت و درگاه‌ها", caption: "درگاه‌ها، دعوت دوستان، کیف پول", icon: "wallet", group: "پلتفرم" },
      { href: "/platform/kyc", label: "احراز هویت مدارک", caption: "صف بررسی مدیر", icon: "idcard", badge: kycPending, group: "پلتفرم" },
      { href: "/platform/identity", label: "هویت امضاکننده", caption: "شاهکار و تأیید هویت اختیاری", icon: "idcard", group: "پلتفرم" },
      { href: "/platform/messengers", label: "ربات پلتفرم", caption: "بله و تلگرام برای همه‌ی کاربران", icon: "bell", group: "پلتفرم" },
      { href: "/platform/health", label: "سلامت سیستم", caption: "اتصال سرویس‌ها و عیب‌یابی", icon: "health", badge: healthOpen, group: "پلتفرم" },
      { href: "/platform/license", label: "لایسنس و به‌روزرسانی", caption: "فعال‌سازی و آپدیت یک‌کلیکی", icon: "license", group: "پلتفرم" },
    );
    if (licenseServerEnabled()) items.push({ href: "/platform/vendor", label: "سرور لایسنس", caption: "صدور کلید و انتشار نسخه", icon: "store", group: "پلتفرم" });
  }
  // نوار اطلاع‌رسانی لایسنس/نسخه‌ی جدید فقط برای مدیر کل (خطای دیتابیس/شبکه هرگز صفحه را نمی‌شکند)
  let notice: { text: string; cta: string; tone: string } | null = null;
  if (platform && !licenseServerEnabled()) {
    try {
      const [lic, upd] = await Promise.all([getLicenseInfo(), getUpdateInfo()]);
      if (upd.updateAvailable && upd.latest) notice = { text: `نسخه‌ی ${upd.latest.version} آماده‌ی نصب است${upd.latest.security ? " (به‌روزرسانی امنیتی)" : ""}.`, cta: "به‌روزرسانی", tone: "bg-mint/25 text-ink" };
      else if (lic.state === "unlicensed") notice = { text: "لایسنس محصول هنوز فعال نشده است؛ برای دریافت به‌روزرسانی و پشتیبانی آن را فعال کنید.", cta: "فعال‌سازی لایسنس", tone: "bg-amber-50 text-amber-900" };
      else if (!lic.licensed) notice = { text: "لایسنس شما معتبر نیست یا منقضی شده است.", cta: "بررسی لایسنس", tone: "bg-rose-50 text-rose-800" };
    } catch {
      notice = null;
    }
  }
  return (
    <>
      {/* رنگ‌های برند «همین فضای کاری»؛ فقط مقدارهای hex اعتبارسنجی‌شده در buildCss وارد CSS می‌شوند */}
      {b.css && <style dangerouslySetInnerHTML={{ __html: b.css }} />}
    <ShellNav
      items={items}
      name={user.name}
      isAdmin={isAdmin}
      logout={logoutAction}
      wide={wide}
      tourAuto={isAdmin && tourPref === null}
      brand={{ name: b.name, logoUrl: b.logoUrl, tagline: b.tagline }}
      workspace={team ? { activeId: team.workspaceId, activeName: team.workspaceName, roleLabel: ROLE_LABELS[team.wsRole], list: team.teamWorkspaces.map((w) => ({ id: w.id, name: w.name })) } : undefined}
      switchAction={team ? switchWorkspaceAction : undefined}
      createAction={team ? createWorkspaceAction : undefined}
    >
      {notice && (
        <div role="status" className={`mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl px-4 py-2.5 text-xs font-semibold ${notice.tone}`} data-testid="license-notice">
          <span>{notice.text}</span>
          <Link href="/platform/license" className="rounded-lg bg-ink px-3 py-1.5 text-xs font-bold text-white">{notice.cta}</Link>
        </div>
      )}
      {children}
    </ShellNav>
      {/* گفتگوی زنده با پشتیبانی؛ مدیر کل خودش پاسخ‌دهنده است و ویجت نمی‌بیند */}
      {!platform && <PanelChatWidget />}
    </>
  );
}
