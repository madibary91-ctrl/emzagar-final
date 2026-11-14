import Shell from "@/components/Shell";
import ContractsDashboard from "@/components/ContractsDashboard";
import { requireUser } from "@/modules/auth/session";
import type { UserFilter } from "@/modules/contracts/service";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireUser();
  const { status } = await searchParams;
  const filter: UserFilter = status === "pending" || status === "signed" ? status : "all";
  return (
    <Shell user={user}>
      <h1 className="mb-4 text-2xl font-black">قراردادهای من</h1>
      <ContractsDashboard userId={user.id} filter={filter} />
    </Shell>
  );
}
