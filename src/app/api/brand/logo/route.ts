import { NextResponse } from "next/server";
import { getSetting } from "@/modules/settings/service";
import { readLogoFile } from "@/modules/branding/service";

export const dynamic = "force-dynamic";

/** لوگوی برند (عمومی، چون در صفحه‌ی ورود هم نمایش داده می‌شود) */
export async function GET(req: Request) {
  const ws = Number(new URL(req.url).searchParams.get("ws"));
  const name = Number.isInteger(ws) && ws > 0 ? await getSetting("brand_logo_file", ws).catch(() => "") : "";
  const logo = name ? await readLogoFile(name) : null;
  if (!logo) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(logo.data), {
    headers: {
      "Content-Type": logo.mime,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
