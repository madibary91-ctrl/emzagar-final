import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { acceptingState, getCampaignByCode, readCampaignDoc } from "@/modules/collect/service";
import { fileResponse } from "@/modules/docs/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** فایل مبنای فرم عمومی (برای نمایش به امضاکنندگان؛ فقط تا وقتی فرم باز است) */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const ip = clientIpFrom((n) => req.headers.get(n));
  if (!rateLimit(`coldoc:${ip}`, 120, 15 * 60_000).ok) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  const { code } = await params;
  const c = await getCampaignByCode(code);
  if (!c || !c.docFile || !(await acceptingState(c)).open) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const buf = await readCampaignDoc(c);
    return buf ? fileResponse(buf, { filename: "document.pdf", inline: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "integrity_check_failed" }, { status: 409 });
  }
}
