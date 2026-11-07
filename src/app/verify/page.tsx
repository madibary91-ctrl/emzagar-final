import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import AuthFrame from "@/components/AuthFrame";
import { isDocHash } from "@/modules/verify/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "استعلام اصالت سند", robots: { index: false } };

/** استعلام دستی: کاربر اثر انگشت چاپ‌شده روی سند را وارد می‌کند */
export default async function VerifyHome({ searchParams }: { searchParams: Promise<{ h?: string }> }) {
  const { h } = await searchParams;
  const hash = String(h || "").trim().toLowerCase();
  if (isDocHash(hash)) redirect(`/verify/${hash}`);
  return (
    <AuthFrame title="استعلام اصالت سند" subtitle="اثر انگشت (SHA-256) چاپ‌شده در پایان قرارداد را وارد کنید یا QR روی سند را اسکن کنید تا صحت و دستکاری‌نشدن آن بررسی شود.">
      <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-emerald-50 text-emerald-700"><ShieldCheck size={26} /></div>
      <form method="get" action="/verify" className="space-y-4">
        <div>
          <label htmlFor="h" className="label">اثر انگشت سند (۶۴ نویسه)</label>
          <input id="h" name="h" dir="ltr" defaultValue={hash} className="input font-mono text-xs" placeholder="e3b0c442…" autoComplete="off" spellCheck={false} />
          {hash && <p role="alert" className="mt-2 text-xs font-semibold text-red-600">قالب اثر انگشت معتبر نیست؛ باید ۶۴ نویسه‌ی هگزادسیمال باشد.</p>}
        </div>
        <button className="btn-primary w-full">استعلام</button>
      </form>
    </AuthFrame>
  );
}
