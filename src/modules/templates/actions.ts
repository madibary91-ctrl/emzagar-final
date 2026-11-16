"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { templates } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { sanitizeHtml } from "@/lib/html";
import { logAudit } from "@/modules/audit/service";

export type TemplateState = { error?: string };

export async function saveTemplateAction(_prev: TemplateState, formData: FormData): Promise<TemplateState> {
  const admin = await requireTeam("write");
  const id = Number(formData.get("id")) || null;
  const title = String(formData.get("title") || "").trim();
  const description = String(formData.get("description") || "").trim();
  const body = sanitizeHtml(String(formData.get("body") || ""));
  if (!title) return { error: "عنوان قالب را وارد کنید" };
  if (body.replace(/<[^>]*>/g, "").trim().length < 10) return { error: "متن قالب بسیار کوتاه است" };

  if (id) {
    const upd = await db
      .update(templates)
      .set({ title, description, body, updatedAt: new Date() })
      .where(and(eq(templates.id, id), eq(templates.workspaceId, admin.workspaceId)))
      .returning({ id: templates.id });
    if (upd.length === 0) return { error: "قالب یافت نشد" };
  } else {
    await db.insert(templates).values({ workspaceId: admin.workspaceId, title, description, body });
  }
  await logAudit({ workspaceId: admin.workspaceId, action: "template.saved", userId: admin.id, detail: title });
  revalidatePath("/admin/templates");
  redirect("/admin/templates");
}

export async function deleteTemplateAction(formData: FormData) {
  const admin = await requireTeam("delete");
  const id = Number(formData.get("id"));
  if (Number.isInteger(id)) {
    await db.delete(templates).where(and(eq(templates.id, id), eq(templates.workspaceId, admin.workspaceId)));
    await logAudit({ workspaceId: admin.workspaceId, action: "template.deleted", userId: admin.id, detail: `#${id}` });
  }
  revalidatePath("/admin/templates");
  redirect("/admin/templates");
}
