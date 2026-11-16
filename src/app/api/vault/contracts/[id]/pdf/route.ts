import { NextResponse } from "next/server";
import { pdfDisposition } from "@/lib/pdf-disposition";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { PdfTamperedError } from "@/modules/pdf/service";
import { vaultFail } from "@/modules/vault/http";
import { readVaultSession } from "@/modules/vault/session";
import { vaultPdf } from "@/modules/vault/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** دریافت PDF رسمی یک سند نهایی‌شده از کیف اسناد (فقط نشست کیف همان موبایل) */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ip = clientIpFrom((n) => req.headers.get(n));
  if (!rateLimit(`vaultpdf:${ip}`, 60, 15 * 60_000).ok) return vaultFail(req, "rate", 429, "too_many_requests");
  const mobile = await readVaultSession();
  if (!mobile) return vaultFail(req, "auth", 401, "unauthorized");
  try {
    const r = await vaultPdf(mobile, Number(id));
    if (!r) return vaultFail(req, "nodoc", 404, "not_found");
    return new NextResponse(new Uint8Array(r.pdf.buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": pdfDisposition(req.url, `${r.contract.number}.pdf`),
        "Content-Length": String(r.pdf.size),
        "X-Document-SHA256": r.pdf.sha256,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (e) {
    if (e instanceof PdfTamperedError) return vaultFail(req, "tampered", 409, "integrity_check_failed");
    console.error("[vault:pdf]", e);
    return vaultFail(req, "pdf", 500, "pdf_failed");
  }
}
