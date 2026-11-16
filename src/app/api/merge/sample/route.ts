import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { templates } from "@/db/schema";
import { toCsv } from "@/lib/csv-out";
import { getTeamForApi } from "@/modules/tenancy/context";
import { detectPlaceholders } from "@/modules/merge/pure";

export const dynamic = "force-dynamic";

/** فایل نمونه‌ی CSV متناسب با متغیرهای قالب (سرستون‌ها از خود قالب ساخته می‌شود) */
export async function GET(req: Request) {
  const team = await getTeamForApi("view");
  if (!team) return new Response("unauthorized", { status: 401 });
  const tid = Number(new URL(req.url).searchParams.get("templateId"));
  const [tpl] = tid ? await db.select().from(templates).where(and(eq(templates.id, tid), eq(templates.workspaceId, team.workspaceId))) : [];
  const custom = tpl ? detectPlaceholders(tpl.body, tpl.title).filter((p) => !["USER_NAME", "USER_MOBILE", "AMOUNT"].includes(p.key)).map((p) => p.key) : [];
  const headers = ["نام و نام خانوادگی", "موبایل", "مبلغ", ...custom];
  const sample = ["علی رضایی", "09123456789", "12000000", ...custom.map((k) => `نمونه ${k}`)];
  const sample2 = ["مریم احمدی", "09351234567", "8000000", ...custom.map((k) => `نمونه ${k}`)];
  return new Response(toCsv([headers, sample, sample2]), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="merge-sample.csv"', "Cache-Control": "private, no-store" } });
}
