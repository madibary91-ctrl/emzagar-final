import type { Metadata } from "next";
import Shell from "@/components/Shell";
import MessengersAdminView from "@/components/MessengersAdminView";
import { requirePlatformAdmin } from "@/modules/platform/admin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ربات پلتفرم (بله/تلگرام)" };

export default async function PlatformMessengersPage() {
  const admin = await requirePlatformAdmin();
  return (
    <Shell user={admin}>
      <MessengersAdminView scope="platform" workspaceId={null} />
    </Shell>
  );
}
