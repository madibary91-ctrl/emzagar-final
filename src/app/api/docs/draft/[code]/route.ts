import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { getDraft, readSourceFile } from "@/modules/docs/service";
import { fileResponse } from "@/modules/docs/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PDF کاری یک فایل بارگذاری‌شده (برای ویرایشگر جانمایی)؛ کد ۱۲۸ بیتی خودش مجوز دسترسی است */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const ip = clientIpFrom((n) => req.headers.get(n));
  if (!rateLimit(`docdraft:${ip}`, 120, 15 * 60_000).ok) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  const { code } = await params;
  const d = await getDraft(code);
  if (!d || d.consumedAt) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    return fileResponse(await readSourceFile(d.pdfFile, d.pdfSha256), { filename: "document.pdf", inline: true });
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
}
