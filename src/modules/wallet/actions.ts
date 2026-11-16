"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { rateLimit } from "@/lib/rate-limit";
import { getOrigin } from "@/lib/request";
import { logAudit } from "@/modules/audit/service";
import { startPayment } from "@/modules/payments/service";
import { requireTeam } from "@/modules/tenancy/context";
import { toLatinDigits } from "@/modules/kyc/rules";
import { TOPUP_MAX, TOPUP_MIN } from "./packs";
import { purchasePack } from "./service";

export type WalletState = { error?: string; ok?: boolean; message?: string };

/** شارژ کیف پول از درگاه: مبلغ در سرور اعتبارسنجی می‌شود و در صورت قطعی درگاه، خودکار به درگاه بعدی می‌رود */
export async function topupAction(_prev: WalletState, formData: FormData): Promise<WalletState> {
  const team = await requireTeam("settings");
  if (!rateLimit(`topup:${team.id}`, 10, 10 * 60_000).ok) return { error: "درخواست‌های شارژ زیاد بود؛ چند دقیقه بعد تلاش کنید." };
  const amount = Number(toLatinDigits(String(formData.get("amount") || "")).replace(/[,٬\s]/g, ""));
  if (!Number.isInteger(amount) || amount < TOPUP_MIN || amount > TOPUP_MAX) {
    return { error: `مبلغ شارژ باید بین ${TOPUP_MIN.toLocaleString("fa-IR")} تا ${TOPUP_MAX.toLocaleString("fa-IR")} تومان باشد` };
  }
  let url = "";
  try {
    url = await startPayment({
      kind: "topup",
      workspaceId: team.workspaceId,
      userId: team.id,
      amountToman: amount,
      origin: await getOrigin(),
      gateway: String(formData.get("gateway") || "") || undefined,
      description: `شارژ کیف پول — ${team.workspaceName}`.slice(0, 120),
      mobile: team.mobile,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "خطا در اتصال به درگاه پرداخت" };
  }
  await logAudit({ action: "wallet.topup_started", workspaceId: team.workspaceId, userId: team.id, detail: `${amount.toLocaleString("fa-IR")} تومان` });
  redirect(url);
}

/** خرید بسته‌ی اعتباری از موجودی کیف پول */
export async function buyPackAction(_prev: WalletState, formData: FormData): Promise<WalletState> {
  const team = await requireTeam("settings");
  if (!rateLimit(`pack:${team.id}`, 20, 10 * 60_000).ok) return { error: "درخواست‌ها زیاد بود؛ کمی بعد تلاش کنید." };
  const r = await purchasePack(team.workspaceId, team.id, String(formData.get("pack") || ""));
  if (!r.ok) return { error: r.error };
  await logAudit({ action: "wallet.pack_purchased", workspaceId: team.workspaceId, userId: team.id, detail: String(formData.get("pack")) });
  revalidatePath("/admin/wallet");
  return { ok: true, message: `بسته خریداری شد؛ اعتبار فعلی شما ${r.credits.toLocaleString("fa-IR")} قرارداد است.` };
}
