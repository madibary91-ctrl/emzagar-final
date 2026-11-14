import type { Metadata } from "next";
import Shell from "@/components/Shell";
import DemoPanel from "@/components/DemoPanel";
import TourSettingsCard from "@/components/onboarding/TourSettingsCard";
import { requireTeam } from "@/modules/tenancy/context";
import { demoStatus } from "@/modules/demo/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "داده‌های نمونه" };

export default async function DemoPage() {
  const admin = await requireTeam("settings");
  const st = await demoStatus(admin.workspaceId);
  return (
    <Shell user={admin}>
      <h1 className="mb-1 text-2xl font-black">داده‌های نمونه و راهنما</h1>
      <p className="mb-4 text-xs text-ink/72">برای آشنایی سریع، داده‌ی نمایشی بسازید یا راهنمای قدم‌به‌قدم پنل را دوباره اجرا کنید.</p>
      <div className="space-y-5">
        <DemoPanel seeded={st.seeded} counts={st.counts} />
        <TourSettingsCard />
      </div>
    </Shell>
  );
}
