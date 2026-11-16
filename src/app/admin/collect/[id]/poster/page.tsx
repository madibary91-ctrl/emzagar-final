import { notFound } from "next/navigation";
import QRCode from "qrcode";
import PrintButton from "@/components/PrintButton";
import { requireTeam } from "@/modules/tenancy/context";
import { getCampaign, publicBase } from "@/modules/collect/service";
import { getBranding } from "@/modules/branding/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "پوستر QR", robots: { index: false } };

/** پوستر A4 آماده‌ی چاپ برای میز پذیرش، ورودی باشگاه، کلینیک یا غرفه */
export default async function PosterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = await requireTeam("view");
  const c = await getCampaign(Number(id), admin.workspaceId);
  if (!c) notFound();
  const url = `${await publicBase(c.workspaceId)}/c/${c.code}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 900, errorCorrectionLevel: "H" });
  const brand = await getBranding(c.workspaceId);
  return (
    <main className="mx-auto flex min-h-screen max-w-[210mm] flex-col items-center justify-center gap-6 bg-white p-10 text-center">
      <div className="no-print"><PrintButton /></div>
      <p className="text-lg font-bold text-ink/70">{brand.name}</p>
      <h1 className="text-4xl font-black leading-snug">{c.title}</h1>
      {c.description && <p className="text-lg text-ink/70">{c.description}</p>}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qr} alt="QR" className="h-[110mm] w-[110mm] rounded-3xl border-4 border-ink p-4" />
      <p className="text-2xl font-black">برای امضا، QR را با دوربین گوشی اسکن کنید</p>
      <p dir="ltr" className="font-mono text-lg text-ink/70">{url}</p>
      <p className="text-sm text-ink/60">بدون ثبت‌نام • فقط نام، موبایل و امضا</p>
    </main>
  );
}
