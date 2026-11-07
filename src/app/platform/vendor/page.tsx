import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Shell from "@/components/Shell";
import VendorPanel from "@/components/VendorPanel";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { getServerKeys, licenseServerEnabled, listLicenses, listReleases } from "@/modules/license/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "سرور لایسنس" };

export default async function VendorPage() {
  const admin = await requirePlatformAdmin();
  if (!licenseServerEnabled()) notFound();
  const [lics, rels, keys] = await Promise.all([listLicenses(), listReleases(), getServerKeys()]);
  return (
    <Shell user={admin} wide>
      <h1 className="mb-1 text-2xl font-black">سرور لایسنس و انتشار نسخه</h1>
      <p className="mb-4 text-xs text-ink/72">صدور کلید برای خریداران، کنترل دامنه‌ها و انتشار به‌روزرسانی. این بخش فقط روی سرور فروشنده (LICENSE_SERVER_ENABLED=1) دیده می‌شود.</p>
      <VendorPanel
        publicKey={keys.publicKey}
        licenses={lics.map((l) => ({
          id: l.id, key: l.key, customerName: l.customerName, customerEmail: l.customerEmail, plan: l.plan, maxDomains: l.maxDomains, status: l.status,
          expiresAt: l.expiresAt?.toISOString() ?? null, updatesUntil: l.updatesUntil?.toISOString() ?? null, lastCheckAt: l.lastCheckAt?.toISOString() ?? null,
          activations: l.activations.map((a) => ({ id: a.id, domain: a.domain, version: a.version, lastSeenAt: a.lastSeenAt.toISOString() })),
        }))}
        releases={rels.map((r) => ({ id: r.id, version: r.version, channel: r.channel, security: r.security, yanked: r.yanked, size: r.size, sha256: r.sha256, publishedAt: r.publishedAt.toISOString(), changelog: r.changelog }))}
      />
    </Shell>
  );
}
