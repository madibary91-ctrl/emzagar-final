import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts } from "@/db/schema";
import { authenticateApi } from "@/modules/api/service";
import { getContractPdf, PdfTamperedError } from "@/modules/pdf/service";
import { logAudit } from "@/modules/audit/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PDF رسمی قرارداد امضاشده برای دانلود مستقیم از پیشخوان وردپرس (وردپرس آن را به مدیر سایت پراکسی می‌کند) */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApi(req, { bucket: "hub-pdf", limit: 40 });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  const [c] = await db.select({ id: contracts.id, number: contracts.number, status: contracts.status }).from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, auth.workspaceId)));
  if (!c) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (c.status !== "signed") return NextResponse.json({ ok: false, error: "not_signed_yet" }, { status: 409 });
  try {
    const pdf = await getContractPdf(c.id);
    await logAudit({ action: "document.downloaded", workspaceId: auth.workspaceId, contractId: c.id, detail: `وردپرس — SHA-256: ${pdf.sha256.slice(0, 16)}…`, actor: "api" });
    return new NextResponse(new Uint8Array(pdf.buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${c.number.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf"`,
        "Content-Length": String(pdf.size),
        "X-Document-SHA256": pdf.sha256,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof PdfTamperedError) return NextResponse.json({ ok: false, error: "integrity_check_failed" }, { status: 409 });
    console.error("[api:v1:pdf]", e);
    return NextResponse.json({ ok: false, error: "pdf_failed" }, { status: 500 });
  }
}
