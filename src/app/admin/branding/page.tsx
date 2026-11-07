import Shell from "@/components/Shell";
import BrandingForm from "@/components/BrandingForm";
import { requireTeam } from "@/modules/tenancy/context";
import { getBranding } from "@/modules/branding/service";

export const dynamic = "force-dynamic";

export default async function BrandingPage() {
  const admin = await requireTeam("settings");
  const b = await getBranding(admin.workspaceId);
  return (
    <Shell user={admin}>
      <h1 className="mb-1 text-2xl font-black">برندینگ</h1>
      <p className="mb-4 text-xs text-ink/72">نام، لوگو، رنگ و حالت تاریک/روشن سامانه را مطابق برند خودتان تنظیم کنید.</p>
      <BrandingForm name={b.name} tagline={b.tagline} primary={b.primary} accent={b.accent} theme={b.defaultTheme} logoUrl={b.logoUrl} />
    </Shell>
  );
}
