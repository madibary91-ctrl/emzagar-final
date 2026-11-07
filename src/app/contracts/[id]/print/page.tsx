import { notFound } from "next/navigation";
import PrintButton from "@/components/PrintButton";
import { requireUser } from "@/modules/auth/session";
import { getContractForUser } from "@/modules/contracts/service";
import { getAllSettings } from "@/modules/settings/service";
import { sanitizeHtml } from "@/lib/html";
import { renderContractBody } from "@/modules/fields/service";
import { fa, faTime } from "@/lib/jalali";
import QRCode from "qrcode";
import { getOrigin } from "@/lib/request";

export const dynamic = "force-dynamic";

/** نسخه‌ی آماده‌ی چاپ / ذخیره به‌صورت PDF (از طریق Save as PDF مرورگر) */
export default async function PrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ auto?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { auto } = await searchParams;
  const data = await getContractForUser(user, Number(id));
  if (!data) notFound();
  const { contract, signers } = data;
  const cfg = await getAllSettings(contract.workspaceId);
  const complete = contract.status === "signed";
  // QR استعلام اصالت: فقط برای سند کاملاً امضاشده
  let qrSvg = "";
  let verifyUrl = "";
  if (complete && contract.docHash) {
    const origin = (cfg.app_url || (await getOrigin())).replace(/\/+$/, "");
    verifyUrl = `${origin}/verify/${contract.docHash}`;
    qrSvg = await QRCode.toString(verifyUrl, { type: "svg", margin: 1, width: 112, errorCorrectionLevel: "M" });
  }

  return (
    <div className="mx-auto max-w-3xl p-4">
      <div className="no-print mb-4 flex items-center justify-between">
        <span className="text-sm text-stone-600">
          {complete ? "در پنجره‌ی چاپ، مقصد را «Save as PDF» انتخاب کنید." : "این نسخه هنوز نهایی نشده است (پیش‌نویس)."}
        </span>
        <PrintButton auto={complete && auto === "1"} />
      </div>

      <div className="print-sheet card relative bg-white p-8">
        {!complete && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-7xl font-bold text-stone-200 [transform:rotate(-20deg)]">
            پیش‌نویس
          </div>
        )}
        <header className="mb-6 flex items-center justify-between border-b border-stone-300 pb-3 text-sm">
          <b>{cfg.site_name}</b>
          <span>
            شماره: <span dir="ltr" className="font-mono">{contract.number}</span> • {fa(contract.issuedAt)}
          </span>
        </header>

        <div className="contract-body relative" dangerouslySetInnerHTML={{ __html: await renderContractBody(contract.id, sanitizeHtml(contract.bodyHtml), "web") }} />

        <section className="mt-10 break-inside-avoid">
          <h3 className="mb-3 border-b border-stone-300 pb-1 font-bold">امضاها و شناسنامه دیجیتال</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {signers.map((s) => (
              <div key={s.id} className="break-inside-avoid rounded-lg border border-stone-300 p-3 text-xs">
                <div className="mb-1 text-sm font-bold">
                  {s.label}: {s.userName}
                </div>
                {s.status === "signed" && s.signatureFile ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/contracts/${contract.id}/signature/${s.id}`} alt="امضا" className="h-20 object-contain" />
                    <dl className="mt-2 space-y-0.5 text-stone-600">
                      <div>زمان امضا: {faTime(s.signedAt)}</div>
                      <div dir="ltr" className="text-left font-mono">IP: {s.ip}</div>
                      <div>تایید پیامکی: {s.otpVerifiedAt ? "انجام شد ✓" : "—"}</div>
                      <div dir="ltr" className="break-all text-left font-mono text-xs text-stone-600">{s.userAgent}</div>
                    </dl>
                  </>
                ) : (
                  <div className="py-6 text-center text-stone-600">امضا نشده</div>
                )}
              </div>
            ))}
          </div>
          {contract.docHash && (
            <div className="mt-4 flex items-center gap-4 break-inside-avoid rounded-lg border border-stone-300 p-3">
              {qrSvg && <div className="h-[84px] w-[84px] shrink-0 [&>svg]:h-full [&>svg]:w-full" role="img" aria-label="QR استعلام اصالت سند" dangerouslySetInnerHTML={{ __html: qrSvg }} />}
              <div className="min-w-0 text-xs leading-5 text-stone-600">
                <p className="break-all">
                  اثر انگشت سند (SHA-256): <span dir="ltr" className="font-mono">{contract.docHash}</span>
                </p>
                {verifyUrl && <p className="mt-1 break-all">استعلام اصالت: <span dir="ltr" className="font-mono">{verifyUrl}</span></p>}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
