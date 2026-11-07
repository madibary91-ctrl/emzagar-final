import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { getContractPdf, PdfTamperedError } from "@/modules/pdf/service";
import { hasGuestSession, resolveSigningToken } from "@/modules/signing/links";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** دریافت PDF نهایی توسط امضاکننده‌ی بدون حساب (فقط با لینک اختصاصی + نشست OTP همین مرورگر) */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = clientIpFrom((n) => req.headers.get(n));
  if (!rateLimit(`gpdf:${ip}`, 30, 15 * 60_000).ok) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  const st = await resolveSigningToken(token);
  if (st.status !== "done") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { link, signer, contract } = st.ctx;
  if (contract.status !== "signed" || !(await hasGuestSession(link.id, signer.id))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const pdf = await getContractPdf(contract.id);
    return new NextResponse(new Uint8Array(pdf.buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${contract.number}.pdf"`,
        "Content-Length": String(pdf.size),
        "X-Document-SHA256": pdf.sha256,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (e) {
    if (e instanceof PdfTamperedError) return NextResponse.json({ error: "integrity_check_failed" }, { status: 409 });
    console.error("[pdf:guest]", e);
    return NextResponse.json({ error: "pdf_failed" }, { status: 500 });
  }
}
