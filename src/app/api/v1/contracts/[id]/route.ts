import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts } from "@/db/schema";
import { authenticateApi, requestOrigin } from "@/modules/api/service";
import { getSigners } from "@/modules/contracts/service";
import { getLinkForContract, shortUrl } from "@/modules/links/service";

export const dynamic = "force-dynamic";

/** وضعیت قرارداد و امضاکنندگان (بدون اطلاعات تماس) */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApi(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, auth.workspaceId)));
  if (!c) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const signers = await getSigners(id);
  const link = await getLinkForContract(id);
  return NextResponse.json({
    ok: true,
    id: c.id,
    number: c.number,
    title: c.title,
    status: c.status,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
    signedAt: c.signedAt,
    docHash: c.docHash,
    shortUrl: link ? await shortUrl(link.code, requestOrigin(req)) : null,
    signers: signers.map((s) => ({ position: s.position, label: s.label, status: s.status, signedAt: s.signedAt })),
  });
}
