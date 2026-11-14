import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { MAX_FILE_BYTES } from "@/lib/spreadsheet";
import { getTeamForApi } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { createBatchFromFile, MergeError } from "@/modules/merge/service";

export const dynamic = "force-dynamic";

/** بارگذاری فایل اکسل/CSV (multipart). فقط اعضای تیم با دسترسی نوشتن. */
export async function POST(req: Request) {
  const team = await getTeamForApi("write");
  if (!team || !can(team.wsRole, "write")) return NextResponse.json({ error: "دسترسی ندارید" }, { status: 401 });
  const ip = clientIpFrom((n) => req.headers.get(n));
  if (!rateLimit(`merge:upload:${team.id}`, 20, 60 * 60_000).ok || !rateLimit(`merge:upload:ip:${ip}`, 40, 60 * 60_000).ok) return NextResponse.json({ error: "تعداد بارگذاری زیاد بود؛ کمی بعد دوباره تلاش کنید" }, { status: 429 });
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_FILE_BYTES + 64 * 1024) return NextResponse.json({ error: "حجم فایل بیش از ۵ مگابایت است" }, { status: 413 });
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "فایل انتخاب نشده است" }, { status: 400 });
    if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: "حجم فایل بیش از ۵ مگابایت است" }, { status: 413 });
    const id = await createBatchFromFile(team, { templateId: Number(form.get("templateId")), title: String(form.get("title") ?? ""), fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    if (e instanceof MergeError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[merge:upload]", e);
    return NextResponse.json({ error: "بارگذاری انجام نشد" }, { status: 500 });
  }
}
