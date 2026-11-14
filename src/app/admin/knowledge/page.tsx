import { BookMarked } from "lucide-react";
import { and, desc, eq, ne } from "drizzle-orm";
import Shell from "@/components/Shell";
import KnowledgePanel, { type KDoc } from "@/components/KnowledgePanel";
import { db } from "@/db";
import { contracts, templates } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { aiConfigured, usageToday } from "@/modules/ai/service";
import { getFingerprint, getPersonalization, listDocs } from "@/modules/ai/knowledge/service";
import { profileIsStale } from "@/modules/ai/knowledge/profile";
import { MAX_DOCS_PER_WORKSPACE } from "@/modules/ai/knowledge/constants";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { draft: "پیش‌نویس", sent: "ارسال‌شده", signed: "امضاشده", rejected: "ردشده", expired: "منقضی", cancelled: "لغوشده" };

/** حافظه‌ی حقوقی: اسناد و قوانین کاربر که هوش مصنوعی را شخصی‌سازی می‌کنند */
export default async function KnowledgePage() {
  const team = await requireTeam("view");
  const ws = team.workspaceId;
  const [docs, pers, fingerprint, aiReady, usage, cs, ts] = await Promise.all([
    listDocs(ws),
    getPersonalization(ws),
    getFingerprint(ws),
    aiConfigured(ws),
    usageToday(ws),
    db.select({ id: contracts.id, title: contracts.title, status: contracts.status }).from(contracts).where(and(eq(contracts.workspaceId, ws), ne(contracts.status, "cancelled"))).orderBy(desc(contracts.issuedAt)).limit(60),
    db.select({ id: templates.id, title: templates.title }).from(templates).where(eq(templates.workspaceId, ws)).orderBy(desc(templates.updatedAt)).limit(60),
  ]);
  const stale = await profileIsStale(ws, pers.profileDocCount, pers.profileUpdatedAt);
  const kdocs: KDoc[] = docs.map((d) => ({ id: d.id, title: d.title, kind: d.kind, source: d.source, fileName: d.fileName, charCount: d.charCount, redactions: d.redactions, enabled: d.enabled, createdAt: d.createdAt.toISOString() }));

  return (
    <Shell user={team} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><BookMarked size={22} />حافظه‌ی حقوقی</h1>
      <p className="mb-5 text-xs text-ink/72">هوش مصنوعی را با اسناد، قوانین و لحن کسب‌وکار خودتان شخصی‌سازی کنید.</p>
      <KnowledgePanel
        canWrite={can(team.wsRole, "write")}
        aiReady={aiReady}
        aiLeft={Math.max(0, usage.limit - usage.used)}
        docs={kdocs}
        enabled={pers.enabled}
        instructions={pers.instructions}
        styleProfile={pers.styleProfile}
        profileUpdatedAt={pers.profileUpdatedAt ? faTime(pers.profileUpdatedAt) : null}
        profileStale={stale}
        fingerprint={fingerprint}
        contracts={cs.map((c) => ({ id: c.id, title: c.title, sub: STATUS[c.status] ?? c.status }))}
        templates={ts.map((t) => ({ id: t.id, title: t.title, sub: "قالب" }))}
        maxDocs={MAX_DOCS_PER_WORKSPACE}
      />
    </Shell>
  );
}
