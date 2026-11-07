import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { LockKeyhole, ShieldAlert } from "lucide-react";
import { db } from "@/db";
import { contracts, shortLinks } from "@/db/schema";
import { Brand } from "@/components/Brand";
import LinkUnlockForm from "@/components/LinkUnlockForm";
import { getBranding } from "@/modules/branding/service";
import { getCurrentUser } from "@/modules/auth/session";
import { logAudit } from "@/modules/audit/service";
import { getLinkByCode, unlockCookieName, verifyUnlockToken } from "@/modules/links/service";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

function Frame({ children, brand }: { children: React.ReactNode; brand: Awaited<ReturnType<typeof getBranding>> }) {
  return (
    <main className="grid min-h-screen place-items-center bg-paper p-5">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center"><Brand name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} /></div>
        <div className="card !p-7">{children}</div>
      </div>
    </main>
  );
}

/** لینک کوتاه عمومی: پس از (در صورت وجود) رمز، کاربر به صفحه‌ی قرارداد هدایت می‌شود. دسترسی به متن قرارداد همچنان نیازمند ورود به حساب و جداسازی کاربران است. */
export default async function ShortLinkPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const brand = await getBranding();
  const link = await getLinkByCode(code);
  const now = new Date();

  if (!link || !link.active || (link.expiresAt && link.expiresAt < now)) {
    return (
      <Frame brand={brand}>
        <div className="text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose-50 text-rose-500"><ShieldAlert size={24} /></span>
          <h1 className="mt-4 text-lg font-black">لینک نامعتبر است</h1>
          <p className="mt-2 text-xs leading-7 text-ink/75">این لینک وجود ندارد، غیرفعال شده یا مهلت آن پایان یافته است. لطفاً با فرستنده‌ی قرارداد تماس بگیرید.</p>
        </div>
      </Frame>
    );
  }

  if (link.passwordHash) {
    const jar = await cookies();
    if (!verifyUnlockToken(link.code, jar.get(unlockCookieName(link.code))?.value)) {
      return (
        <Frame brand={brand}>
          <div className="mb-5 text-center">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-mint/25 text-ink"><LockKeyhole size={24} /></span>
            <h1 className="mt-4 text-lg font-black">این قرارداد رمزگذاری شده است</h1>
            <p className="mt-2 text-xs leading-7 text-ink/75">رمز لینک را که فرستنده در اختیار شما گذاشته وارد کنید.</p>
          </div>
          <LinkUnlockForm code={link.code} />
        </Frame>
      );
    }
  }

  const [c] = await db.select({ id: contracts.id, status: contracts.status }).from(contracts).where(eq(contracts.id, link.contractId));
  if (!c || c.status === "draft") redirect("/login");

  await db
    .update(shortLinks)
    .set({ clicks: sql`${shortLinks.clicks} + 1`, lastOpenedAt: now })
    .where(eq(shortLinks.id, link.id));
  await logAudit({ action: "link.opened", contractId: c.id, detail: link.code });

  const user = await getCurrentUser();
  const target = `/contracts/${c.id}`;
  redirect(user ? target : `/login?next=${encodeURIComponent(target)}`);
}
