import Link from "next/link";
import ContractsDashboard from "@/components/ContractsDashboard";
import { getCurrentUser } from "@/modules/auth/session";
import type { UserFilter } from "@/modules/contracts/service";

export const dynamic = "force-dynamic";

/**
 * معادل شورت‌کد [contracts_dashboard]
 * استفاده در سایت‌های دیگر: <iframe src="https://your-domain/embed/dashboard" />
 */
export default async function EmbedDashboard({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await getCurrentUser();
  const { status } = await searchParams;
  const filter: UserFilter = status === "pending" || status === "signed" ? status : "all";
  if (!user) {
    return (
      <div className="p-6 text-center">
        <p className="mb-3 text-stone-600">برای مشاهده‌ی قراردادها وارد حساب خود شوید.</p>
        <Link href="/login" className="btn btn-primary">ورود</Link>
      </div>
    );
  }
  return (
    <div className="p-4">
      <ContractsDashboard userId={user.id} filter={filter} basePath="/embed/dashboard" />
    </div>
  );
}
