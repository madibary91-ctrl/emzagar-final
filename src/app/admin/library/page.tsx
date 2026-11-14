import { and, eq, isNotNull } from "drizzle-orm";
import Shell from "@/components/Shell";
import LibraryBrowser, { type LibItem } from "@/components/LibraryBrowser";
import { db } from "@/db";
import { templates } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { CATEGORIES, LIBRARY, fillPlaceholders, listPlaceholders } from "@/modules/library";
import { FIELD_TOKEN_RE } from "@/modules/fields";

export const dynamic = "force-dynamic";
export const metadata = { title: "کتابخانه‌ی قالب‌ها" };

/** پیش‌نمایش خوانا: جاهای خالی صادرکننده «……» و فیلدهای امضاکننده به‌صورت نشان زردرنگ */
function previewOf(body: string): string {
  return fillPlaceholders(body).replace(FIELD_TOKEN_RE, (_w, inner: string) => {
    const label = (inner.split("|")[1] || "").trim() || "مقدار";
    return `<span style="background:#fef3c7;border-radius:6px;padding:0 6px">«${label}»</span>`;
  });
}

export default async function LibraryPage() {
  const admin = await requireTeam("view");
  const mine = await db
    .select({ key: templates.libraryKey })
    .from(templates)
    .where(and(eq(templates.workspaceId, admin.workspaceId), isNotNull(templates.libraryKey)));
  const added = new Set(mine.map((m) => m.key));
  const items: LibItem[] = LIBRARY.map((t) => ({
    key: t.key,
    category: t.category,
    title: t.title,
    summary: t.summary,
    tags: t.tags,
    legalBasis: t.legalBasis,
    roles: t.roles,
    extraSigners: t.extraSigners,
    articleCount: t.articleCount,
    wordCount: t.wordCount,
    preview: previewOf(t.body),
    placeholders: listPlaceholders(t.body),
    added: added.has(t.key),
  }));
  return (
    <Shell user={admin} wide>
      <LibraryBrowser items={items} categories={CATEGORIES.map((c) => ({ ...c }))} canWrite={can(admin.wsRole, "write")} />
    </Shell>
  );
}
