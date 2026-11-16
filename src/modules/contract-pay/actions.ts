"use server";

import { revalidatePath } from "next/cache";
import { rateLimit } from "@/lib/rate-limit";
import { getOrigin, getRequestInfo } from "@/lib/request";
import { requireTeam } from "@/modules/tenancy/context";
import { resolveSigningToken, TOKEN_RE } from "@/modules/signing/links";
import { saveWorkspaceCredential } from "@/modules/payments/workspace";
import { isRealGateway } from "@/modules/payments/types";
import { logAudit } from "@/modules/audit/service";
import { cancelInstallment, getInstallmentByCode, markManualPaid, PayError, setPlan, startInstallmentPayment } from "./service";
import { validatePlan, type PlanItem } from "./schedule";

export type PayActionResult = { ok: boolean; error?: string; url?: string };

const fail = (e: unknown, fallback: string): PayActionResult => ({ ok: false, error: e instanceof PayError || (e instanceof Error && e.message) ? (e as Error).message : fallback });

/** ثبت/حذف برنامه‌ی پرداخت یک قرارداد (مدیر/عضو تیم) */
export async function savePlanAction(contractId: number, items: unknown): Promise<PayActionResult> {
  const team = await requireTeam("write");
  try {
    const empty = Array.isArray(items) && items.length === 0;
    const v = empty ? { ok: true as const, items: [] as PlanItem[], total: 0 } : validatePlan(items);
    if (!v.ok) return { ok: false, error: v.error };
    await setPlan({ contractId: Number(contractId), workspaceId: team.workspaceId, actorId: team.id, items: v.items });
    revalidatePath(`/contracts/${contractId}`);
    revalidatePath("/admin/receivables");
    return { ok: true };
  } catch (e) {
    return fail(e, "ثبت برنامه‌ی پرداخت انجام نشد");
  }
}

export async function markPaidAction(installmentId: number, note: string): Promise<PayActionResult> {
  const team = await requireTeam("write");
  try {
    await markManualPaid({ installmentId: Number(installmentId), workspaceId: team.workspaceId, actorId: team.id, note: String(note ?? "") });
    revalidatePath("/admin/receivables");
    revalidatePath("/contracts", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e, "ثبت پرداخت انجام نشد");
  }
}

export async function cancelInstallmentAction(installmentId: number): Promise<PayActionResult> {
  const team = await requireTeam("delete");
  try {
    await cancelInstallment({ installmentId: Number(installmentId), workspaceId: team.workspaceId, actorId: team.id });
    revalidatePath("/admin/receivables");
    revalidatePath("/contracts", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e, "لغو انجام نشد");
  }
}

/**
 * شروع پرداخت (صفحه‌ی امضا یا لینک پرداخت عمومی). «کد پرداخت» غیرقابل‌حدس است و فقط به همان قسط دسترسی می‌دهد.
 * بازگشت به صفحه‌ی امضا فقط وقتی پذیرفته می‌شود که توکن امضا واقعاً مال همین قرارداد باشد.
 */
export async function startPayAction(code: string, gateway: string | undefined, signToken?: string): Promise<PayActionResult> {
  const { ip } = await getRequestInfo();
  if (!rateLimit(`paystart:ip:${ip}`, 20, 10 * 60_000).ok || !rateLimit(`paystart:code:${String(code).slice(0, 40)}`, 10, 10 * 60_000).ok) return { ok: false, error: "درخواست‌های پرداخت زیاد بود؛ چند دقیقه بعد دوباره تلاش کنید" };
  try {
    const inst = await getInstallmentByCode(String(code ?? ""));
    if (!inst) return { ok: false, error: "لینک پرداخت نامعتبر است" };
    let returnPath: string | undefined;
    if (signToken && TOKEN_RE.test(signToken)) {
      const st = await resolveSigningToken(signToken);
      if ((st.status === "ok" || st.status === "done") && st.ctx.contract.id === inst.contractId) returnPath = `/sign/${signToken}`;
    }
    const url = await startInstallmentPayment({ code: inst.payCode, gateway: gateway || undefined, origin: await getOrigin(), returnPath });
    return { ok: true, url };
  } catch (e) {
    return fail(e, "شروع پرداخت انجام نشد");
  }
}

/** ثبت مرچنت اختصاصی فضای کاری برای دریافت مستقیم وجه قراردادها */
export async function saveMerchantAction(gateway: string, value: string): Promise<PayActionResult> {
  const team = await requireTeam("settings");
  if (!isRealGateway(gateway)) return { ok: false, error: "درگاه نامعتبر است" };
  const r = await saveWorkspaceCredential(team.workspaceId, gateway, String(value ?? ""));
  if (!r.ok) return { ok: false, error: r.error };
  await logAudit({ action: "pay.merchant_saved", workspaceId: team.workspaceId, userId: team.id, detail: `${gateway}${value.trim() ? "" : " (حذف شد)"}` });
  revalidatePath("/admin/receivables");
  return { ok: true };
}
