import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { kycDocuments, kycSubmissions } from "@/db/schema";
import { getCurrentUser } from "@/modules/auth/session";
import { logAudit } from "@/modules/audit/service";
import { isPlatformAdmin } from "@/modules/platform/admin";
import { getMemberships } from "@/modules/tenancy/context";
import { can, isTeamRole, type TeamRole } from "@/modules/tenancy/roles";
import { readKycDocument } from "@/modules/kyc/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const deny = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });

/**
 * نمایش مدرک هویتی: فقط مدیر کل پلتفرم یا مالک/مدیر همان فضای کاری.
 * هر مشاهده توسط مدیر کل در لاگ ثبت می‌شود؛ پاسخ هرگز کش نمی‌شود.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return deny(401);
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return deny(404);
  const [meta] = await db
    .select({ workspaceId: kycSubmissions.workspaceId })
    .from(kycDocuments)
    .innerJoin(kycSubmissions, eq(kycSubmissions.id, kycDocuments.submissionId))
    .where(and(eq(kycDocuments.id, id)));
  if (!meta) return deny(404);
  const platform = isPlatformAdmin(user);
  if (!platform) {
    const m = (await getMemberships(user.id)).find((x) => x.workspaceId === meta.workspaceId);
    if (!m || !isTeamRole(m.role) || !can(m.role as TeamRole, "settings")) return deny(404);
  }
  const res = await readKycDocument(id);
  if (!res) return deny(404);
  if (platform) await logAudit({ action: "kyc.doc_viewed", workspaceId: meta.workspaceId, userId: user.id, detail: `مدرک #${id}` });
  return new Response(new Uint8Array(res.buffer), {
    headers: {
      "Content-Type": res.doc.mime,
      "Content-Disposition": `inline; filename="kyc-${id}.${res.doc.mime === "application/pdf" ? "pdf" : res.doc.mime.split("/")[1]}"`,
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      "X-Robots-Tag": "noindex",
    },
  });
}
