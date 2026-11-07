import { NextResponse } from "next/server";
import { authenticateApi } from "@/modules/api/service";
import { cancelContract } from "@/modules/contracts/service";
import { logAudit } from "@/modules/audit/service";

export const dynamic = "force-dynamic";

/** لغو قرارداد در انتظار امضا از داخل وردپرس. بدنه‌ی اختیاری: { reason } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApi(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
  const reason = typeof body?.reason === "string" ? body.reason.slice(0, 200) : "";
  try {
    await cancelContract(id, 0, reason ? `${reason} (از وردپرس)` : "لغو از وردپرس", auth.workspaceId);
  } catch {
    return NextResponse.json({ ok: false, error: "not_cancellable" }, { status: 409 });
  }
  await logAudit({ action: "api.contract_cancelled", workspaceId: auth.workspaceId, contractId: id, detail: `کلید #${auth.keyId}`, actor: "api" });
  return NextResponse.json({ ok: true });
}
