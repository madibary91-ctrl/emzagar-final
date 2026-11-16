import { NextResponse } from "next/server";
import { authenticateApi } from "@/modules/api/service";
import { searchHub } from "@/modules/hub/workspace";

export const dynamic = "force-dynamic";

/** جستجوی یکپارچه‌ی قرارداد/مشتری/قالب برای پالت فرمان (Ctrl+K) وردپرس */
export async function GET(req: Request) {
  const auth = await authenticateApi(req, { bucket: "hub-search", limit: 240 });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const res = await searchHub(auth.workspaceId, q);
  return NextResponse.json({ ok: true, ...res }, { headers: { "Cache-Control": "no-store" } });
}
