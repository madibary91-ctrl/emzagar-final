import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/modules/auth/session";
import { getContractForUser } from "@/modules/contracts/service";
import { can } from "@/modules/tenancy/roles";
import { logAudit } from "@/modules/audit/service";
import { AttachmentTamperedError, deleteAttachment, downloadHeaders, getAttachmentRow, readAttachment } from "@/modules/attachments/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; aid: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, aid } = await params;
  const data = await getContractForUser(user, Number(id));
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!rateLimit(`attach-dl:${user.id}`, 120, 15 * 60_000).ok) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  try {
    const f = await readAttachment(data.contract.id, Number(aid));
    if (!f) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await logAudit({ action: "attachment.downloaded", contractId: data.contract.id, userId: user.id, detail: f.row.originalName });
    return new NextResponse(new Uint8Array(f.buffer), { headers: downloadHeaders(f.row) });
  } catch (e) {
    if (e instanceof AttachmentTamperedError) return NextResponse.json({ error: "integrity_check_failed" }, { status: 409 });
    throw e;
  }
}

/** حذف: تیم (دسترسی نوشتن) یا خود بارگذارنده، تا پیش از نهایی‌شدن قرارداد */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; aid: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, aid } = await params;
  const data = await getContractForUser(user, Number(id));
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const row = await getAttachmentRow(data.contract.id, Number(aid));
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const isOwner = row.uploadedBy === user.id;
  if (!(isOwner || (data.teamRole && can(data.teamRole, "write")))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const r = await deleteAttachment(data.contract.id, Number(aid), user.id);
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
