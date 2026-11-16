import Link from "next/link";
import Shell from "@/components/Shell";
import { NewTicketForm } from "@/components/TicketForms";
import { requireUser } from "@/modules/auth/session";

export const dynamic = "force-dynamic";

export default async function NewTicketPage() {
  const user = await requireUser();
  return (
    <Shell user={user}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-black">ثبت تیکت جدید</h1>
        <Link href="/support" className="btn-secondary">بازگشت</Link>
      </div>
      <div className="max-w-3xl"><NewTicketForm /></div>
    </Shell>
  );
}
