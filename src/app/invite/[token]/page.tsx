import Link from "next/link";
import { eq } from "drizzle-orm";
import AuthFrame from "@/components/AuthFrame";
import { InviteForm } from "@/components/AuthForms";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/modules/auth/session";
import { findInvite } from "@/modules/tenancy/invites";
import { ROLE_LABELS, type MemberRole } from "@/modules/tenancy/roles";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await findInvite(token);
  if (!inv) {
    return (
      <AuthFrame title="دعوت‌نامه نامعتبر است" subtitle="این دعوت‌نامه استفاده شده، لغو شده یا مهلت آن (۷ روز) تمام شده است. از مدیر تیم بخواهید دوباره دعوت کند.">
        <Link href="/login" className="btn-secondary w-full">ورود</Link>
      </AuthFrame>
    );
  }
  const [account] = await db.select({ id: users.id }).from(users).where(eq(users.email, inv.email));
  const cur = await getCurrentUser();
  const mismatch = !!cur && cur.email.toLowerCase() !== inv.email;
  return (
    <AuthFrame
      workspaceId={inv.workspaceId}
      title={`دعوت به «${inv.workspaceName}»`}
      subtitle={`شما با نقش «${ROLE_LABELS[inv.role as MemberRole] ?? inv.role}» به این فضای کاری دعوت شده‌اید (${inv.email}).`}
    >
      {mismatch ? (
        <p className="rounded-xl bg-amber-50 p-3 text-xs leading-6 text-amber-800">شما با ایمیل دیگری وارد شده‌اید. از حساب خود خارج شوید و با ایمیل {inv.email} ادامه دهید.</p>
      ) : (
        <InviteForm token={token} existingAccount={!!account} loggedIn={!!cur} />
      )}
    </AuthFrame>
  );
}
