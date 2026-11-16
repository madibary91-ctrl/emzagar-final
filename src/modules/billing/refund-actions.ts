"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { saveInvoiceSettings, clampTaxPercent } from "./invoices";
import { refundPayment } from "./refunds";
import { logAudit } from "@/modules/audit/service";

const back = (q: string) => redirect(`/platform/finance?${q}`);
const faDigits = (v: FormDataEntryValue | null) => String(v ?? "").replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) & 15)).replace(/[,٬\s]/g, "");

/** بازپرداخت یک پرداخت اشتراک (فقط مدیر کل) */
export async function refundAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const paymentId = Number(formData.get("paymentId"));
  if (!Number.isInteger(paymentId)) return back("error=" + encodeURIComponent("پرداخت نامعتبر است"));
  const rawAmount = faDigits(formData.get("amount"));
  // مبلغ نامعتبر («abc»، «۱۲٫۵») پیش‌تر NaN می‌شد و به «بازپرداخت کل مبلغ» تعبیر می‌شد — خطرناک‌ترین حالت ممکن برای یک اشتباه تایپی
  if (rawAmount !== "" && !/^\d+$/.test(rawAmount)) return back("error=" + encodeURIComponent("مبلغ بازپرداخت باید عدد صحیح (تومان) باشد؛ برای بازپرداخت کامل، آن را خالی بگذارید"));
  const r = await refundPayment({
    paymentId,
    amount: rawAmount === "" ? undefined : Number(rawAmount),
    reason: String(formData.get("reason") || ""),
    method: formData.get("method") === "manual" ? "manual" : "wallet",
    revokeSubscription: formData.get("revoke") === "on",
    actorId: admin.id,
  });
  revalidatePath("/platform/finance");
  if (!r.ok) return back("error=" + encodeURIComponent(r.error));
  return back("refunded=" + encodeURIComponent(`${r.amount.toLocaleString("fa-IR")} تومان بازپرداخت شد — اعلامیه‌ی ${r.creditNote}`));
}

/** نرخ مالیات و مشخصات فروشنده‌ی فاکتور (فقط مدیر کل) */
export async function saveInvoiceSettingsAction(formData: FormData) {
  const admin = await requirePlatformAdmin();
  await saveInvoiceSettings({
    taxPercent: clampTaxPercent(formData.get("taxPercent")),
    sellerName: String(formData.get("sellerName") || ""),
    economicCode: String(formData.get("economicCode") || ""),
    nationalId: String(formData.get("nationalId") || ""),
    address: String(formData.get("address") || ""),
    phone: String(formData.get("phone") || ""),
    footerNote: String(formData.get("footerNote") || ""),
  });
  await logAudit({ action: "settings.updated", userId: admin.id, detail: "تنظیمات فاکتور و مالیات" }).catch(() => undefined);
  revalidatePath("/platform/finance");
  return back("saved=1");
}
