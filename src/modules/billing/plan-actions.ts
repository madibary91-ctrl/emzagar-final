"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaces } from "@/db/schema";
import { logAudit } from "@/modules/audit/service";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { createPlan, deletePlan, getPlanById, setDefaultPlan, updatePlan } from "./catalog";
import { normalizeNumber, parsePlanInput } from "./plans";
import { activateSubscription, revokeSubscription } from "./subscription";

/**
 * مدیریت طرح‌های اشتراک — فقط مدیر کل پلتفرم (هر اکشن به‌طور مستقل احراز هویت می‌شود).
 * نتیجه همیشه با redirect به صفحه‌ی مدیریت برمی‌گردد (?saved=… یا ?error=…).
 */
const back = (q: string): never => redirect(`/platform/plans?${q}`);
const fail = (msg: string): never => back(`error=${encodeURIComponent(msg.slice(0, 300))}`);

/** صفحه‌هایی که طرح‌ها را نشان می‌دهند باید تازه شوند */
function refresh() {
  for (const path of ["/", "/pricing", "/admin/billing", "/admin/wallet", "/platform/plans"]) revalidatePath(path);
}

const toRaw = (fd: FormData): Record<string, unknown> => Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string"));

export async function createPlanAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const parsed = parsePlanInput(toRaw(formData), { requireId: true });
  if (!parsed.ok) return fail(parsed.error);
  const r = await createPlan(parsed.value);
  if (!r.ok) return fail(r.error);
  await logAudit({ action: "plan.created", userId: admin.id, detail: `${r.plan.name} (${r.plan.id}) — ${r.plan.priceToman.toLocaleString("fa-IR")} تومان` });
  refresh();
  return back(`saved=created&plan=${encodeURIComponent(r.plan.id)}`);
}

export async function updatePlanAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const id = String(formData.get("id") || "");
  const parsed = parsePlanInput({ ...toRaw(formData), id }, { requireId: false });
  if (!parsed.ok) return fail(parsed.error);
  const r = await updatePlan(id, parsed.value);
  if (!r.ok) return fail(r.error);
  await logAudit({ action: "plan.updated", userId: admin.id, detail: `${r.plan.name} (${r.plan.id}) — ${r.plan.priceToman.toLocaleString("fa-IR")} تومان` });
  refresh();
  return back(`saved=updated&plan=${encodeURIComponent(id)}`);
}

export async function setDefaultPlanAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const id = String(formData.get("id") || "");
  const r = await setDefaultPlan(id);
  if (!r.ok) return fail(r.error);
  await logAudit({ action: "plan.default", userId: admin.id, detail: `${r.plan.name} (${r.plan.id})` });
  refresh();
  return back(`saved=default&plan=${encodeURIComponent(id)}`);
}

export async function deletePlanAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const id = String(formData.get("id") || "");
  const r = await deletePlan(id);
  if (!r.ok) return fail(r.error);
  await logAudit({ action: "plan.deleted", userId: admin.id, detail: `${id} — ${r.mode === "deleted" ? "حذف کامل" : "بایگانی (سابقه‌ی اشتراک/پرداخت دارد)"}` });
  refresh();
  return back(`saved=${r.mode}`);
}

/** اختصاص دستی طرح به یک فضای کاری (برای طرح‌های خصوصی/قراردادی) یا لغو اشتراک پولی آن؛ ماه ۱ تا ۱۲۰ */
export async function assignPlanAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const wsId = Number(normalizeNumber(formData.get("workspaceId")));
  if (!Number.isInteger(wsId) || wsId < 1) return fail("شناسه‌ی فضای کاری نامعتبر است.");
  const [ws] = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, wsId));
  if (!ws) return fail("فضای کاری با این شناسه پیدا نشد.");
  if (formData.get("intent") === "revoke") {
    await revokeSubscription(ws.id);
    await logAudit({ action: "plan.assigned", userId: admin.id, workspaceId: ws.id, detail: `لغو اشتراک «${ws.name}» و بازگشت به طرح پیش‌فرض` });
    refresh();
    return back("saved=revoked");
  }
  const plan = await getPlanById(String(formData.get("plan") || ""));
  if (!plan || plan.isDefault) return fail("طرح پولی معتبری انتخاب کنید.");
  const months = Number(normalizeNumber(formData.get("months")));
  if (!Number.isInteger(months) || months < 1 || months > 120) return fail("مدت باید عددی از ۱ تا ۱۲۰ ماه باشد.");
  try {
    await activateSubscription(ws.id, plan.id, months);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "اختصاص طرح انجام نشد.");
  }
  await logAudit({ action: "plan.assigned", userId: admin.id, workspaceId: ws.id, detail: `${plan.name} (${plan.id}) — ${months} ماه — «${ws.name}»` });
  refresh();
  return back("saved=assigned");
}
