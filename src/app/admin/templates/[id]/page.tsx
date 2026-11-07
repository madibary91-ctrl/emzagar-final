import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import Shell from "@/components/Shell";
import TemplateForm from "@/components/TemplateForm";
import { db } from "@/db";
import { templates } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";

export const dynamic = "force-dynamic";

export default async function EditTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireTeam("write");
  const { id } = await params;
  let tpl;
  if (id !== "new") {
    const n = Number(id);
    if (!Number.isInteger(n)) notFound();
    [tpl] = await db.select().from(templates).where(and(eq(templates.id, n), eq(templates.workspaceId, admin.workspaceId)));
    if (!tpl) notFound();
  }
  return (
    <Shell user={admin} wide>
      <h1 className="mb-4 text-2xl font-black">{tpl ? "ویرایش قالب" : "قالب جدید"}</h1>
      <TemplateForm tpl={tpl} />
    </Shell>
  );
}
