"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { clauses } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { sanitizeHtml } from "@/lib/html";
import { logAudit } from "@/modules/audit/service";
import { BUILTIN_CLAUSES, CLAUSE_CATEGORIES } from "./builtin";

export interface ClauseOption {
  id: string;
  title: string;
  category: string;
  categoryLabel: string;
  body: string;
  builtin: boolean;
}

/** بندهای آماده + بندهای اختصاصی فضای کاری (برای انتخابگر داخل ویرایشگر) */
export async function listClausesAction(): Promise<ClauseOption[]> {
  const team = await requireTeam("view");
  const custom = await db.select().from(clauses).where(eq(clauses.workspaceId, team.workspaceId)).orderBy(asc(clauses.title));
  const label = (c: string) => CLAUSE_CATEGORIES[c] ?? "عمومی";
  return [
    ...custom.map((c) => ({ id: `c:${c.id}`, title: c.title, category: c.category, categoryLabel: label(c.category), body: c.body, builtin: false })),
    ...BUILTIN_CLAUSES.map((c) => ({ id: c.id, title: c.title, category: c.category, categoryLabel: label(c.category), body: c.body, builtin: true })),
  ];
}

function validate(title: string, html: string): string | null {
  if (title.length < 2) return "عنوان بند را وارد کنید";
  if (html.replace(/<[^>]*>/g, "").trim().length < 10) return "متن بند بسیار کوتاه است";
  if (html.length > 20000) return "متن بند بیش از حد طولانی است";
  return null;
}

/** ذخیره‌ی بخش انتخاب‌شده‌ی ویرایشگر به‌عنوان بند (از داخل ویرایشگر) */
export async function saveClauseQuickAction(title: string, category: string, bodyHtml: string): Promise<{ ok: boolean; error?: string }> {
  const team = await requireTeam("write");
  const t = String(title || "").trim().slice(0, 120);
  const body = sanitizeHtml(String(bodyHtml || ""));
  const err = validate(t, body);
  if (err) return { ok: false, error: err };
  const cat = category in CLAUSE_CATEGORIES ? category : "general";
  await db.insert(clauses).values({ workspaceId: team.workspaceId, title: t, category: cat, body, createdBy: team.id });
  await logAudit({ action: "clause.saved", workspaceId: team.workspaceId, userId: team.id, detail: t });
  revalidatePath("/admin/clauses");
  return { ok: true };
}

export type ClauseFormState = { error?: string; ok?: boolean };

export async function saveClauseAction(_prev: ClauseFormState, formData: FormData): Promise<ClauseFormState> {
  const team = await requireTeam("write");
  const id = Number(formData.get("id")) || null;
  const title = String(formData.get("title") || "").trim().slice(0, 120);
  const category = String(formData.get("category") || "general");
  const body = sanitizeHtml(String(formData.get("body") || ""));
  const err = validate(title, body);
  if (err) return { error: err };
  const cat = category in CLAUSE_CATEGORIES ? category : "general";
  if (id) {
    const upd = await db.update(clauses).set({ title, category: cat, body }).where(and(eq(clauses.id, id), eq(clauses.workspaceId, team.workspaceId))).returning({ id: clauses.id });
    if (upd.length === 0) return { error: "بند یافت نشد" };
  } else {
    await db.insert(clauses).values({ workspaceId: team.workspaceId, title, category: cat, body, createdBy: team.id });
  }
  await logAudit({ action: "clause.saved", workspaceId: team.workspaceId, userId: team.id, detail: title });
  revalidatePath("/admin/clauses");
  return { ok: true };
}

export async function deleteClauseAction(formData: FormData) {
  const team = await requireTeam("write");
  const id = Number(formData.get("id"));
  if (Number.isInteger(id)) {
    const del = await db.delete(clauses).where(and(eq(clauses.id, id), eq(clauses.workspaceId, team.workspaceId))).returning({ title: clauses.title });
    if (del[0]) await logAudit({ action: "clause.deleted", workspaceId: team.workspaceId, userId: team.id, detail: del[0].title });
  }
  revalidatePath("/admin/clauses");
  redirect("/admin/clauses");
}
