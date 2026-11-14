import { BUDGET, MAX_INSTRUCTIONS } from "../constants";
import { type StyleFingerprint, cleanText, styleFingerprint } from "../text";
import { activeDocs } from "./docs";
import { aiPersonalization } from "@/db/schema";
import { db } from "@/db";
import { eq } from "drizzle-orm";

/* ───────────── تنظیمات شخصی‌سازی ───────────── */

export type Personalization = typeof aiPersonalization.$inferSelect;
export async function getPersonalization(workspaceId: number): Promise<Personalization> {
  const [row] = await db.select().from(aiPersonalization).where(eq(aiPersonalization.workspaceId, workspaceId));
  if (row) return row;
  await db.insert(aiPersonalization).values({ workspaceId }).onConflictDoNothing();
  const [again] = await db.select().from(aiPersonalization).where(eq(aiPersonalization.workspaceId, workspaceId));
  return again;
}
export async function savePersonalization(workspaceId: number, v: { enabled?: boolean; instructions?: string }): Promise<void> {
  await getPersonalization(workspaceId);
  const set: Partial<Personalization> = { updatedAt: new Date() };
  if (typeof v.enabled === "boolean") set.enabled = v.enabled;
  if (typeof v.instructions === "string") set.instructions = cleanText(v.instructions).slice(0, MAX_INSTRUCTIONS);
  await db.update(aiPersonalization).set(set).where(eq(aiPersonalization.workspaceId, workspaceId));
}
export async function saveStyleProfile(workspaceId: number, profile: string, docCount: number): Promise<void> {
  await getPersonalization(workspaceId);
  await db
    .update(aiPersonalization)
    .set({ styleProfile: profile.slice(0, BUDGET.profile), profileDocCount: docCount, profileUpdatedAt: new Date(), updatedAt: new Date() })
    .where(eq(aiPersonalization.workspaceId, workspaceId));
}
export async function clearStyleProfile(workspaceId: number): Promise<void> {
  await db.update(aiPersonalization).set({ styleProfile: "", profileDocCount: 0, profileUpdatedAt: null }).where(eq(aiPersonalization.workspaceId, workspaceId));
}
export async function getFingerprint(workspaceId: number): Promise<StyleFingerprint | null> {
  const docs = (await activeDocs(workspaceId)).filter((d) => d.kind !== "policy");
  if (docs.length === 0) return null;
  return styleFingerprint(docs.map((d) => d.content));
}
