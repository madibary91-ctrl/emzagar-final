import { NextResponse } from "next/server";
import { authenticateApi } from "@/modules/api/service";
import { checkAccess } from "@/modules/hub/service";

export const dynamic = "force-dynamic";

/**
 * دروازه‌ی دسترسی بر پایه‌ی قرارداد: «آیا این ایمیل قرارداد امضاشده‌ی معتبر دارد؟»
 * بدنه: { email, templateIds?: number[] }   —  templateIds خالی = هر قرارداد امضاشده
 */
export async function POST(req: Request) {
  const auth = await authenticateApi(req, { bucket: "hub-access", limit: 240 });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => null)) as { email?: unknown; templateIds?: unknown } | null;
  if (!body || typeof body !== "object") return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  const ids = Array.isArray(body.templateIds) ? body.templateIds.map((n) => Number(n)) : [];
  const res = await checkAccess(auth.workspaceId, String(body.email ?? ""), ids);
  return NextResponse.json({ ok: true, ...res }, { headers: { "Cache-Control": "no-store" } });
}
