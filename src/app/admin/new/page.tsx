import Shell from "@/components/Shell";
import IssueForm from "@/components/IssueForm";
import { db } from "@/db";
import { templates } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { listWorkspaceUsers } from "@/modules/tenancy/service";
import { requireTeam } from "@/modules/tenancy/context";
import { getKycState, getKycThreshold } from "@/modules/kyc/service";
import { isGuestEmail } from "@/modules/guests/service";
import { sanitizeHtml } from "@/lib/html";
import { fillPlaceholders, getLibraryTemplate } from "@/modules/library";
import Link from "next/link";
import { shahkarAvailable } from "@/modules/identity/provider";

export const dynamic = "force-dynamic";

/** مقدارهای جاهای خالی که ویزارد کتابخانه در آدرس می‌فرستد (base64url از JSON) */
function decodeValues(p: string | undefined): Record<string, string> {
  if (!p || p.length > 6000) return {};
  try {
    const obj = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as unknown;
    if (!obj || typeof obj !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) if (/^[a-z][a-z0-9_]{0,31}$/.test(k) && typeof v === "string") out[k] = v.slice(0, 300);
    return out;
  } catch {
    return {};
  }
}

export default async function NewContractPage({ searchParams }: { searchParams: Promise<{ customer?: string; lib?: string; p?: string }> }) {
  const { customer, lib, p } = await searchParams;
  const admin = await requireTeam("write");
  const [kycThreshold, kycState, identityAvailable] = await Promise.all([getKycThreshold(), getKycState(admin.workspaceId), shahkarAvailable()]);
  const [tpls, allUsers] = await Promise.all([
    db.select({ id: templates.id, title: templates.title, body: templates.body }).from(templates).where(eq(templates.workspaceId, admin.workspaceId)).orderBy(asc(templates.title)),
    listWorkspaceUsers(admin.workspaceId),
  ]);
  // شروع از کتابخانه‌ی قالب‌های آماده: متن با مقدارهای واردشده پر و پاکسازی می‌شود
  const libTpl = getLibraryTemplate(lib);
  const initial = libTpl
    ? { title: libTpl.title, body: sanitizeHtml(fillPlaceholders(libTpl.body, decodeValues(p))), signerLabels: libTpl.extraSigners }
    : undefined;
  return (
    <Shell user={admin} wide>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-black">صدور قرارداد جدید</h1>
        <Link href="/admin/new/file" className="btn-secondary btn-sm">فایل PDF/Word دارید؟ روی همان فایل امضا کنید ←</Link>
      </div>
      <IssueForm
        key={libTpl?.key ?? "blank"}
        templates={tpls}
        users={allUsers.map((u) => ({ id: u.id, name: u.name, email: isGuestEmail(u.email) ? "" : u.email, mobile: u.mobile, isGuest: u.isGuest }))}
        initialCustomer={Number(customer) || undefined}
        kyc={{ threshold: kycThreshold, approved: kycState.status === "approved" }}
        initial={initial}
        identityAvailable={identityAvailable}
      />
    </Shell>
  );
}
