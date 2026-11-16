import Shell from "@/components/Shell";
import ContractsDashboard from "@/components/ContractsDashboard";
import { requireUser } from "@/modules/auth/session";
import { parsePage, parseUserFilter } from "@/modules/contracts/user-filter";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; page?: string; denied?: string }> }) {
  const user = await requireUser();
  const { status, q, page, denied } = await searchParams;
  const filter = parseUserFilter(status);
  return (
    <Shell user={user}>
      <h1 className="mb-4 text-2xl font-black">قراردادهای من</h1>
      {denied === "platform" && <p role="alert" className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800">بخش «مدیریت پلتفرم» فقط برای مدیر کل سامانه است؛ حساب شما به آن دسترسی ندارد.</p>}
      <ContractsDashboard userId={user.id} filter={filter} q={(q || "").slice(0, 100)} page={parsePage(page)} />
    </Shell>
  );
}
