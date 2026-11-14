import { CTRL } from "./core";
import { type PreparedFields, prepareFieldValues } from "@/modules/fields/service";
import { fa } from "@/lib/jalali";
import { fieldKey } from "../placement";
import { getSource, listDocFields } from "./sources";

export interface FillableField {
  key: string;
  kind: string;
  label: string;
  required: boolean;
}
/** مقدار فیلدهای یک امضاکننده را (از ورودی نامطمئن) اعتبارسنجی می‌کند؛ نام/تاریخ سمت سرور ساخته می‌شوند */
export function prepareDocValues(fields: FillableField[], userName: string, input: Record<string, unknown> | undefined): PreparedFields | { ok: false; error: string } {
  const rows: PreparedFields["rows"] = [];
  for (const f of fields) {
    if (f.kind === "signature") continue;
    const label = f.label || (f.kind === "name" ? "نام" : f.kind === "date" ? "تاریخ" : f.kind === "checkbox" ? "تأیید" : "متن");
    let value = "";
    if (f.kind === "name") value = String(userName ?? "").slice(0, 100);
    else if (f.kind === "date") value = fa(new Date());
    else if (f.kind === "checkbox") value = ["1", "true", "on"].includes(String(input?.[f.key] ?? "")) ? "1" : "";
    else value = String(input?.[f.key] ?? "").replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!value && f.required) return { ok: false, error: f.kind === "checkbox" ? `تیک «${label}» الزامی است` : `فیلد «${label}» را پر کنید` };
    if (value) rows.push({ key: f.key, label, type: f.kind, value });
  }
  return { ok: true, rows };
}
/**
 * اگر قرارداد روی فایل بارگذاری‌شده است، فیلدهای «همین امضاکننده» را اعتبارسنجی می‌کند؛
 * وگرنه رفتار قبلی (فیلدهای توکنی داخل متن) بدون تغییر اجرا می‌شود.
 */
export async function prepareSigningFields(
  contract: { id: number; bodyHtml: string },
  allSigners: { position: number }[],
  signer: { position: number; userName?: string | null },
  input: Record<string, unknown> | undefined,
): Promise<PreparedFields | { ok: false; error: string }> {
  const src = await getSource(contract.id);
  if (!src) return prepareFieldValues(contract.bodyHtml, allSigners, signer, input);
  const mine = (await listDocFields(contract.id)).filter((f) => f.signerPosition === signer.position).map((f) => ({ key: fieldKey(f.id), kind: f.kind, label: f.label, required: f.required }));
  return prepareDocValues(mine, String(signer.userName ?? ""), input);
}
