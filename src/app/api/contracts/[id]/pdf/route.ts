import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/modules/auth/session";
import { getContractForUser } from "@/modules/contracts/service";
import { logAudit } from "@/modules/audit/service";
import { getContractPdf, PdfTamperedError } from "@/modules/pdf/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PDF رسمی قرارداد امضاشده (ساخته‌شده روی سرور). فقط تیم، مشتری و امضاکنندگان همان قرارداد. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const data = await getContractForUser(user, Number(id));
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (data.contract.status !== "signed") return NextResponse.json({ error: "not_signed_yet" }, { status: 409 });
  if (!rateLimit(`pdf:${user.id}`, 60, 15 * 60_000).ok) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  try {
    const pdf = await getContractPdf(data.contract.id);
    await logAudit({ action: "document.downloaded", contractId: data.contract.id, userId: user.id, detail: `SHA-256: ${pdf.sha256.slice(0, 16)}…` });
    return new NextResponse(new Uint8Array(pdf.buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${data.contract.number}.pdf"`,
        "Content-Length": String(pdf.size),
        "X-Document-SHA256": pdf.sha256,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof PdfTamperedError) return NextResponse.json({ error: "integrity_check_failed", message: "یکپارچگی فایل تأیید نشد؛ با پشتیبانی تماس بگیرید." }, { status: 409 });
    console.error("[pdf:download]", e);
    return NextResponse.json({ error: "pdf_failed" }, { status: 500 });
  }
}
