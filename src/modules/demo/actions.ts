"use server";

import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { clearDemoData, seedDemoData } from "./service";

export type DemoState = { ok?: string; error?: string };

function refresh() {
  for (const p of ["/admin", "/admin/demo", "/admin/customers", "/admin/logs", "/admin/reports", "/admin/insights", "/admin/renewals", "/admin/products", "/platform/tickets", "/support"]) revalidatePath(p);
}

export async function seedDemoAction(_prev: DemoState, _fd: FormData): Promise<DemoState> {
  const admin = await requireTeam("settings");
  try {
    const st = await seedDemoData({ workspaceId: admin.workspaceId, actorId: admin.id });
    refresh();
    return { ok: `داده‌های نمونه ساخته شد: ${st.counts.contracts.toLocaleString("fa-IR")} قرارداد، ${st.counts.users.toLocaleString("fa-IR")} مشتری، ${st.counts.tickets.toLocaleString("fa-IR")} تیکت و ${st.counts.logs.toLocaleString("fa-IR")} لاگ.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "ساخت داده‌ی نمونه ناموفق بود" };
  }
}

export async function clearDemoAction(_prev: DemoState, _fd: FormData): Promise<DemoState> {
  const admin = await requireTeam("settings");
  try {
    const st = await clearDemoData({ workspaceId: admin.workspaceId, actorId: admin.id });
    refresh();
    return { ok: st.kept ? `داده‌های نمونه پاک شد. ${st.kept.toLocaleString("fa-IR")} مشتری چون در قرارداد واقعی حضور داشت حفظ شد.` : "همه‌ی داده‌های نمونه پاک شد؛ سیستم برای استفاده‌ی واقعی آماده است." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "پاک‌سازی ناموفق بود" };
  }
}
