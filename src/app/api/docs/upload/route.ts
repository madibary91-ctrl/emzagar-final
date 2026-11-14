import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";
import { getTeamForApi } from "@/modules/tenancy/context";
import { createDraft, DocError, MAX_UPLOAD_BYTES } from "@/modules/docs/service";
import { isQuickEnabled } from "@/modules/quick/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * بارگذاری فایل PDF/Word برای امضا روی خودِ فایل.
 *  mode=team  ← کاربر واردشده با دسترسی نوشتن (فضای کاری خودش)
 *  mode=quick ← ارسال سریع بدون حساب (سقف نرخ سخت‌گیرانه‌تر؛ فایل ۲۴ ساعته پاک می‌شود)
 */
export async function POST(req: Request) {
  const ip = clientIpFrom((n) => req.headers.get(n));
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "درخواست نامعتبر است" }, { status: 400 });
  }
  const file = form.get("file");
  const mode = String(form.get("mode") || "team");
  if (!(file instanceof File)) return NextResponse.json({ error: "فایلی انتخاب نشده است" }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "حجم فایل بیشتر از ۱۲ مگابایت است" }, { status: 413 });

  let workspaceId: number | null = null;
  let userId: number | null = null;
  if (mode === "quick") {
    if (!(await isQuickEnabled())) return NextResponse.json({ error: "ارسال سریع غیرفعال است" }, { status: 403 });
    if (!rateLimit(`docup:quick:${ip}`, 8, 60 * 60_000).ok) return NextResponse.json({ error: "تعداد بارگذاری زیاد بود؛ کمی بعد دوباره تلاش کنید" }, { status: 429 });
  } else {
    const team = await getTeamForApi("write");
    if (!team) return NextResponse.json({ error: "برای بارگذاری باید وارد شوید" }, { status: 401 });
    if (!rateLimit(`docup:user:${team.id}`, 60, 60 * 60_000).ok) return NextResponse.json({ error: "تعداد بارگذاری زیاد بود" }, { status: 429 });
    workspaceId = team.workspaceId;
    userId = team.id;
  }
  try {
    const d = await createDraft({ buf: Buffer.from(await file.arrayBuffer()), name: file.name, workspaceId, userId, ip });
    return NextResponse.json({ code: d.code, kind: d.kind, name: d.originalName, pageCount: d.pageCount, pages: d.pagesMeta, warnings: d.warnings });
  } catch (e) {
    if (e instanceof DocError) return NextResponse.json({ error: e.message, code: e.code }, { status: 422 });
    console.error("[docs:upload]", e);
    return NextResponse.json({ error: "پردازش فایل ناموفق بود" }, { status: 500 });
  }
}
