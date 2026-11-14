import Link from "next/link";
import { BellRing, Ban, ChevronLeft, Copy, Download, Eye, FileLock2, Fingerprint, Hourglass, Pencil, RotateCcw, ScanSearch, Trash2 } from "lucide-react";
import Shell from "@/components/Shell";
import StatusBadge from "@/components/StatusBadge";
import SignPanel from "@/components/SignPanel";
import LinkCard from "@/components/LinkCard";
import ConfirmButton from "@/components/ConfirmButton";
import SignerRoster from "@/components/SignerRoster";
import { partyDisplay } from "@/modules/signing/stages";
import { ACTION_LABELS } from "@/modules/audit/service";
import { cancelContractAction, deleteContractAction, duplicateContractAction, remindNowAction, resendSigningLinkAction } from "@/modules/contracts/actions";
import CopyButton from "@/components/CopyButton";
import { sanitizeHtml } from "@/lib/html";
import { fa, faTime } from "@/lib/jalali";
import AttachmentsPanel from "@/components/AttachmentsPanel";
import AmendmentDecision from "@/components/AmendmentDecision";
import { AMENDMENT_STATUS_LABELS } from "@/modules/amendments/service";
import { createAmendmentAction, cancelAmendmentAction } from "@/modules/amendments/actions";
import { RENEWAL_LABELS } from "@/modules/renewals/service";
import { renewContractAction, setTermAction } from "@/modules/renewals/actions";
import { FilePlus2, GitCompareArrows, History, Repeat2 } from "lucide-react";
import ContractJourney from "@/components/ContractJourney";
import ApprovalPanel from "@/components/ApprovalPanel";
import ContractMetaCard from "@/components/ContractMetaCard";
import NegotiationPanel from "@/components/NegotiationPanel";
import ContractPaySection from "@/components/pay/ContractPaySection";
import IdentityAdminPanel from "@/components/identity/IdentityAdminPanel";
import SignerIdentityGate from "@/components/identity/SignerIdentityGate";
import { loadContractPageData, type ContractPageSearchParams } from "./load-page-data";

export const dynamic = "force-dynamic";

export default async function ContractPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<ContractPageSearchParams> }) {
  const { reminded, dup, linksent, amend_error, amended, term_error, term_saved, approval, approval_error, meta, user, contract, signers, customer, turn, turnSigners, myTurn, isAdmin, sameWs, canWrite, canDelete, audit, link, isDraft, signLinks, savedEvidence, pdfInfo, bodyHtml, myFields, fieldDefs, docSrc, docFieldCount, docSignUrl, attachments, amendments, version, openAmendment, renewedTo, renewedFrom, rState, canUpload, approvalsOn, approvals, approvalSummary, candidates, revCount, negotiationReadOnly, panelComments, showIdentity, identityAvailable, identityItems, myGate, myBlocked, masked } = await loadContractPageData(params, searchParams);


  return (
    <Shell user={user}>
      <div className="space-y-5">
        <div className="mb-1 flex items-center gap-2 text-xs text-ink/72">
          <Link href={isAdmin ? "/admin" : "/dashboard"} className="hover:text-ink">قراردادها</Link>
          <ChevronLeft size={12} />
          <span dir="ltr" className="font-mono">{contract.number}</span>
        </div>

        <section className="relative overflow-hidden rounded-[28px] bg-ink px-6 py-7 text-white sm:px-9">
          <div className="hero-grid absolute inset-0 opacity-40" />
          <div className="absolute -left-16 -top-24 h-64 w-64 rounded-full bg-mint/10 blur-[70px]" />
          <div className="relative flex flex-wrap items-start justify-between gap-5">
            <div className="min-w-0">
              <div className="mb-3 flex flex-wrap items-center gap-2"><StatusBadge status={contract.status} />{version > 1 && <span className="badge border border-white/20 bg-white/10 text-white">نسخه‌ی {version.toLocaleString("fa-IR")}</span>}</div>
              <h1 className="text-2xl font-black sm:text-3xl">{contract.title}</h1>
              <p className="mt-3 text-xs leading-7 text-white/65">
                مشتری: {customer?.name} • صدور: {fa(contract.issuedAt)}
                {contract.signedAt && <> • تکمیل: {fa(contract.signedAt)}</>}
                {contract.status === "sent" && contract.expiresAt && <> • مهلت امضا: {fa(contract.expiresAt)}</>}
              </p>
            </div>
            <div className="no-print flex flex-wrap items-center gap-2">
              <Link href={`/contracts/${contract.id}/print`} target="_blank" className="btn-secondary !min-h-10 !border-white/10 !bg-white/[.07] !text-white hover:!bg-white/15">
                <Eye size={15} />
                پیش‌نمایش چاپی
              </Link>
              {contract.status === "signed" && (
                <a href={`/api/contracts/${contract.id}/pdf`} className="btn-primary btn-mint !min-h-10">
                  <Download size={15} />
                  دانلود PDF
                </a>
              )}
              {isAdmin && revCount > 0 && (
                <Link href={`/admin/contracts/${contract.id}/history`} className="btn-secondary !min-h-10 !border-white/10 !bg-white/[.07] !text-white hover:!bg-white/15"><GitCompareArrows size={15} />نسخه‌ها ({revCount.toLocaleString("fa-IR")})</Link>
              )}
              {canWrite && (
                <Link href={`/admin/risk?contract=${contract.id}`} className="btn-secondary !min-h-10 !border-white/10 !bg-white/[.07] !text-white hover:!bg-white/15"><ScanSearch size={15} />تحلیل ریسک</Link>
              )}
              {canWrite && isDraft && (
                <Link href={`/admin/contracts/${contract.id}/edit`} className="btn-primary btn-mint !min-h-10"><Pencil size={15} />ویرایش و انتشار</Link>
              )}
              {canWrite && !isDraft && (
                <form action={duplicateContractAction}>
                  <input type="hidden" name="id" value={contract.id} />
                  {["rejected", "expired", "cancelled"].includes(contract.status) ? (
                    <button className="btn-primary btn-mint !min-h-10" title="ساخت پیش‌نویس جدید با همین مشتری، امضاکنندگان و متن"><RotateCcw size={15} />صدور مجدد</button>
                  ) : (
                    <button className="btn-secondary !min-h-10 !border-white/10 !bg-white/[.07] !text-white hover:!bg-white/15" title="ساخت پیش‌نویس جدید با همین مشتری، امضاکنندگان و متن"><Copy size={15} />کپی قرارداد</button>
                  )}
                </form>
              )}
              {canWrite && contract.status === "sent" && (
                <>
                  <form action={remindNowAction}>
                    <input type="hidden" name="id" value={contract.id} />
                    <button className="btn-secondary !min-h-10 !border-white/10 !bg-white/[.07] !text-white hover:!bg-white/15"><BellRing size={15} />یادآوری</button>
                  </form>
                </>
              )}
              {canDelete && contract.status === "sent" && (
                <form action={cancelContractAction}>
                  <input type="hidden" name="id" value={contract.id} />
                  <ConfirmButton message="این قرارداد لغو شود؟ امضاکننده دیگر نمی‌تواند آن را امضا کند." className="btn-secondary !min-h-10 !border-white/10 !bg-white/[.07] !text-white hover:!bg-white/15"><Ban size={15} />لغو</ConfirmButton>
                </form>
              )}
              {canDelete && (
                <form action={deleteContractAction}>
                  <input type="hidden" name="id" value={contract.id} />
                  <ConfirmButton message="این قرارداد برای همیشه حذف شود؟ این کار قابل بازگشت نیست." className="btn-danger !min-h-10"><Trash2 size={15} />حذف</ConfirmButton>
                </form>
              )}
            </div>
          </div>
        </section>

        <ContractJourney
          status={contract.status}
          createdAt={contract.issuedAt}
          publishedAt={contract.publishedAt}
          signedAt={contract.signedAt}
          approvals={approvalSummary.total > 0 ? { total: approvalSummary.total, approved: approvalSummary.approved } : null}
          signers={signers.map((s) => ({ id: s.id, label: s.label, name: s.userName, status: s.status, signedAt: s.signedAt }))}
        />
        {contract.archivedAt && <p role="status" className="rounded-2xl border border-stone-300 bg-stone-100 p-4 text-xs text-stone-700">این قرارداد در تاریخ {fa(contract.archivedAt)} بایگانی شده است (همه‌ی سوابق و فایل‌ها محفوظ است).</p>}
        {isAdmin && !sameWs && <p role="status" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">این قرارداد متعلق به فضای کاری دیگری از حساب شماست؛ برای مدیریت آن، فضای کاری را (از منوی کناری) تغییر دهید.</p>}
        {dup === "failed" && isAdmin && <p role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs leading-7 text-rose-800">کپی قرارداد ممکن نشد؛ احتمالاً یکی از امضاکنندگان این قرارداد دیگر عضو این فضای کاری نیست. قرارداد جدید را از «صدور قرارداد» بسازید.</p>}
        {reminded && isAdmin && <p role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-800">یادآوری برای امضاکننده‌ی فعلی ارسال شد.</p>}
        {isDraft && canWrite && (
          <p className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-xs leading-7 text-sky-800">این قرارداد «پیش‌نویس» است و هنوز برای هیچ‌کس ارسال نشده. پس از انتشار نسخه نهایی، متن قفل می‌شود.</p>
        )}
        {linksent && isAdmin && <p role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-800">لینک امضا برای امضاکننده‌ی فعلی ایمیل/پیامک شد.</p>}
        {signLinks.map((sl) => (
          <section key={sl.id} className="panel-solid space-y-3 p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-black">لینک امضای امن — {sl.label} ({sl.name})</h2>
                <p className="mt-1 text-xs leading-6 text-ink/75">امضاکننده بدون ثبت‌نام و فقط با همین لینک اختصاصی و کد پیامکی (OTP) امضا می‌کند. پس از امضا یا لغو، لینک خودکار باطل می‌شود.</p>
              </div>
              <form action={resendSigningLinkAction} className="flex gap-2">
                <input type="hidden" name="id" value={contract.id} />
                <button className="btn-secondary btn-sm"><BellRing size={14} />ارسال مجدد لینک{signLinks.length > 1 ? " (همه‌ی نوبت‌دارها)" : ""}</button>
              </form>
            </div>
            <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-stone-50 p-3">
              <span dir="ltr" className="min-w-0 flex-1 break-all text-left font-mono text-xs text-ink/70">{sl.url}</span>
              <CopyButton text={sl.url} label="کپی لینک" />
            </div>
          </section>
        ))}
        {pdfInfo && (
          <p role="status" className="break-all rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs leading-7 text-emerald-900">
            PDF رسمی روی سرور ساخته و در پوشه‌ی محافظت‌شده نگهداری می‌شود. SHA-256 فایل: <span dir="ltr" className="font-mono">{pdfInfo.sha256}</span>
          </p>
        )}
        {canWrite && !isDraft && <LinkCard contractId={contract.id} link={link} />}

        <SignerRoster contractId={contract.id} signers={signers} status={contract.status} signingMode={contract.signingMode} />

        {showIdentity && <IdentityAdminPanel contractId={contract.id} items={identityItems} canEdit={canWrite && (isDraft || contract.status === "sent")} shahkarAvailable={identityAvailable} />}

        <section className="overflow-hidden rounded-[26px] border border-ink/10 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-ink/10 px-5 py-4">
            <span className="flex items-center gap-2 text-xs font-bold"><FileLock2 size={16} />متن قرارداد</span>
            <span dir="ltr" className="font-mono text-xs text-ink/72">{contract.number}</span>
          </div>
          <div className="thin-scroll bg-[#e7e9e3] p-3 sm:p-7">
            {docSrc ? (
              <div id="contract-article" className="rounded-2xl border border-ink/10 bg-white p-5 text-sm leading-8">
                <p className="font-black">این قرارداد روی فایل «{docSrc.originalName}» امضا می‌شود</p>
                <p className="text-xs text-ink/70">{docSrc.pageCount} صفحه • {docFieldCount} فیلد/جای امضا • فایل اصلی بدون تغییر نگهداری می‌شود و نسخه‌ی نهایی = همان فایل + امضاها + گواهی.</p>
                <p dir="ltr" className="mt-1 break-all text-left font-mono text-[10px] text-ink/55">SHA-256: {docSrc.originalSha256}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a className="btn-secondary btn-sm" href={`/api/docs/contract/${contract.id}`} target="_blank" rel="noopener noreferrer"><Eye size={14} />نمایش فایل</a>
                  <a className="btn-secondary btn-sm" href={`/api/docs/contract/${contract.id}?v=original`}><Download size={14} />دریافت فایل اصلی</a>
                </div>
              </div>
            ) : (
              <article id="contract-article" className="contract-paper contract-body" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
            )}
          </div>
        </section>

        {approvalsOn && <ApprovalPanel contractId={contract.id} returnTo={`/contracts/${contract.id}`} rows={approvals} candidates={candidates} meId={user.id} canWrite={canWrite} isDraft={isDraft} flash={approval} error={approval_error} />}
        <NegotiationPanel
          comments={panelComments}
          mode={{ kind: "user", contractId: contract.id, isTeam: isAdmin, canResolve: canWrite, draft: isDraft }}
          readOnly={negotiationReadOnly}
        />
        <ContractPaySection contract={{ id: contract.id, status: contract.status, workspaceId: contract.workspaceId, contractValue: contract.contractValue }} signers={signers.map((s) => ({ id: s.id, position: s.position, userId: s.userId, label: s.label, status: s.status }))} userId={user.id} isAdmin={isAdmin} canWrite={canWrite} canDelete={canDelete} />
        {isAdmin && <ContractMetaCard contractId={contract.id} tags={contract.tags} value={contract.contractValue} status={contract.status} archivedAt={contract.archivedAt} canWrite={canWrite} saved={meta === "1"} />}
        {fieldDefs.length > 0 && contract.status === "signed" && <p role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs leading-7 text-emerald-900">اطلاعات تکمیل‌شده‌ی امضاکنندگان ({fieldDefs.length.toLocaleString("fa-IR")} فیلد) در متن قرارداد درج و در اثر انگشت سند قفل شده است.</p>}
        {canUpload && <AttachmentsPanel contractId={contract.id} canUpload items={attachments.map((a) => ({ id: a.id, name: a.originalName, size: a.size, sha256: a.sha256, title: a.title, uploader: a.uploaderLabel, at: faTime(a.createdAt), mime: a.mime, deletable: contract.status !== "signed" && (a.uploadedBy === user.id || canWrite) }))} />}
        {(contract.status === "signed" || amendments.length > 0) && (
          <section id="amendments" className="panel-solid scroll-mt-24 space-y-4 p-5 sm:p-6" aria-labelledby="amendments-title">
            <div className="flex flex-wrap items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-mint"><History size={18} /></span>
              <div className="flex-1">
                <h2 id="amendments-title" className="text-sm font-black">الحاقیه‌ها و نسخه‌بندی</h2>
                <p className="mt-0.5 text-xs text-ink/72">تغییر قرارداد امضاشده فقط با الحاقیه‌ی رسمی و تأیید (OTP) همه‌ی امضاکنندگان ممکن است.</p>
              </div>
              <span className="badge border border-sky-200 bg-sky-50 text-sky-800">نسخه‌ی {version.toLocaleString("fa-IR")}</span>
            </div>
            {amended && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">الحاقیه ثبت و برای امضاکنندگان ارسال شد.</p>}
            {amend_error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{amend_error}</p>}
            {amendments.length === 0 && <p className="rounded-2xl bg-stone-50 p-4 text-xs text-ink/72">هنوز الحاقیه‌ای ثبت نشده است.</p>}
            <div className="space-y-3">
              {amendments.map((a) => {
                const mine = a.signers.find((x) => x.userId === user.id && x.status === "pending");
                return (
                  <details key={a.id} open={a.status === "sent"} className="rounded-2xl border border-ink/10 bg-stone-50/50 p-4">
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-xs font-bold">
                      <span>الحاقیه‌ی {a.seq.toLocaleString("fa-IR")} — {a.title}</span>
                      <span className={`badge border ${a.status === "signed" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : a.status === "sent" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-rose-200 bg-rose-50 text-rose-700"}`}>{AMENDMENT_STATUS_LABELS[a.status] ?? a.status}</span>
                      <span className="text-ink/72 font-normal">{fa(a.createdAt)}</span>
                    </summary>
                    <div className="mt-4 space-y-4">
                      <article className="contract-paper contract-body !min-h-0 !p-5" dangerouslySetInnerHTML={{ __html: sanitizeHtml(a.bodyHtml) }} />
                      <ul className="flex flex-wrap gap-2 text-xs">
                        {a.signers.map((x) => (
                          <li key={x.id} className="rounded-full border border-ink/10 bg-white px-3 py-1">
                            {x.label} — {x.userName}: <b>{x.status === "accepted" ? "✓ تأیید کرد" : x.status === "rejected" ? "✕ رد کرد" : "در انتظار"}</b>
                          </li>
                        ))}
                      </ul>
                      {a.docHash && <p className="break-all text-xs text-ink/72">اثر انگشت الحاقیه: <span dir="ltr" className="font-mono">{a.docHash}</span></p>}
                      <div className="flex flex-wrap gap-2">
                        {a.status === "signed" && <a href={`/api/contracts/${contract.id}/amendments/${a.seq}/pdf`} className="btn-secondary btn-sm"><Download size={14} />PDF الحاقیه</a>}
                        {a.status === "sent" && canWrite && (
                          <form action={cancelAmendmentAction}>
                            <input type="hidden" name="contractId" value={contract.id} />
                            <input type="hidden" name="amendmentId" value={a.id} />
                            <ConfirmButton message="این الحاقیه لغو شود؟" className="btn-danger btn-sm"><Ban size={14} />لغو الحاقیه</ConfirmButton>
                          </form>
                        )}
                      </div>
                      {mine && <AmendmentDecision who={{ amendmentId: a.id }} maskedMobile={masked} />}
                    </div>
                  </details>
                );
              })}
            </div>
            {canWrite && contract.status === "signed" && !openAmendment && (
              <form action={createAmendmentAction} className="space-y-3 rounded-2xl border border-dashed border-ink/20 p-4">
                <input type="hidden" name="contractId" value={contract.id} />
                <h3 className="flex items-center gap-2 text-xs font-black"><FilePlus2 size={15} />صدور الحاقیه‌ی جدید</h3>
                <div>
                  <label className="label" htmlFor="am-title">عنوان الحاقیه</label>
                  <input id="am-title" name="title" required minLength={3} maxLength={150} className="input" placeholder="مثلاً افزایش مبلغ قرارداد" />
                </div>
                <div>
                  <label className="label" htmlFor="am-body">متن الحاقیه</label>
                  <textarea id="am-body" name="body" required minLength={10} maxLength={20000} rows={5} className="input" placeholder="بند یا بندهایی که اضافه/اصلاح می‌شود… (پاراگراف‌ها را با یک خط خالی جدا کنید)" />
                </div>
                <button className="btn-primary"><FilePlus2 size={16} />ثبت و ارسال برای تأیید طرفین</button>
              </form>
            )}
          </section>
        )}
        {isAdmin && contract.status === "signed" && (
          <section id="renewal" className="panel-solid scroll-mt-24 space-y-4 p-5 sm:p-6" aria-labelledby="renewal-title">
            <div className="flex flex-wrap items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-mint"><Repeat2 size={18} /></span>
              <div className="flex-1">
                <h2 id="renewal-title" className="text-sm font-black">زمان‌بندی تمدید</h2>
                <p className="mt-0.5 text-xs text-ink/72">پایان مدت را ثبت کنید تا سامانه پیش از موعد یادآوری بفرستد و صدور مجدد را پیشنهاد دهد.</p>
              </div>
              <span className={`badge border ${rState === "ended" ? "border-rose-200 bg-rose-50 text-rose-700" : rState === "due" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-ink/10 bg-stone-50 text-ink/75"}`}>{RENEWAL_LABELS[rState]}</span>
            </div>
            {term_saved && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">زمان‌بندی ذخیره شد.</p>}
            {term_error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{term_error}</p>}
            {renewedFrom && <p className="text-xs text-ink/75">این قرارداد تمدیدِ <Link href={`/contracts/${renewedFrom.id}`} className="font-bold underline">{renewedFrom.number}</Link> است.</p>}
            {contract.termEndsAt && <p className="text-xs leading-7 text-ink/75">پایان مدت: <b>{fa(contract.termEndsAt)}</b> • یادآوری {contract.renewalNoticeDays.toLocaleString("fa-IR")} روز قبل{contract.renewalNotifiedAt ? " (ارسال شده)" : ""}</p>}
            {canWrite && (
              <form action={setTermAction} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
                <input type="hidden" name="id" value={contract.id} />
                <div>
                  <label className="label" htmlFor="term-date">تاریخ پایان مدت</label>
                  <input id="term-date" name="termEnds" type="date" dir="ltr" defaultValue={contract.termEndsAt ? contract.termEndsAt.toISOString().slice(0, 10) : ""} className="input" />
                </div>
                <div>
                  <label className="label" htmlFor="term-notice">یادآوری (روز قبل)</label>
                  <input id="term-notice" name="noticeDays" type="number" min={1} max={365} dir="ltr" defaultValue={contract.renewalNoticeDays} className="input" />
                </div>
                <button className="btn-secondary">ذخیره</button>
                {contract.termEndsAt && <button name="clear" value="1" formNoValidate className="btn-ghost">حذف زمان‌بندی</button>}
              </form>
            )}
            {canWrite && (
              <div className="flex flex-wrap items-center gap-3 border-t border-ink/10 pt-4">
                {renewedTo ? (
                  <Link href={`/contracts/${renewedTo.id}`} className="btn-secondary"><Repeat2 size={16} />تمدید ثبت شده: {renewedTo.number}</Link>
                ) : (
                  <form action={renewContractAction}>
                    <input type="hidden" name="id" value={contract.id} />
                    <button className={rState === "due" || rState === "ended" ? "btn-primary btn-mint" : "btn-secondary"}><Repeat2 size={16} />ساخت پیش‌نویس تمدید</button>
                  </form>
                )}
                <span className="text-xs text-ink/72">پیش‌نویس جدید با همان مشتری، امضاکنندگان و متن ساخته می‌شود و پیش از انتشار قابل ویرایش است.</span>
              </div>
            )}
          </section>
        )}
        {myTurn && turn && myBlocked && myGate && <SignerIdentityGate mode={{ kind: "account", contractId: contract.id }} view={myGate} signerName={user.name} />}
        {myTurn && turn && !myBlocked && !docSrc && <SignPanel
            contractId={contract.id}
            signerLabel={turn.label}
            maskedMobile={masked}
            fields={myFields}
            ctx={{ role: turn.role, parallelWith: turnSigners.filter((t) => t.id !== turn.id).map((t) => partyDisplay(t)) }}
            evidence={{ sealRequired: turn.sealRequired, legal: turn.signerType === "legal" && turn.role !== "witness", initialsRequired: turn.initialsRequired, companyName: turn.companyName, companyNationalId: turn.companyNationalId, savedSeal: savedEvidence.seal, savedInitials: savedEvidence.initials }}
          />}
        {myTurn && turn && !myBlocked && docSrc && (
          <section className="panel-solid space-y-3 p-5">
            <h2 className="text-base font-black">امضا روی فایل</h2>
            <p className="text-xs leading-7 text-ink/75">فیلدها و جای امضا روی خودِ فایل است؛ برای دیدن فایل و امضای آن از صفحه‌ی امضای اختصاصی خود استفاده کنید.</p>
            {docSignUrl && <a href={docSignUrl} className="btn-primary btn-mint">رفتن به صفحه‌ی امضا</a>}
          </section>
        )}
        {!myTurn && contract.status === "sent" && (
          <div className="panel-solid flex items-center gap-3 p-5 text-xs text-ink/75">
            <Hourglass size={18} className="text-amber-600" />
            {turnSigners.length ? `این قرارداد در انتظار ${turnSigners.length > 1 ? "امضای هم‌زمان" : "امضای"} «${turnSigners.map((t) => `${t.label} — ${t.userName}`).join("» و «")}» است.` : ""}
          </div>
        )}

        {isAdmin && (
          <section className="panel-solid overflow-hidden">
            <div className="flex items-center gap-3 border-b border-ink/10 px-6 py-5">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-mint"><Fingerprint size={18} /></span>
              <div>
                <h2 className="text-sm font-black">شناسنامه دیجیتال و لاگ تغییرات</h2>
                <p className="mt-0.5 text-xs text-ink/72">ردپای زمان، کاربر، IP و جزئیات هر رویداد</p>
              </div>
            </div>
            {contract.docHash && (
              <p className="mx-6 mt-5 break-all rounded-2xl bg-stone-50 p-4 text-xs text-ink/75">
                اثر انگشت سند (SHA-256): <span dir="ltr" className="font-mono">{contract.docHash}</span>
                {contract.status === "signed" && <a href={`/verify/${contract.docHash}`} target="_blank" rel="noopener noreferrer" className="mr-2 font-bold text-emerald-700 underline">استعلام عمومی اصالت</a>}
              </p>
            )}
            <div className="overflow-x-auto p-2">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-ink/10">
                    <th className="th">زمان</th>
                    <th className="th">رویداد</th>
                    <th className="th">کاربر</th>
                    <th className="th">IP</th>
                    <th className="th">User-Agent</th>
                    <th className="th">جزئیات</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id} className="border-b border-ink/[.06] align-top">
                      <td className="td whitespace-nowrap text-xs">{faTime(a.createdAt)}</td>
                      <td className="td">{ACTION_LABELS[a.action] ?? a.action}</td>
                      <td className="td">{a.userName ?? "—"}</td>
                      <td className="td font-mono text-xs" dir="ltr">{a.ip}</td>
                      <td className="td max-w-xs truncate text-xs text-ink/72" title={a.userAgent ?? ""} dir="ltr">{a.userAgent}</td>
                      <td className="td text-xs text-ink/75">{a.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </Shell>
  );

}
