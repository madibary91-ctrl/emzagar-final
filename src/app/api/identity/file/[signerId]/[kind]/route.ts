import { NextResponse } from "next/server";
import { getTeamForApi } from "@/modules/tenancy/context";
import { readDocument } from "@/modules/identity/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** نمایش مدرک هویتی رمزگشایی‌شده؛ فقط اعضای تیم «همان فضای کاری» با دسترسی نوشتن (برای بررسی) */
export async function GET(_req: Request, ctx: { params: Promise<{ signerId: string; kind: string }> }) {
  const team = await getTeamForApi("write");
  if (!team) return new NextResponse("Unauthorized", { status: 401 });
  const { signerId, kind } = await ctx.params;
  if (kind !== "id" && kind !== "selfie") return new NextResponse("Not found", { status: 404 });
  const file = await readDocument(Number(signerId), team.workspaceId, kind);
  if (!file) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(file.buffer), {
    headers: {
      "Content-Type": file.mime,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; sandbox",
      "Content-Disposition": "inline",
    },
  });
}
