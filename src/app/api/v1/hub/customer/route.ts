import { NextResponse } from "next/server";
import { authenticateApi } from "@/modules/api/service";
import { customerCard } from "@/modules/hub/service";

export const dynamic = "force-dynamic";

/** کارت ۳۶۰ درجه‌ی مشتری (قراردادها، ارزش، سفارش‌ها) برای پروفایل کاربر و صفحه‌ی سفارش در وردپرس */
export async function GET(req: Request) {
  const auth = await authenticateApi(req, { bucket: "hub-customer", limit: 120 });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const email = new URL(req.url).searchParams.get("email") ?? "";
  const card = await customerCard(auth.workspaceId, email);
  if (!card) return NextResponse.json({ ok: false, error: "email_invalid" }, { status: 422 });
  return NextResponse.json({ ok: true, customer: card }, { headers: { "Cache-Control": "no-store" } });
}
