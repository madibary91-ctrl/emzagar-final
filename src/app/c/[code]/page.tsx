import { eq, sql } from "drizzle-orm";
import { Clock, ShieldAlert } from "lucide-react";
import { Brand } from "@/components/Brand";
import CollectForm from "@/components/CollectForm";
import { db } from "@/db";
import { collectCampaigns } from "@/db/schema";
import { getBranding } from "@/modules/branding/service";
import { acceptingState, docFieldsOf, getCampaignByCode } from "@/modules/collect/service";
import { parseCollectFields } from "@/modules/collect/schema";
import { parseMeta } from "@/modules/docs/service";
import { sanitizeHtml } from "@/lib/html";

export const dynamic = "force-dynamic";
export const metadata = { title: "فرم امضا", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

/** صفحه‌ی عمومی امضا: هر کس لینک/QR را باز کند مستقیم فرم را می‌بیند (بدون ثبت‌نام) */
export default async function PublicCollectPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const c = await getCampaignByCode(code);
  const brand = await getBranding(c?.workspaceId ?? 0);
  const frame = (children: React.ReactNode, wide = false) => (
    <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
      <div className={`mx-auto w-full ${wide ? "max-w-3xl" : "max-w-md"}`}>
        <div className="mb-6 flex justify-center"><Brand name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} /></div>
        {children}
      </div>
    </main>
  );
  if (!c) {
    return frame(<div className="card !p-7 text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose-50 text-rose-500"><ShieldAlert size={26} /></span><h1 className="mt-4 text-lg font-black">این فرم پیدا نشد</h1><p className="mt-2 text-xs leading-7 text-ink/75">لینک یا QR را دوباره بررسی کنید.</p></div>);
  }
  const st = await acceptingState(c);
  if (!st.open) {
    return frame(<div className="card !p-7 text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-amber-50 text-amber-600"><Clock size={26} /></span><h1 className="mt-4 text-lg font-black">{c.title}</h1><p className="mt-2 text-xs leading-7 text-ink/75">{st.reason}</p></div>);
  }
  await db.update(collectCampaigns).set({ views: sql`${collectCampaigns.views} + 1` }).where(eq(collectCampaigns.id, c.id)).catch(() => undefined);
  const docFields = docFieldsOf(c);
  const docMode = c.docFile
    ? {
        url: `/api/collect/doc/${c.code}`,
        pages: parseMeta(c.docPagesMeta),
        fields: docFields.map((f) => ({ key: f.key, kind: f.kind, label: f.label, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, mine: true, signerLabel: "" })),
      }
    : null;
  return frame(
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-black">{c.title}</h1>
        {c.description && <p className="mt-1 text-sm leading-7 text-ink/70">{c.description}</p>}
      </header>
      <CollectForm code={c.code} bodyHtml={sanitizeHtml(c.bodyHtml)} fields={parseCollectFields(c.fieldsJson)} requireOtp={c.requireOtp} requireSignature={c.requireSignature} docMode={docMode} />
      <p className="text-center text-[11px] leading-6 text-ink/60">اتصال شما امن است. زمان، IP و اثر انگشت امضای شما ثبت می‌شود و رسید قابل استعلام دریافت می‌کنید.</p>
    </div>,
    !!docMode,
  );
}
