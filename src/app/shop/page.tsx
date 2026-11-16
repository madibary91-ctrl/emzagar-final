import Shell from "@/components/Shell";
import { db } from "@/db";
import { products, templates, workspaces } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { getMemberships } from "@/modules/tenancy/context";
import { requireUser } from "@/modules/auth/session";
import { buyProductAction } from "@/modules/shop/actions";
import { faNum } from "@/lib/jalali";

export const dynamic = "force-dynamic";

export default async function ShopPage() {
  const user = await requireUser();
  const wsIds = (await getMemberships(user.id)).map((m) => m.workspaceId);
  const items = wsIds.length === 0 ? [] : await db
    .select({ workspaceName: workspaces.name, id: products.id, title: products.title, description: products.description, price: products.price, templateTitle: templates.title })
    .from(products)
    .innerJoin(workspaces, eq(workspaces.id, products.workspaceId))
    .leftJoin(templates, eq(templates.id, products.templateId))
    .where(inArray(products.workspaceId, wsIds));
  return (
    <Shell user={user}>
      <h1 className="mb-1 text-2xl font-black">فروشگاه / خدمات</h1>
      <p className="mb-5 text-sm text-stone-600">پس از ثبت سفارش، قرارداد مرتبط به‌صورت خودکار صادر می‌شود و باید آن را امضا کنید.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {items.map((p) => (
          <div key={p.id} className="card flex flex-col gap-3">
            <span className="text-xs font-semibold text-ink/72">{p.workspaceName}</span>
            <h2 className="text-lg font-bold">{p.title}</h2>
            <p className="flex-1 text-sm text-stone-600">{p.description}</p>
            {p.templateTitle && <p className="text-xs text-emerald-700">📄 قرارداد همراه: {p.templateTitle}</p>}
            <div className="flex items-center justify-between">
              <span className="font-bold">{faNum(p.price)} تومان</span>
              <form action={buyProductAction}>
                <input type="hidden" name="productId" value={p.id} />
                <button className="btn btn-primary">ثبت سفارش و امضای قرارداد</button>
              </form>
            </div>
          </div>
        ))}
        {items.length === 0 && <div className="card text-stone-600">محصولی تعریف نشده است.</div>}
      </div>
    </Shell>
  );
}
