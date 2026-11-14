import Shell from "@/components/Shell";
import IssueFromFile from "@/components/IssueFromFile";
import { listWorkspaceUsers } from "@/modules/tenancy/service";
import { requireTeam } from "@/modules/tenancy/context";
import { isGuestEmail } from "@/modules/guests/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "امضا روی فایل PDF/Word" };

export default async function NewFromFilePage() {
  const admin = await requireTeam("write");
  const users = await listWorkspaceUsers(admin.workspaceId);
  return (
    <Shell user={admin} wide>
      <h1 className="mb-1 text-2xl font-black">امضا روی فایل خودتان</h1>
      <p className="mb-5 text-sm leading-7 text-ink/70">فایل PDF یا Word آماده‌ی خود را بارگذاری کنید، جای امضا و فیلدها را روی خود فایل مشخص کنید؛ نسخه‌ی نهایی همان فایل با امضاها و گواهی دیجیتال است.</p>
      <IssueFromFile users={users.map((u) => ({ id: u.id, name: u.name, email: isGuestEmail(u.email) ? "" : u.email, mobile: u.mobile, isGuest: u.isGuest }))} />
    </Shell>
  );
}
