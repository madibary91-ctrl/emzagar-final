import { NextResponse } from "next/server";
import { ifRangeAllows, parseByteRange } from "@/lib/http-range";
import { pdfDisposition } from "@/lib/pdf-disposition";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { openContractPdf, PdfTamperedError } from "@/modules/pdf/service";
import { hasGuestSession, resolveSigningToken } from "@/modules/signing/links";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** دریافت PDF نهایی توسط امضاکننده‌ی بدون حساب (فقط با لینک اختصاصی + نشست OTP همین مرورگر) */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = clientIpFrom((n) => req.headers.get(n));
  if (!rateLimit(`gpdf:${ip}`, 60, 15 * 60_000).ok) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  const st = await resolveSigningToken(token);
  if (st.status !== "done") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { link, signer, contract } = st.ctx;
  if (contract.status !== "signed" || !(await hasGuestSession(link.id, signer.id))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const pdf = await openContractPdf(contract.id);
    const etag = `"${pdf.sha256}"`;
    const base = {
      "Content-Type": "application/pdf",
      "Content-Disposition": pdfDisposition(req.url, `${contract.number}.pdf`),
      "X-Document-SHA256": pdf.sha256,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      // ادامه‌ی دانلود: اگر اتصال موبایل وسط دریافت قطع شد، مرورگر/دانلودمنیجر از همان بایت ادامه می‌دهد (بدون OTP دوباره در نشست ۳۰ دقیقه‌ای)
      "Accept-Ranges": "bytes",
      ETag: etag,
    };
    const range = ifRangeAllows(req.headers.get("if-range"), etag) ? parseByteRange(req.headers.get("range"), pdf.size) : null;
    if (range === "unsatisfiable") return new NextResponse(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${pdf.size}` } });
    if (range) {
      return new NextResponse(pdf.stream({ start: range.start, end: range.end }), {
        status: 206,
        headers: { ...base, "Content-Range": `bytes ${range.start}-${range.end}/${pdf.size}`, "Content-Length": String(range.end - range.start + 1) },
      });
    }
    return new NextResponse(pdf.stream(), { headers: { ...base, "Content-Length": String(pdf.size) } });
  } catch (e) {
    if (e instanceof PdfTamperedError) return NextResponse.json({ error: "integrity_check_failed" }, { status: 409 });
    console.error("[pdf:guest]", e);
    return NextResponse.json({ error: "pdf_failed" }, { status: 500 });
  }
}
