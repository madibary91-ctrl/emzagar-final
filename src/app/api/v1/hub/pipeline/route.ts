import { NextResponse } from "next/server";
import { authenticateApi } from "@/modules/api/service";
import { getPipeline } from "@/modules/hub/workspace";

export const dynamic = "force-dynamic";

/** قیف زنده‌ی قراردادها (ستون‌های کانبان) برای «میز کار» داخل وردپرس */
export async function GET(req: Request) {
  const auth = await authenticateApi(req, { bucket: "hub-pipeline", limit: 120 });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const per = Number(new URL(req.url).searchParams.get("per")) || 8;
  const pipeline = await getPipeline(auth.workspaceId, per);
  return NextResponse.json({ ok: true, ...pipeline }, { headers: { "Cache-Control": "no-store" } });
}
