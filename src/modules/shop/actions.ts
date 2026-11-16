"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, products, templates, workspaceMembers } from "@/db/schema";
import { requireUser } from "@/modules/auth/session";
import { requireTeam } from "@/modules/tenancy/context";
import { issueContract } from "@/modules/contracts/service";
import { logAudit } from "@/modules/audit/service";

/** خرید محصول/خدمت ← صدور خودکار قرارداد مرتبط برای امضای آنلاین */
export async function buyProductAction(formData: FormData) {
  const user = await requireUser();
  const productId = Number(formData.get("productId"));
  const [product] = await db.select().from(products).where(eq(products.id, productId));
  if (!product) redirect("/shop");
  // فقط محصولات فروشگاهی که کاربر در آن عضو است قابل خرید است (ایزولاسیون مستاجر)
  const [member] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, product.workspaceId), eq(workspaceMembers.userId, user.id)));
  if (!member) redirect("/shop");

  const [order] = await db
    .insert(orders)
    .values({ workspaceId: product.workspaceId, userId: user.id, productId: product.id, amount: product.price })
    .returning();
  await logAudit({ action: "order.created", workspaceId: product.workspaceId, userId: user.id, detail: `${product.title} — سفارش #${order.id}` });

  if (product.templateId) {
    const [tpl] = await db.select().from(templates).where(and(eq(templates.id, product.templateId), eq(templates.workspaceId, product.workspaceId)));
    if (tpl) {
      const contractId = await issueContract({
        title: `${tpl.title} — ${product.title}`,
        bodyHtml: tpl.body,
        templateId: tpl.id,
        customerId: user.id,
        workspaceId: product.workspaceId,
        source: "shop",
        orderId: order.id,
        productName: product.title,
        amount: product.price,
        createdBy: user.id,
      });
      await db.update(orders).set({ contractId }).where(eq(orders.id, order.id));
      revalidatePath("/dashboard");
      redirect(`/contracts/${contractId}`);
    }
  }
  await db.update(orders).set({ status: "completed" }).where(eq(orders.id, order.id));
  redirect("/dashboard");
}

export async function saveProductAction(formData: FormData) {
  const admin = await requireTeam("settings");
  const title = String(formData.get("title") || "").trim();
  const description = String(formData.get("description") || "").trim();
  const price = Math.max(0, Number(formData.get("price")) || 0);
  let templateId = Number(formData.get("templateId")) || null;
  if (templateId) {
    const [t] = await db.select({ id: templates.id }).from(templates).where(and(eq(templates.id, templateId), eq(templates.workspaceId, admin.workspaceId)));
    if (!t) templateId = null;
  }
  if (title) await db.insert(products).values({ workspaceId: admin.workspaceId, title, description, price, templateId });
  revalidatePath("/admin/products");
  revalidatePath("/shop");
}

export async function deleteProductAction(formData: FormData) {
  const admin = await requireTeam("settings");
  const id = Number(formData.get("id"));
  if (Number.isInteger(id)) await db.delete(products).where(and(eq(products.id, id), eq(products.workspaceId, admin.workspaceId)));
  revalidatePath("/admin/products");
  revalidatePath("/shop");
}
