import { CheckCircle2, Clock, FileDown, ShieldAlert } from "lucide-react";
import { Brand } from "@/components/Brand";
import { GuestIdentity, GuestSignPanel } from "@/components/GuestSign";
import { getBranding } from "@/modules/branding/service";
import { logAudit } from "@/modules/audit/service";
import { hasGuestSession, recordLinkOpen, resolveSigningToken, type LinkContext } from "@/modules/signing/links";
import { sanitizeHtml } from "@/lib/html";
import AttachmentsPanel from "@/components/AttachmentsPanel";
import { listAttachments } from "@/modules/attachments/service";
import { getSigners } from "@/modules/contracts/service";
import { fieldsToFill } from "@/modules/fields/service";
import { renderContractBody } from "@/modules/fields/service";
import { faTime } from "@/lib/jalali";
import { fa } from "@/lib/jalali";
import NegotiationPanel from "@/components/NegotiationPanel";
import { listComments } from "@/modules/contracts/negotiation";
import { toPanelComments } from "@/modules/contracts/negotiation-view";

export const dynamic = "force-dynamic";
// توکن داخل آدرس است: هرگز نباید از طریق Referer به سایت دیگری برود یا ایندکس شود
export const metadata = { title: "امضای قرارداد", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

type BrandInfo = Awaited<ReturnType<typeof getBranding>>;

function Frame({ brand, children, wide }: { brand: BrandInfo; children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
      <div className={`mx-auto w-full ${wide ? "max-w-3xl" : "max-w-md"}`}>
        <div className="mb-7 flex justify-center"><Brand name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} /></div>
        {children}
      </div>
    </main>
  );
}

function Notice({ icon: Icon, tone, title, text }: { icon: typeof ShieldAlert; tone: "rose" | "emerald" | "amber"; title: string; text: string }) {
  const color = tone === "rose" ? "bg-rose-50 text-rose-500" : tone === "emerald" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-600";
  return (
    <div className="card !p-7 text-center">
      <span className={`mx-auto grid h-14 w-14 place-items-center rounded-2xl ${color}`}><Icon size={26} /></span>
      <h1 className="mt-4 text-lg font-black">{title}</h1>
      <p className="mt-2 text-xs leading-7 text-ink/75">{text}</p>
    </div>
  );
}

function maskMobile(m: string) {
  return m.length >= 8 ? `${m.slice(0, 4)}***${m.slice(-4)}` : "";
}

/** صفحه‌ی امضای مشتری نهایی: بدون ثبت‌نام؛ فقط لینک اختصاصی + OTP پیامکی */
export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const state = await resolveSigningToken(token);
  const brand = await getBranding(state.status === "ok" || state.status === "done" ? state.ctx.contract.workspaceId : 0);

  if (state.status === "invalid") {
    return <Frame brand={brand}><Notice icon={ShieldAlert} tone="rose" title="لینک نامعتبر است" text="این لینک وجود ندارد یا قبلاً استفاده شده است. اگر هنوز باید قراردادی را امضا کنید، از فرستنده بخواهید لینک تازه بفرستد." /></Frame>;
  }
  if (state.status === "expired") {
    return <Frame brand={brand}><Notice icon={Clock} tone="amber" title="مهلت لینک تمام شده است" text="برای امضا، از فرستنده‌ی قرارداد بخواهید لینک جدیدی برایتان ارسال کند." /></Frame>;
  }
  if (state.status === "closed") {
    const map = {
      rejected: "این قرارداد رد شده است و دیگر قابل امضا نیست.",
      cancelled: "این قرارداد توسط فرستنده لغو شده است.",
      expired: "مهلت امضای این قرارداد به پایان رسیده است.",
      draft: "این قرارداد هنوز منتشر نشده است.",
    } as const;
    return <Frame brand={brand}><Notice icon={ShieldAlert} tone="rose" title="قرارداد قابل امضا نیست" text={map[state.reason]} /></Frame>;
  }

  const ctx: LinkContext = state.ctx;
  const { link, signer, contract, user } = ctx;
  const session = await hasGuestSession(link.id, signer.id);

  if (state.status === "done") {
    const complete = contract.status === "signed";
    return (
      <Frame brand={brand}>
        <Notice
          icon={CheckCircle2}
          tone="emerald"
          title="امضای شما ثبت شد"
          text={complete ? "قرارداد توسط همه‌ی طرفین امضا و نهایی شد. نسخه‌ی PDF رسمی (با هش امنیتی) به ایمیل شما هم ارسال می‌شود." : "امضای شما با موفقیت ثبت شد. پس از امضای سایر طرف‌ها، نسخه‌ی نهایی برایتان ایمیل می‌شود."}
        />
        {complete && session && (
          <a href={`/api/sign/${token}/pdf`} className="btn-primary btn-mint mt-4 flex w-full !min-h-[50px] justify-center"><FileDown size={17} />دریافت PDF قرارداد</a>
        )}
      </Frame>
    );
  }

  if (await recordLinkOpen(link.id)) await logAudit({ action: "signlink.opened", contractId: contract.id, userId: user.id, detail: `${signer.label} — ${user.name}` });

  if (!session) {
    return (
      <Frame brand={brand}>
        <div className="card !p-6 sm:!p-7">
          <h1 className="text-lg font-black">{contract.title}</h1>
          <p className="mt-1 text-xs text-ink/72">
            <span dir="ltr" className="font-mono">{contract.number}</span>
            {contract.expiresAt && <> • مهلت امضا: {fa(contract.expiresAt)}</>}
          </p>
          <div className="mt-6"><GuestIdentity token={token} maskedMobile={maskMobile(signer.mobile || user.mobile)} signerName={user.name} /></div>
        </div>
        <p className="mt-4 text-center text-xs leading-6 text-ink/72">اتصال شما امن است. زمان، IP و تأیید هویت شما در شناسنامه‌ی دیجیتال قرارداد ثبت می‌شود.</p>
      </Frame>
    );
  }

  const allSigners = await getSigners(contract.id);
  const myFields = fieldsToFill(contract.bodyHtml, allSigners, signer);
  const bodyHtml = await renderContractBody(contract.id, sanitizeHtml(contract.bodyHtml), "web");
  const mine = (await listAttachments(contract.id)).filter((a) => a.uploadedBy === user.id);
  const comments = toPanelComments(await listComments(contract.id, { includeInternal: false }));
  return (
    <Frame brand={brand} wide>
      <div className="space-y-5">
        <section className="panel-solid p-5 sm:p-7">
          <h1 className="text-xl font-black">{contract.title}</h1>
          <p className="mt-1 text-xs text-ink/72"><span dir="ltr" className="font-mono">{contract.number}</span> • صدور: {fa(contract.issuedAt)}</p>
          <article id="contract-article" className="contract-paper contract-body mt-5" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
        </section>
        <NegotiationPanel comments={comments} mode={{ kind: "guest", token }} />
        <AttachmentsPanel
          token={token}
          canUpload
          hint="در صورت نیاز، مدارک خود (مثلاً تصویر کارت ملی) را پیوست کنید؛ فقط شما و صادرکننده‌ی قرارداد آن را می‌بینید."
          items={mine.map((a) => ({ id: a.id, name: a.originalName, size: a.size, sha256: a.sha256, title: a.title, uploader: a.uploaderLabel, at: faTime(a.createdAt), mime: a.mime, deletable: false }))}
        />
        <GuestSignPanel token={token} signerLabel={signer.label} fields={myFields} />
      </div>
    </Frame>
  );
}
