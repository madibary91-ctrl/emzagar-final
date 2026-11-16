"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { templates } from "@/db/schema";
import { sanitizeHtml } from "@/lib/html";
import { logAudit } from "@/modules/audit/service";
import { requireTeam } from "@/modules/tenancy/context";
import { fillPlaceholders, getLibraryTemplate } from "./index";

export type LibraryState = { error?: string };

/**
 * افزودن قالب کتابخانه به «قالب‌های من» (برای ویرایش و استفاده‌ی مکرر).
 * اگر قبلاً افزوده شده باشد، همان را باز می‌کند (بدون تکرار).
 */
export async function addLibraryTemplateAction(formData: FormData) {
  const admin = await requireTeam("write");
  const key = String(formData.get("key") || "");
  const t = getLibraryTemplate(key);
  if (!t) redirect("/admin/library");
  const find = async () =>
    (
      await db
        .select({ id: templates.id })
        .from(templates)
        .where(and(eq(templates.workspaceId, admin.workspaceId), eq(templates.libraryKey, t.key)))
        .limit(1)
    )[0]?.id;
  let id = await find();
  if (!id) {
    // ایندکس یکتای (workspace_id, library_key) تضمین می‌کند دو کلیک هم‌زمان هم فقط «یک» کپی بسازد؛ بازنده همان کپی برنده را باز می‌کند
    const [row] = await db
      .insert(templates)
      .values({ workspaceId: admin.workspaceId, title: t.title, description: t.summary, body: sanitizeHtml(fillPlaceholders(t.body)), libraryKey: t.key })
      .onConflictDoNothing()
      .returning({ id: templates.id });
    if (row) {
      id = row.id;
      await logAudit({ workspaceId: admin.workspaceId, action: "template.library_added", userId: admin.id, detail: t.key });
    } else {
      id = await find();
    }
  }
  if (!id) redirect("/admin/library");
  revalidatePath("/admin/templates");
  revalidatePath("/admin/library");
  redirect(`/admin/templates/${id}`);
}
