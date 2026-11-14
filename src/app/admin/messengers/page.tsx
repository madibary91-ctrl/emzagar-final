import type { Metadata } from "next";
import Shell from "@/components/Shell";
import MessengersAdminView from "@/components/MessengersAdminView";
import { requireTeam } from "@/modules/tenancy/context";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ربات‌های پیام‌رسان" };

export default async function AdminMessengersPage() {
  const admin = await requireTeam("settings");
  return (
    <Shell user={admin}>
      <MessengersAdminView scope="workspace" workspaceId={admin.workspaceId} />
    </Shell>
  );
}
