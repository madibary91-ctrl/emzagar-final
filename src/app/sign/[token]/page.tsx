import { CheckCircle2, Clock, FileDown, ShieldAlert } from "lucide-react";
import { Brand } from "@/components/Brand";
import ChatWidget from "@/components/chat/ChatWidget";
import { GuestIdentity, GuestSignPanel } from "@/components/GuestSign";
import MessengerSignCard from "@/components/MessengerSignCard";
import GuestDocSign from "@/components/GuestDocSign";
import { getSource, listDocFields, parseMeta } from "@/modules/docs/service";
import { fieldKey } from "@/modules/docs/placement";
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
import VaultSignCta from "@/components/vault/VaultSignCta";
import { normalizeMobile } from "@/modules/guests/service";
import { getGrowthOffer } from "@/modules/vault/growth";
import PayInstallments from "@/components/pay/PayInstallments";
import { contractGateways } from "@/modules/payments/workspace";
import { listInstallments } from "@/modules/contract-pay/service";
import { payerSigner, blockingInstallments } from "@/modules/contract-pay/gate";
import { toPayItems } from "@/modules/contract-pay/view";
import { isVaultEnabled } from "@/modules/vault/service";
import SignerIdentityGate from "@/components/identity/SignerIdentityGate";
import { getGateView } from "@/modules/identity/service";
import { identityLevel } from "@/modules/identity/rules";
import { currentStageSigners, partyDisplay } from "@/modules/signing/stages";

export const dynamic = "force-dynamic";
// توکن داخل آدرس است: هرگز نباید از طریق Referer به سایت دیگری برود یا ایندکس شود
export const metadata = { title: "امضای قرارداد", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

type BrandInfo = Awaited<ReturnType<typeof getBranding>>;

function Frame({ brand, children, wide, chat }: { brand: BrandInfo; children: React.ReactNode; wide?: boolean; chat?: string }) {
  return (
    <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
      <div className={`mx-auto w-full ${wide ? "max-w-3xl" : "max-w-md"}`}>
        <div className="mb-7 flex justify-center"><Brand name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} /></div>
        {children}
      </div>
      {/* گفتگوی زنده با فرستنده‌ی قرارداد / پشتیبانی (بدون ثبت‌نام؛ دسترسی با همین لینک اختصاصی) */}
      {chat && <ChatWidget context={{ kind: "sign", ref: chat }} />}
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
export default async function SignPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ pay?: string; msg?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
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

  // امضا و پرداخت: تعهدات مالی همین امضاکننده (فقط با نشست OTP نمایش داده می‌شود)
  const payerRows = session ? await listInstallments(contract.id) : [];
  const payerSigners = payerRows.length ? await getSigners(contract.id) : [];
  const myPay = payerRows.filter((r) => payerSigner(payerSigners, r.payerPosition)?.id === signer.id);
  const payBlocked = session && myPay.length ? (await blockingInstallments(contract.id, signer.id)).length > 0 : false;
  const payGateways = myPay.length ? await contractGateways(contract.workspaceId) : [];
  const payBanner = sp.pay && sp.msg ? (
    <div role="status" className={`mb-4 rounded-2xl border p-4 text-sm font-semibold ${sp.pay === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-700"}`}>{sp.msg.slice(0, 200)}</div>
  ) : null;
  const payPanel = myPay.length ? (
    <PayInstallments
      items={toPayItems(myPay, contract.status)}
      gateways={payGateways.map((g) => ({ id: g.id, label: g.label, blurb: g.blurb, own: g.own }))}
      signToken={token}
      intro="مبلغ‌ها از روی قرارداد تعیین شده و قابل تغییر نیست. می‌توانید همین حالا پرداخت کنید؛ رسید هر پرداخت در شناسنامه‌ی قرارداد ثبت می‌شود."
    />
  ) : null;

  if (state.status === "done") {
    const complete = contract.status === "signed";
    // حلقه‌ی رشد: امضاکننده‌ی مهمان را همین‌جا به «کیف اسناد» می‌بریم (نشست OTP امضا هنوز معتبر است)
    const vaultMobile = user.isGuest && (await isVaultEnabled()) ? normalizeMobile(user.mobile || signer.mobile) : null;
    let vaultGift = "";
    if (vaultMobile) {
      const offer = await getGrowthOffer(vaultMobile);
      if (offer.rewardsOn) {
        const parts = [offer.giftWallet > 0 ? `${offer.giftWallet.toLocaleString("fa-IR")} تومان اعتبار` : "", offer.giftCredits > 0 ? `${offer.giftCredits.toLocaleString("fa-IR")} قرارداد رایگان` : ""].filter(Boolean);
        if (parts.length) vaultGift = `هدیه‌ی شما: با ساخت حساب و ارسال اولین قرارداد، ${parts.join(" + ")} می‌گیرید.`;
      }
    }
    return (
      <Frame brand={brand} chat={token}>
        <Notice
          icon={CheckCircle2}
          tone="emerald"
          title="امضای شما ثبت شد"
          text={
            user.isGuest
              ? complete
                ? "قرارداد توسط همه‌ی طرفین امضا و نهایی شد. نسخه‌ی PDF رسمی (با هش امنیتی) را همین‌جا دریافت کنید؛ هر زمان همین لینک را باز کنید، با کد پیامکی می‌توانید دوباره آن را بگیرید."
                : "امضای شما با موفقیت ثبت شد. پس از امضای سایر طرف‌ها، با باز کردن همین لینک و تأیید کد پیامکی می‌توانید نسخه‌ی نهایی را دریافت کنید."
              : complete
                ? "قرارداد توسط همه‌ی طرفین امضا و نهایی شد. نسخه‌ی PDF رسمی (با هش امنیتی) به ایمیل شما هم ارسال می‌شود."
                : "امضای شما با موفقیت ثبت شد. پس از امضای سایر طرف‌ها، نسخه‌ی نهایی برایتان ایمیل می‌شود."
          }
        />
        {complete && session && (
          <a href={`/api/sign/${token}/pdf`} className="btn-primary btn-mint mt-4 flex w-full !min-h-[50px] justify-center"><FileDown size={17} />دریافت PDF قرارداد</a>
        )}
        {complete && !session && (
          <div className="card mt-4 !p-6"><GuestIdentity mode="receipt" token={token} maskedMobile={maskMobile(signer.mobile || user.mobile)} signerName={user.name} /></div>
        )}
        {payBanner}
        {payPanel && <div className="mt-4">{payPanel}</div>}
        {vaultMobile && <VaultSignCta token={token} hasSession={session} giftText={vaultGift} />}
      </Frame>
    );
  }

  if (await recordLinkOpen(link.id)) await logAudit({ action: "signlink.opened", contractId: contract.id, userId: user.id, detail: `${signer.label} — ${user.name}` });

  if (!session) {
    return (
      <Frame brand={brand} chat={token}>
        <div className="card !p-6 sm:!p-7">
          <h1 className="text-lg font-black">{contract.title}</h1>
          <p className="mt-1 text-xs text-ink/72">
            <span dir="ltr" className="font-mono">{contract.number}</span>
            {contract.expiresAt && <> • مهلت امضا: {fa(contract.expiresAt)}</>}
          </p>
          <div className="mt-6"><GuestIdentity token={token} maskedMobile={maskMobile(signer.mobile || user.mobile)} signerName={user.name} /></div>
        </div>
        {signer.identityReq !== "none" && (
          <p role="note" className="mt-4 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-xs leading-7 text-sky-900">
            <b>این قرارداد تأیید هویت دارد ({identityLevel(signer.identityReq).title}).</b> پس از تأیید کد پیامکی، یک مرحله‌ی کوتاه برای اثبات هویت‌تان خواهید داشت
            {signer.identityReq === "shahkar" || signer.identityReq === "both" ? "؛ کد ملی خودتان را آماده داشته باشید" : ""}
            {signer.identityReq === "document" || signer.identityReq === "both" ? " و کارت ملی‌تان را برای عکس‌گرفتن در دسترس داشته باشید" : ""}.
          </p>
        )}
        {(signer.role === "witness" || signer.sealRequired || signer.initialsRequired) && (
          <p role="note" className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs leading-7 text-emerald-900">
            {signer.role === "witness" && <>شما به‌عنوان <b>شاهد</b> دعوت شده‌اید و فقط گواهی بر امضای طرفین می‌دهید. </>}
            {signer.sealRequired && <>برای امضا، <b>تصویر مهر شرکت</b> را آماده داشته باشید. </>}
            {signer.initialsRequired && <>در این سند باید <b>همه‌ی صفحات را پاراف</b> کنید. </>}
          </p>
        )}
        <p className="mt-4 text-center text-xs leading-6 text-ink/72">اتصال شما امن است. زمان، IP و تأیید هویت شما در شناسنامه‌ی دیجیتال قرارداد ثبت می‌شود.</p>
      </Frame>
    );
  }

  // احراز هویت اختیاری: فقط وقتی صادرکننده سطح را بالا برده باشد (برای اسناد عادی null است)
  const gateView = await getGateView(signer.id, user.mobile);
  const identityBlocked = !!gateView && !gateView.met;
  const allSigners = await getSigners(contract.id);
  const myFields = fieldsToFill(contract.bodyHtml, allSigners, signer);
  // شاهد / شرکت / مهر / پاراف / امضای هم‌زمان
  const isLegal = signer.signerType === "legal" && signer.role !== "witness";
  const evidenceNeeds = { sealRequired: signer.sealRequired, legal: isLegal, initialsRequired: signer.initialsRequired, companyName: signer.companyName, companyNationalId: signer.companyNationalId };
  const parallelWith = currentStageSigners(allSigners).filter((s) => s.id !== signer.id).map((s) => partyDisplay(s));
  const bodyHtml = await renderContractBody(contract.id, sanitizeHtml(contract.bodyHtml), "web");
  const docSrc = await getSource(contract.id);
  const docFields = docSrc
    ? (await listDocFields(contract.id)).map((f) => ({
        key: fieldKey(f.id),
        kind: f.kind as "signature" | "name" | "date" | "text" | "checkbox",
        label: f.label,
        page: f.page,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        required: f.required,
        mine: f.signerPosition === signer.position,
        signerLabel: allSigners.find((s) => s.position === f.signerPosition)?.label ?? "",
      }))
    : [];
  const mine = (await listAttachments(contract.id)).filter((a) => a.uploadedBy === user.id);
  const comments = toPanelComments(await listComments(contract.id, { includeInternal: false }));
  return (
    <Frame brand={brand} wide chat={token}>
      <div className="space-y-5">
        {payBanner}
        {identityBlocked && gateView && <SignerIdentityGate mode={{ kind: "guest", token }} view={gateView} signerName={user.name} />}
        {gateView?.met && (
          <p role="status" className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-bold text-emerald-800"><CheckCircle2 size={16} />هویت شما تأیید شده است ({identityLevel(gateView.req).title})؛ می‌توانید قرارداد را امضا کنید.</p>
        )}
        <section className="panel-solid p-5 sm:p-7">
          <h1 className="text-xl font-black">{contract.title}</h1>
          <p className="mt-1 text-xs text-ink/72"><span dir="ltr" className="font-mono">{contract.number}</span> • صدور: {fa(contract.issuedAt)}</p>
          {docSrc ? (
            <p className="mt-3 rounded-xl bg-stone-50 p-3 text-xs leading-7 text-ink/75">این قرارداد روی فایل «{docSrc.originalName}» است. فایل را مطالعه کنید، جاهای مشخص‌شده را پر کنید و در پایین امضا کنید؛ امضای شما دقیقاً روی همین فایل درج می‌شود.</p>
          ) : (
            <article id="contract-article" className="contract-paper contract-body mt-5" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
          )}
        </section>
        <NegotiationPanel comments={comments} mode={{ kind: "guest", token }} />
        <AttachmentsPanel
          token={token}
          canUpload
          hint="در صورت نیاز، مدارک خود (مثلاً تصویر کارت ملی) را پیوست کنید؛ فقط شما و صادرکننده‌ی قرارداد آن را می‌بینید."
          items={mine.map((a) => ({ id: a.id, name: a.originalName, size: a.size, sha256: a.sha256, title: a.title, uploader: a.uploaderLabel, at: faTime(a.createdAt), mime: a.mime, deletable: false }))}
        />
        {payPanel}
        {identityBlocked ? (
          <div className="card !p-6 text-center" role="status">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-sky-50 text-sky-700"><ShieldAlert size={22} /></span>
            <p className="mt-3 text-sm font-black">امضا پس از تأیید هویت فعال می‌شود</p>
            <p className="mt-1 text-xs leading-7 text-ink/75">مراحل «تأیید هویت» بالای صفحه را کامل کنید؛ سپس دکمه‌ی امضا در همین‌جا ظاهر می‌شود.</p>
          </div>
        ) : payBlocked ? (
          <div className="card !p-6 text-center" role="status">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-amber-50 text-amber-600"><ShieldAlert size={22} /></span>
            <p className="mt-3 text-sm font-black">امضا پس از پرداخت فعال می‌شود</p>
            <p className="mt-1 text-xs leading-7 text-ink/75">بیعانه یا پرداخت پیش‌شرط را در بخش «تعهدات مالی» بالا انجام دهید؛ سپس به همین صفحه برمی‌گردید و می‌توانید امضا کنید.</p>
          </div>
        ) : docSrc ? (
          <GuestDocSign token={token} signerLabel={signer.label} signerName={user.name} pages={parseMeta(docSrc.pagesMeta)} fields={docFields} evidence={evidenceNeeds} />
        ) : (
          <GuestSignPanel token={token} signerLabel={signer.label} fields={myFields} evidence={evidenceNeeds} role={signer.role} parallelWith={parallelWith} />
        )}
        {user.isGuest && <MessengerSignCard userId={user.id} workspaceId={contract.workspaceId} />}
      </div>
    </Frame>
  );
}
