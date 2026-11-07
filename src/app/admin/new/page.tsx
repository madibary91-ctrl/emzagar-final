import Shell from "@/components/Shell";
import IssueForm from "@/components/IssueForm";
import { db } from "@/db";
import { templates } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { listWorkspaceUsers } from "@/modules/tenancy/service";
import { requireTeam } from "@/modules/tenancy/context";
import { getKycState, getKycThreshold } from "@/modules/kyc/service";

export const dynamic = "force-dynamic";

export default async function NewContractPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const { customer } = await searchParams;
  const admin = await requireTeam("write");
  const [kycThreshold, kycState] = await Promise.all([getKycThreshold(), getKycState(admin.workspaceId)]);
  const [tpls, allUsers] = await Promise.all([
    db.select({ id: templates.id, title: templates.title, body: templates.body }).from(templates).where(eq(templates.workspaceId, admin.workspaceId)).orderBy(asc(templates.title)),
    listWorkspaceUsers(admin.workspaceId),
  ]);
  return (
    <Shell user={admin} wide>
      <h1 className="mb-4 text-2xl font-black">صدور قرارداد جدید</h1>
      <IssueForm templates={tpls} users={allUsers.map((u) => ({ id: u.id, name: u.name, email: u.email }))} initialCustomer={Number(customer) || undefined} kyc={{ threshold: kycThreshold, approved: kycState.status === "approved" }} />
    </Shell>
  );
}
