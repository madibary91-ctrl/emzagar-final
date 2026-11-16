import { NextResponse } from "next/server";
import { readLandingImage } from "@/modules/landing/service";

export const dynamic = "force-dynamic";

/** تصاویر صفحه‌ی اصلی (عمومی). نام فایل یکتاست و تغییر نمی‌کند؛ پس کش طولانی امن است. */
export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const img = await readLandingImage(name);
  if (!img) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(img.data), {
    headers: {
      "Content-Type": img.mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
