import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { sniffImage } from "@/modules/branding/service";
import { getPlatformAdminForApi } from "@/modules/platform/admin";
import { saveLandingImage } from "@/modules/landing/service";

export const dynamic = "force-dynamic";

const MAX = 1_500_000;

/** بارگذاری تصویر صفحه‌ی اصلی: فقط مدیر کل، همان‌مبدأ، با اعتبارسنجی بر اساس محتوای فایل (نه پسوند) */
export async function POST(req: Request) {
  const admin = await getPlatformAdminForApi();
  if (!admin) return NextResponse.json({ ok: false, error: "دسترسی ندارید" }, { status: 403 });
  // محافظت CSRF: درخواست باید از همین سایت بیاید
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin) {
    try {
      if (new URL(origin).host !== host) return NextResponse.json({ ok: false, error: "درخواست نامعتبر" }, { status: 403 });
    } catch {
      return NextResponse.json({ ok: false, error: "درخواست نامعتبر" }, { status: 403 });
    }
  }
  if (!rateLimit(`landing:upload:${admin.id}`, 40, 60_000).ok) return NextResponse.json({ ok: false, error: "آپلود بیش از حد؛ کمی بعد دوباره تلاش کنید" }, { status: 429 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ ok: false, error: "فایلی انتخاب نشده است" }, { status: 400 });
  if (file.size > MAX) return NextResponse.json({ ok: false, error: "حجم تصویر باید کمتر از ۱٫۵ مگابایت باشد" }, { status: 413 });
  const buf = Buffer.from(await file.arrayBuffer());
  const kind = sniffImage(buf);
  if (!kind) return NextResponse.json({ ok: false, error: "فقط تصویر PNG، JPG یا WebP مجاز است" }, { status: 415 });
  const name = await saveLandingImage(buf, kind as "png" | "jpg" | "webp", crypto.randomBytes(4).toString("hex"));
  return NextResponse.json({ ok: true, url: `/api/landing/image/${name}` });
}
