import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/modules/auth/session";
import { getContractForUser } from "@/modules/contracts/service";
import { logAudit } from "@/modules/audit/service";
import { buildAmendmentPdfInput } from "@/modules/amendments/service";
import { renderContractPdf } from "@/modules/pdf/render";
import { sha256Buf } from "@/modules/pdf/hash";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PDF رسمی الحاقیه‌ی تأییدشده (روی سرور تولید می‌شود؛ SHA-256 در هدر پاسخ است) */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; seq: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, seq } = await params;
  const data = await getContractForUser(user, Number(id));
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!rateLimit(`amend-pdf:${user.id}`, 30, 15 * 60_000).ok) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  const built = await buildAmendmentPdfInput(data.contract.id, Number(seq));
  if (!built) return NextResponse.json({ error: "not_ready" }, { status: 404 });
  const buffer = await renderContractPdf(built.input);
  await logAudit({ action: "document.downloaded", contractId: data.contract.id, userId: user.id, detail: `PDF الحاقیه ${built.amendment.seq}` });
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${data.contract.number}-A${built.amendment.seq}.pdf"`,
      "Content-Length": String(buffer.length),
      "X-Document-SHA256": sha256Buf(buffer),
      "X-Amendment-Fingerprint": built.amendment.docHash ?? "",
      "Cache-Control": "private, no-store",
    },
  });
}
