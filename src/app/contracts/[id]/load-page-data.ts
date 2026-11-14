import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/modules/auth/session";
import { getTeamContext } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { getLinkForContract, shortUrl } from "@/modules/links/service";
import { currentSigner, currentSigners, getContractForUser, signerTurnForUser } from "@/modules/contracts/service";
import { getSavedEvidence } from "@/modules/signing/evidence-saved";
import { getContractAudit, logAudit } from "@/modules/audit/service";
import { getOrCreateSigningLink, signingUrl } from "@/modules/signing/links";
import { getStoredPdfInfo } from "@/modules/pdf/service";
import { sanitizeHtml } from "@/lib/html";
import { faTime } from "@/lib/jalali";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts as contractsTable } from "@/db/schema";
import { listAttachments } from "@/modules/attachments/service";
import { contractVersion, listAmendments } from "@/modules/amendments/service";
import { fieldsToFill, renderContractBody } from "@/modules/fields/service";
import { parseFieldDefs } from "@/modules/fields";
import { renewalState } from "@/modules/renewals/service";
import { isApprovalsEnabled } from "@/modules/settings/service";
import { type PanelComment } from "@/components/NegotiationPanel";
import { approverCandidates, listApprovals, summarizeApprovals } from "@/modules/contracts/approvals";
import { listComments } from "@/modules/contracts/negotiation";
import { getSource, listDocFields } from "@/modules/docs/service";
import { revisionCount } from "@/modules/contracts/revisions";
import { type IdentitySignerItem } from "@/components/identity/IdentityAdminPanel";
import { getGateView, listIdentityForContract, type AdminIdentity } from "@/modules/identity/service";
import { shahkarAvailable } from "@/modules/identity/provider";
import { parseIdentityReq } from "@/modules/identity/rules";

/** پارامترهای query صفحه‌ی قرارداد (پیام‌های بازگشت از اکشن‌ها) */
export type ContractPageSearchParams = { reminded?: string; dup?: string; linksent?: string; amend_error?: string; amended?: string; term_error?: string; term_saved?: string; approval?: string; approval_error?: string; meta?: string };

/**
 * بارگذاری داده‌ی صفحه‌ی قرارداد: احراز هویت، دسترسی تیمی، لینک‌ها، نسخه‌ها، مذاکره، هویت و …
 * (بدون هیچ تغییر منطقی از صفحه جدا شده تا خود صفحه فقط نمایش باشد).
 */
export async function loadContractPageData(params: Promise<{ id: string }>, searchParams: Promise<ContractPageSearchParams>) {
  const { id } = await params;
  const { reminded, dup, linksent, amend_error, amended, term_error, term_saved, approval, approval_error, meta } = await searchParams;
  // کاربر لاگین‌نشده (مثلاً از لینک کوتاه) پس از ورود به همین صفحه برمی‌گردد
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/contracts/${Number(id) || 0}`)}`);
  const data = await getContractForUser(user, Number(id));
  if (!data) notFound();
  const { contract, signers, customer } = data;
  // امضای هم‌زمان: چند نفر هم‌زمان نوبت دارند؛ اگر کاربر یکی از آن‌هاست، «نوبت من» همان امضای اوست
  const myTurnSigner = contract.status === "sent" ? signerTurnForUser(signers, user.id) : null;
  const turn = myTurnSigner ?? currentSigner(signers);
  const turnSigners = contract.status === "sent" ? currentSigners(signers) : [];
  const myTurn = !!myTurnSigner;
  // دسترسی تیمی بر اساس نقش کاربر در فضای کاری «همین قرارداد» سنجیده می‌شود
  const isAdmin = !!data.teamRole;
  const team = isAdmin ? await getTeamContext() : null;
  const sameWs = team?.workspaceId === contract.workspaceId;
  const canWrite = isAdmin && sameWs && can(data.teamRole, "write");
  const canDelete = isAdmin && sameWs && can(data.teamRole, "delete");
  const audit = isAdmin ? await getContractAudit(contract.id) : [];
  const linkRow = isAdmin ? await getLinkForContract(contract.id) : null;
  const link = linkRow
    ? {
        code: linkRow.code,
        url: await shortUrl(linkRow.code),
        hasPassword: !!linkRow.passwordHash,
        active: linkRow.active,
        clicks: linkRow.clicks,
        expiresAt: linkRow.expiresAt ? linkRow.expiresAt.toISOString() : null,
      }
    : null;
  const isDraft = contract.status === "draft";
  // لینک امضای اختصاصی نوبت فعلی (برای مدیر: کپی/ارسال مجدد)
  const signLinks: { id: number; label: string; name: string; url: string }[] = [];
  if (canWrite && contract.status === "sent") {
    for (const t of turnSigners) {
      const sl = await getOrCreateSigningLink(t.id);
      if (sl) signLinks.push({ id: t.id, label: t.label, name: t.userName, url: await signingUrl(sl.token, contract.workspaceId) });
    }
  }
  // مهر/پاراف قبلی کاربر برای استفاده‌ی دوباره (فقط وقتی همین حالا باید مهر یا پاراف بزند)
  const needsEvidence = !!myTurnSigner && (myTurnSigner.sealRequired || myTurnSigner.signerType === "legal" || myTurnSigner.initialsRequired);
  const savedEvidence = needsEvidence ? await getSavedEvidence(user.id) : { seal: null, initials: null };
  const pdfInfo = isAdmin && contract.status === "signed" ? await getStoredPdfInfo(contract.id) : null;

  if (!isAdmin) await logAudit({ action: "contract.viewed", contractId: contract.id, userId: user.id });

  const bodyHtml = await renderContractBody(contract.id, sanitizeHtml(contract.bodyHtml), "web");
  const myFields = myTurn && turn ? fieldsToFill(contract.bodyHtml, signers, turn) : [];
  const fieldDefs = parseFieldDefs(contract.bodyHtml);
  // فاز ۲: قرارداد روی فایل بارگذاری‌شده (PDF/Word)
  const docSrc = await getSource(contract.id);
  const docFieldCount = docSrc ? (await listDocFields(contract.id)).length : 0;
  let docSignUrl: string | null = null;
  if (docSrc && myTurn && turn) {
    const l = await getOrCreateSigningLink(turn.id);
    if (l) docSignUrl = await signingUrl(l.token, contract.workspaceId);
  }
  const attachments = contract.status === "draft" ? [] : await listAttachments(contract.id);
  const amendments = contract.status === "draft" ? [] : await listAmendments(contract.id);
  const version = await contractVersion(contract.id);
  const openAmendment = amendments.find((a) => a.status === "sent");
  const mySigner = signers.find((s) => s.userId === user.id);
  const [renewedTo] = await db.select({ id: contractsTable.id, number: contractsTable.number }).from(contractsTable).where(and(eq(contractsTable.renewedFromId, contract.id), eq(contractsTable.workspaceId, contract.workspaceId))).limit(1);
  const [renewedFrom] = contract.renewedFromId ? await db.select({ id: contractsTable.id, number: contractsTable.number }).from(contractsTable).where(eq(contractsTable.id, contract.renewedFromId)) : [];
  const rState = renewalState({ termEndsAt: contract.termEndsAt, renewalNoticeDays: contract.renewalNoticeDays, renewed: !!renewedTo });
  const canUpload = contract.status !== "cancelled" && contract.status !== "draft" && (isAdmin || !!mySigner || contract.customerId === user.id);

  // مذاکره، تأیید داخلی و تاریخچه‌ی نسخه‌ها
  const approvalsOn = isAdmin ? await isApprovalsEnabled(contract.workspaceId) : false;
  const approvals = approvalsOn ? await listApprovals(contract.id) : [];
  const approvalSummary = summarizeApprovals(approvals);
  const candidates = approvalsOn && canWrite && isDraft ? await approverCandidates(contract.workspaceId) : [];
  const comments = await listComments(contract.id, { includeInternal: isAdmin });
  const revCount = isAdmin ? await revisionCount(contract.id) : 0;
  const partyOpen = !isAdmin && ["sent", "signed"].includes(contract.status);
  const negotiationReadOnly = !(canWrite || partyOpen);
  const panelComments: PanelComment[] = comments.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    authorName: c.authorName,
    authorSide: c.authorSide,
    visibility: c.visibility,
    kind: c.kind,
    quote: c.quote,
    body: c.body,
    status: c.status,
    at: faTime(c.createdAt),
    resolvedAt: c.resolvedAt ? faTime(c.resolvedAt) : null,
  }));

  // احراز هویت اختیاری امضاکننده: برای قراردادهای عادی هیچ هزینه‌ای ندارد (نقشه‌ی خالی)
  const idMap = isAdmin && sameWs ? await listIdentityForContract(contract.id) : new Map<number, AdminIdentity>();
  const showIdentity = isAdmin && sameWs && ((canWrite && (isDraft || contract.status === "sent")) || idMap.size > 0);
  const identityAvailable = showIdentity ? await shahkarAvailable() : false;
  const identityItems: IdentitySignerItem[] = signers.map((s) => {
    const i = idMap.get(s.id);
    return {
      id: s.id,
      label: s.label,
      name: s.userName,
      status: s.status,
      req: parseIdentityReq(s.identityReq),
      assurance: s.identityAssurance,
      met: i?.met ?? true,
      shahkar: i?.shahkar ?? "none",
      shahkarProvider: i?.shahkarProvider ?? "",
      shahkarAt: i?.shahkarAt ? i.shahkarAt.toISOString() : null,
      attempts: i?.attempts ?? 0,
      expectedNc: i?.expectedNc ?? "",
      nc: i?.nc ?? "",
      docStatus: i?.docStatus ?? "none",
      docSubmittedAt: i?.docSubmittedAt ? i.docSubmittedAt.toISOString() : null,
      docRejectReason: i?.docRejectReason ?? "",
      hasDocs: i?.hasDocs ?? false,
      sealHash: i?.sealHash ?? "",
    };
  });
  const myGate = myTurn && turn && turn.identityReq !== "none" ? await getGateView(turn.id, user.mobile) : null;
  const myBlocked = !!myGate && !myGate.met;

  const mobile = user.mobile;
  const masked = mobile.length >= 7 ? `${mobile.slice(0, 4)}***${mobile.slice(-4)}` : mobile;

  return { reminded, dup, linksent, amend_error, amended, term_error, term_saved, approval, approval_error, meta, user, contract, signers, customer, turn, turnSigners, myTurn, isAdmin, sameWs, canWrite, canDelete, audit, link, isDraft, signLinks, savedEvidence, pdfInfo, bodyHtml, myFields, fieldDefs, docSrc, docFieldCount, docSignUrl, attachments, amendments, version, openAmendment, renewedTo, renewedFrom, rState, canUpload, approvalsOn, approvals, approvalSummary, candidates, revCount, negotiationReadOnly, panelComments, showIdentity, identityAvailable, identityItems, myGate, myBlocked, masked };
}
