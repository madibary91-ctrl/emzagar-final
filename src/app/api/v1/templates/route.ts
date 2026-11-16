import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { templates } from "@/db/schema";
import { authenticateApi } from "@/modules/api/service";

export const dynamic = "force-dynamic";

/** فهرست قالب‌های فضای کاری (بدون متن کامل) — برای انتخاب قالب در افزونه‌ی وردپرس */
export async function GET(req: Request) {
  const auth = await authenticateApi(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const rows = await db
    .select({ id: templates.id, title: templates.title, description: templates.description })
    .from(templates)
    .where(eq(templates.workspaceId, auth.workspaceId))
    .orderBy(asc(templates.title));
  return NextResponse.json({ ok: true, items: rows }, { headers: { "Cache-Control": "no-store" } });
}
