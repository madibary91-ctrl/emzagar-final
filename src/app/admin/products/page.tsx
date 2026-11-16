import Shell from "@/components/Shell";
import { db } from "@/db";
import { products, templates } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { requireTeam } from "@/modules/tenancy/context";
import { deleteProductAction, saveProductAction } from "@/modules/shop/actions";
import { faNum } from "@/lib/jalali";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const admin = await requireTeam("view");
  const [rows, tpls] = await Promise.all([
    db
      .select({ id: products.id, title: products.title, price: products.price, templateTitle: templates.title })
      .from(products)
      .leftJoin(templates, eq(templates.id, products.templateId))
      .where(eq(products.workspaceId, admin.workspaceId)),
    db.select({ id: templates.id, title: templates.title }).from(templates).where(eq(templates.workspaceId, admin.workspaceId)),
  ]);
  return (
    <Shell user={admin}>
      <h1 className="mb-1 text-2xl font-black">محصولات و خدمات</h1>
      <p className="mb-4 text-sm text-stone-600">هر محصول به یک قالب قرارداد وصل می‌شود؛ پس از خرید، قرارداد خودکار صادر می‌شود.</p>
      <form action={saveProductAction} className="card mb-5 grid gap-3 sm:grid-cols-5">
        <input name="title" placeholder="عنوان محصول" required className="input sm:col-span-2" />
        <input name="price" type="number" min={0} placeholder="قیمت (تومان)" className="input" />
        <select name="templateId" aria-label="قرارداد مرتبط با محصول" className="input">
          <option value="">بدون قرارداد</option>
          {tpls.map((t) => (
            <option key={t.id} value={t.id}>{t.title}</option>
          ))}
        </select>
        <button className="btn btn-primary">افزودن</button>
        <input name="description" placeholder="توضیحات" className="input sm:col-span-5" />
      </form>
      <div className="card overflow-x-auto !p-0">
        <table className="w-full">
          <thead className="bg-stone-50">
            <tr>
              <th className="th">عنوان</th>
              <th className="th">قیمت</th>
              <th className="th">قالب قرارداد</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-stone-100">
                <td className="td">{p.title}</td>
                <td className="td">{faNum(p.price)} تومان</td>
                <td className="td">{p.templateTitle ?? "—"}</td>
                <td className="td">
                  <form action={deleteProductAction}>
                    <input type="hidden" name="id" value={p.id} />
                    <button className="btn btn-secondary btn-sm text-red-700">حذف</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
