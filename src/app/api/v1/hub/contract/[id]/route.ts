import { NextResponse } from "next/server";
import { authenticateApi } from "@/modules/api/service";
import { getContractDetail } from "@/modules/hub/workspace";

export const dynamic = "force-dynamic";

/** جزئیات کامل قرارداد + خط زمانی + لینک امضا برای کشوی جزئیات در وردپرس */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApi(req, { bucket: "hub-contract", limit: 180 });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  const detail = await getContractDetail(auth.workspaceId, id);
  if (!detail) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, contract: detail }, { headers: { "Cache-Control": "no-store" } });
}
