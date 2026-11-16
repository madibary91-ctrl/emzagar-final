import Link from "next/link";
import ContractsDashboard from "@/components/ContractsDashboard";
import { getCurrentUser } from "@/modules/auth/session";
import { parsePage, parseUserFilter } from "@/modules/contracts/user-filter";

export const dynamic = "force-dynamic";

/**
 * معادل شورت‌کد [contracts_dashboard]
 * استفاده در سایت‌های دیگر: <iframe src="https://your-domain/embed/dashboard" />
 */
export default async function EmbedDashboard({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; page?: string }> }) {
  const user = await getCurrentUser();
  const { status, q, page } = await searchParams;
  const filter = parseUserFilter(status);
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
      <ContractsDashboard userId={user.id} filter={filter} q={(q || "").slice(0, 100)} page={parsePage(page)} basePath="/embed/dashboard" />
    </div>
  );
}
