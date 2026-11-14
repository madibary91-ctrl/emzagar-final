import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { accessKey, buildSubmissionPdf, getSubmissionByReceipt } from "@/modules/collect/service";
import { fileResponse } from "@/modules/docs/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** نسخه‌ی PDF خود امضاکننده: فقط با «کلید دسترسی» که هنگام ثبت به همان فرد داده شده است */
export async function GET(req: Request, { params }: { params: Promise<{ receipt: string }> }) {
  const ip = clientIpFrom((n) => req.headers.get(n));
  if (!rateLimit(`colpdf:${ip}`, 30, 15 * 60_000).ok) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  const { receipt } = await params;
  const k = new URL(req.url).searchParams.get("k") ?? "";
  const s = await getSubmissionByReceipt(receipt);
  const want = accessKey(receipt);
  if (!s || k.length !== want.length || !timingSafeEqual(Buffer.from(k), Buffer.from(want)) || s.voidedAt) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    return fileResponse(await buildSubmissionPdf(s), { filename: `signature-${s.receipt}.pdf` });
  } catch (e) {
    console.error("[collect:pdf]", e);
    return NextResponse.json({ error: "pdf_failed" }, { status: 500 });
  }
}
