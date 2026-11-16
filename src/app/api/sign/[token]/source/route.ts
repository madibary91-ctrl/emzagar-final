import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { getSource, readSourceFile } from "@/modules/docs/service";
import { fileResponse } from "@/modules/docs/http";
import { hasGuestSession, resolveSigningToken } from "@/modules/signing/links";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** فایل قرارداد برای نمایش در صفحه‌ی امضا؛ فقط لینک اختصاصی + نشست OTP همین مرورگر (مثل متن قرارداد) */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = clientIpFrom((n) => req.headers.get(n));
  if (!rateLimit(`gsrc:${ip}`, 120, 15 * 60_000).ok) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  const st = await resolveSigningToken(token);
  if (st.status !== "ok") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { link, signer, contract } = st.ctx;
  if (!(await hasGuestSession(link.id, signer.id))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const src = await getSource(contract.id);
  if (!src) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    return fileResponse(await readSourceFile(src.pdfFile, src.pdfSha256), { filename: `${contract.number}.pdf`, inline: true });
  } catch {
    return NextResponse.json({ error: "integrity_check_failed" }, { status: 409 });
  }
}
