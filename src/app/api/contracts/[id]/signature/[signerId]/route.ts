import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contractSigners } from "@/db/schema";
import { getCurrentUser } from "@/modules/auth/session";
import { getContractForUser } from "@/modules/contracts/service";
import { readSignatureFile } from "@/modules/signing/storage";

export const dynamic = "force-dynamic";

/** دریافت امضا از پوشه‌ی محافظت‌شده؛ فقط برای مدیر و طرفین همان قرارداد */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; signerId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const { id, signerId } = await ctx.params;
  const data = await getContractForUser(user, Number(id));
  if (!data) return new NextResponse("Not found", { status: 404 });

  const [signer] = await db.select().from(contractSigners).where(eq(contractSigners.id, Number(signerId)));
  if (!signer || signer.contractId !== data.contract.id || !signer.signatureFile) {
    return new NextResponse("Not found", { status: 404 });
  }
  const file = await readSignatureFile(signer.signatureFile);
  if (!file) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(file), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
