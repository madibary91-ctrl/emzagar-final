import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contractRevisions, contracts, users } from "@/db/schema";
import { logAudit } from "@/modules/audit/service";
import { countWords, diffHtml, diffStats } from "@/lib/diff";
import { sanitizeHtml } from "@/lib/html";
import { invalidateApprovals } from "./approvals";

export type RevisionKind = "initial" | "draft" | "publish" | "restore";

export const REVISION_KIND_LABELS: Record<string, string> = {
  initial: "نسخه‌ی اول",
  draft: "ذخیره‌ی پیش‌نویس",
  publish: "انتشار نهایی",
  restore: "بازگردانی نسخه",
};

/**
 * عکس فوری از متن قرارداد. اگر عنوان و متن با آخرین نسخه یکسان باشد چیزی ثبت نمی‌شود
 * (ذخیره‌ی پشت‌سرهم بدون تغییر نسخه‌ی اضافه نمی‌سازد). شماره‌ی نسخه برمی‌گردد یا null.
 */
export async function snapshotRevision(
  contractId: number,
  input: { title: string; bodyHtml: string; kind: RevisionKind; note?: string; userId?: number | null },
): Promise<number | null> {
  const [latest] = await db.select().from(contractRevisions).where(eq(contractRevisions.contractId, contractId)).orderBy(desc(contractRevisions.version)).limit(1);
  if (latest && latest.title === input.title && latest.bodyHtml === input.bodyHtml) {
    // انتشار روی همان متنِ ذخیره‌شده: فقط برچسب نسخه را به «انتشار» ارتقا می‌دهیم
    if (input.kind === "publish" && latest.kind !== "publish") {
      await db.update(contractRevisions).set({ kind: "publish", note: input.note ?? latest.note }).where(eq(contractRevisions.id, latest.id));
    }
    return null;
  }
  const version = (latest?.version ?? 0) + 1;
  const inserted = await db
    .insert(contractRevisions)
    .values({
      contractId,
      version,
      title: input.title,
      bodyHtml: input.bodyHtml,
      kind: latest || input.kind !== "draft" ? input.kind : "initial",
      note: (input.note ?? "").slice(0, 300),
      wordCount: countWords(input.bodyHtml),
      createdBy: input.userId ?? null,
    })
    .onConflictDoNothing()
    .returning({ version: contractRevisions.version });
  return inserted[0]?.version ?? null;
}

export async function listRevisions(contractId: number) {
  return db
    .select({
      id: contractRevisions.id,
      version: contractRevisions.version,
      title: contractRevisions.title,
      kind: contractRevisions.kind,
      note: contractRevisions.note,
      wordCount: contractRevisions.wordCount,
      createdAt: contractRevisions.createdAt,
      authorName: users.name,
    })
    .from(contractRevisions)
    .leftJoin(users, eq(users.id, contractRevisions.createdBy))
    .where(eq(contractRevisions.contractId, contractId))
    .orderBy(desc(contractRevisions.version));
}

export async function getRevision(contractId: number, version: number) {
  const [r] = await db
    .select()
    .from(contractRevisions)
    .where(and(eq(contractRevisions.contractId, contractId), eq(contractRevisions.version, version)));
  return r ?? null;
}

export async function revisionCount(contractId: number): Promise<number> {
  const rows = await db.select({ id: contractRevisions.id }).from(contractRevisions).where(eq(contractRevisions.contractId, contractId));
  return rows.length;
}

/** مقایسه‌ی دو نسخه؛ null اگر یکی از نسخه‌ها وجود نداشته باشد */
export async function compareRevisions(contractId: number, fromVersion: number, toVersion: number) {
  const [a, b] = await Promise.all([getRevision(contractId, fromVersion), getRevision(contractId, toVersion)]);
  if (!a || !b) return null;
  const parts = diffHtml(a.bodyHtml, b.bodyHtml);
  return { from: a, to: b, parts, stats: diffStats(parts), titleChanged: a.title !== b.title };
}

/** بازگردانی یک نسخه‌ی قدیمی به‌عنوان نسخه‌ی تازه (فقط پیش‌نویس؛ تاریخچه هرگز بازنویسی نمی‌شود) */
export async function restoreRevision(contractId: number, version: number, actorId: number, workspaceId: number): Promise<void> {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.workspaceId, workspaceId)));
  if (!c || c.status !== "draft") throw new Error("فقط پیش‌نویس قابل بازگردانی است");
  const rev = await getRevision(contractId, version);
  if (!rev) throw new Error("نسخه یافت نشد");
  const body = sanitizeHtml(rev.bodyHtml);
  await db.update(contracts).set({ title: rev.title, bodyHtml: body }).where(and(eq(contracts.id, contractId), eq(contracts.status, "draft")));
  const created = await snapshotRevision(contractId, { title: rev.title, bodyHtml: body, kind: "restore", note: `بازگردانی نسخه‌ی ${version}`, userId: actorId });
  if (created) await invalidateApprovals(contractId, actorId, `بازگردانی نسخه‌ی ${version}`);
  await logAudit({ action: "revision.restored", contractId, userId: actorId, workspaceId, detail: `${c.number} — بازگشت به نسخه‌ی ${version}` });
}
