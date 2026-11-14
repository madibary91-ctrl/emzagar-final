import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { getCampaignByCode, publicBase } from "@/modules/collect/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** تصویر PNG کد QR فرم عمومی (برای چاپ روی پوستر، کارت ویزیت یا بنر) */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const c = await getCampaignByCode(code);
  if (!c) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const png = await QRCode.toBuffer(`${await publicBase(c.workspaceId)}/c/${c.code}`, { type: "png", margin: 2, width: 900, errorCorrectionLevel: "H" });
  return new NextResponse(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Content-Disposition": `inline; filename="qr-${c.code}.png"`, "Cache-Control": "public, max-age=3600" } });
}
