import type { Metadata } from "next";
import Shell from "@/components/Shell";
import LicensePanel, { type LicenseView, type UpdateView } from "@/components/LicensePanel";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { getLicenseInfo } from "@/modules/license/client";
import { getUpdateHistory, getUpdateInfo, rollbackAvailable, updateSupport } from "@/modules/license/updater";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "لایسنس و به‌روزرسانی" };

const STATE_LABELS: Record<string, string> = {
  unlicensed: "فعال‌نشده",
  active: "فعال",
  grace_expired: "مهلت آفلاین تمام شده",
  expired: "منقضی",
  revoked: "باطل‌شده",
  suspended: "معلق",
  invalid: "نامعتبر",
  domain_limit: "ظرفیت دامنه پر است",
};

export default async function LicensePage() {
  const admin = await requirePlatformAdmin();
  const [info, upd, history] = await Promise.all([getLicenseInfo(), getUpdateInfo(), getUpdateHistory()]);
  const support = updateSupport();
  const license: LicenseView = { ...info, stateLabel: STATE_LABELS[info.state] ?? info.state };
  const update: UpdateView = {
    current: upd.current,
    checkedAt: upd.checkedAt,
    available: upd.updateAvailable,
    latest: upd.latest ? { version: upd.latest.version, changelog: upd.latest.changelog, publishedAt: upd.latest.publishedAt, size: upd.latest.size, security: upd.latest.security } : null,
    error: upd.error,
    supported: support.supported,
    unsupportedReason: support.reason,
    rollback: rollbackAvailable(),
    history,
  };
  return (
    <Shell user={admin}>
      <h1 className="mb-1 text-2xl font-black">لایسنس و به‌روزرسانی</h1>
      <p className="mb-4 text-xs text-ink/72">فعال‌سازی لایسنس، دریافت نسخه‌های جدید با یک کلیک و بازگشت امن به نسخه‌ی قبل.</p>
      <LicensePanel license={license} update={update} />
    </Shell>
  );
}
