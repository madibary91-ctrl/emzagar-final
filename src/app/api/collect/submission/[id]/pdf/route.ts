import { NextResponse } from "next/server";
import { getTeamForApi } from "@/modules/tenancy/context";
import { buildSubmissionPdf, getSubmissionById } from "@/modules/collect/service";
import { fileResponse } from "@/modules/docs/http";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const team = await getTeamForApi("view");
  if (!team) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const s = await getSubmissionById(Number(id), team.workspaceId);
  if (!s) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!rateLimit(`colsubpdf:${team.id}`, 120, 15 * 60_000).ok) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  try {
    return fileResponse(await buildSubmissionPdf(s), { filename: `signature-${s.receipt}.pdf` });
  } catch (e) {
    console.error("[collect:admin-pdf]", e);
    return NextResponse.json({ error: "pdf_failed" }, { status: 500 });
  }
}
