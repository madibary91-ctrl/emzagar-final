import { aiKnowledgeDocs } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { getPersonalization } from "./personalization";

export type KnowledgeStats = { enabled: boolean; docs: number; activeDocs: number; hasProfile: boolean; hasInstructions: boolean };
export async function knowledgeStats(workspaceId: number): Promise<KnowledgeStats> {
  const [p, [c]] = await Promise.all([
    getPersonalization(workspaceId),
    db
      .select({ n: sql<number>`count(*)::int`, a: sql<number>`count(*) filter (where ${aiKnowledgeDocs.enabled})::int` })
      .from(aiKnowledgeDocs)
      .where(eq(aiKnowledgeDocs.workspaceId, workspaceId)),
  ]);
  return { enabled: p.enabled, docs: c?.n ?? 0, activeDocs: c?.a ?? 0, hasProfile: !!p.styleProfile, hasInstructions: !!p.instructions.trim() };
}
