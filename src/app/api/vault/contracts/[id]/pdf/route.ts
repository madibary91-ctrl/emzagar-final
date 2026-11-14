import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { PdfTamperedError } from "@/modules/pdf/service";
import { readVaultSession } from "@/modules/vault/session";
import { vaultPdf } from "@/modules/vault/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** دریافت PDF رسمی یک سند نهایی‌شده از کیف اسناد (فقط نشست کیف همان موبایل) */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ip = clientIpFrom((n) => req.headers.get(n));
  if (!rateLimit(`vaultpdf:${ip}`, 60, 15 * 60_000).ok) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  const mobile = await readVaultSession();
  if (!mobile) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const r = await vaultPdf(mobile, Number(id));
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(new Uint8Array(r.pdf.buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${r.contract.number}.pdf"`,
        "Content-Length": String(r.pdf.size),
        "X-Document-SHA256": r.pdf.sha256,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (e) {
    if (e instanceof PdfTamperedError) return NextResponse.json({ error: "integrity_check_failed" }, { status: 409 });
    console.error("[vault:pdf]", e);
    return NextResponse.json({ error: "pdf_failed" }, { status: 500 });
  }
}
