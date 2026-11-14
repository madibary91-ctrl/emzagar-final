import Shell from "@/components/Shell";
import CollectBuilder from "@/components/CollectBuilder";
import { requireTeam } from "@/modules/tenancy/context";

export const dynamic = "force-dynamic";
export const metadata = { title: "فرم جدید امضای عمومی" };

export default async function NewCollectPage() {
  const admin = await requireTeam("write");
  return (
    <Shell user={admin} wide>
      <h1 className="mb-1 text-2xl font-black">فرم جدید امضای عمومی</h1>
      <p className="mb-5 text-sm leading-7 text-ink/70">متن یا فایل را تعریف کنید؛ لینک و QR عمومی ساخته می‌شود و هر کس بدون ثبت‌نام می‌تواند امضا کند.</p>
      <CollectBuilder />
    </Shell>
  );
}
