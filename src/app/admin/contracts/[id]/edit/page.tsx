import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import Shell from "@/components/Shell";
import DraftForm from "@/components/DraftForm";
import StatusBadge from "@/components/StatusBadge";
import { db } from "@/db";
import { contracts } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import Link from "next/link";
import { GitCompareArrows } from "lucide-react";
import ApprovalPanel from "@/components/ApprovalPanel";
import NegotiationPanel from "@/components/NegotiationPanel";
import { approverCandidates, listApprovals } from "@/modules/contracts/approvals";
import { listComments } from "@/modules/contracts/negotiation";
import { toPanelComments } from "@/modules/contracts/negotiation-view";
import { revisionCount } from "@/modules/contracts/revisions";

export const dynamic = "force-dynamic";

/** ویرایش پیش‌نویس؛ پس از انتشار، نسخه‌ی نهایی تغییرناپذیر است */
export default async function EditDraftPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ approval?: string; approval_error?: string }> }) {
  const admin = await requireTeam("write");
  const id = Number((await params).id);
  const sp = await searchParams;
  if (!Number.isInteger(id)) notFound();
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, admin.workspaceId)));
  if (!c) notFound();
  if (c.status !== "draft") redirect(`/contracts/${id}`);
  return (
    <Shell user={admin} wide>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-black">ویرایش پیش‌نویس</h1>
        <StatusBadge status="draft" />
        <span dir="ltr" className="font-mono text-xs text-ink/72">{c.number}</span>
      </div>
      <p className="mb-4 text-xs leading-7 text-ink/75">این قرارداد هنوز برای کسی ارسال نشده و مشتری آن را نمی‌بیند. پس از «انتشار نسخه نهایی»، متن قفل و ارسال آغاز می‌شود.</p>
      <div className="mb-4 flex flex-wrap gap-2">
        <Link href={`/admin/contracts/${c.id}/history`} className="btn-secondary btn-sm"><GitCompareArrows size={14} />تاریخچه و مقایسه‌ی نسخه‌ها ({(await revisionCount(c.id)).toLocaleString("fa-IR")})</Link>
      </div>
      <DraftForm id={c.id} title={c.title} body={c.bodyHtml} />
      <div className="mt-6 space-y-5">
        <ApprovalPanel contractId={c.id} returnTo={`/admin/contracts/${c.id}/edit`} rows={await listApprovals(c.id)} candidates={await approverCandidates(c.workspaceId)} meId={admin.id} canWrite isDraft flash={sp.approval} error={sp.approval_error} />
        <NegotiationPanel comments={toPanelComments(await listComments(c.id, { includeInternal: true }))} mode={{ kind: "user", contractId: c.id, isTeam: true, canResolve: true, draft: true }} articleId="body-editor" />
      </div>
    </Shell>
  );
}
