import { NextResponse } from "next/server";
import { authenticateApi } from "@/modules/api/service";
import { remindContractNow } from "@/modules/automation/service";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** ارسال یادآوری امضا به نفر بعدی (دکمه‌ی «یادآوری» در سفارش ووکامرس). حداکثر ۳ بار در ساعت برای هر قرارداد. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApi(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  const rl = rateLimit(`api:remind:${auth.workspaceId}:${id}`, 3, 3600_000);
  if (!rl.ok) return NextResponse.json({ ok: false, error: "rate_limited", retryAfter: rl.retryAfter }, { status: 429 });
  const sent = await remindContractNow(id, 0, auth.workspaceId);
  if (!sent) return NextResponse.json({ ok: false, error: "not_remindable" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
