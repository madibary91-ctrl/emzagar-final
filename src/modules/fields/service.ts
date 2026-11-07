import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contractFieldValues } from "@/db/schema";
import { defsForSigner, parseFieldDefs, renderFieldTokens, validateFieldValue, type FieldDef } from "./index";

export type FieldRow = typeof contractFieldValues.$inferSelect;

export async function getFieldValues(contractId: number): Promise<FieldRow[]> {
  return db.select().from(contractFieldValues).where(eq(contractFieldValues.contractId, contractId));
}

export async function getFieldValueMap(contractId: number): Promise<Map<string, string>> {
  return new Map((await getFieldValues(contractId)).map((r) => [r.key, r.value]));
}

/** متن قرارداد با مقدارهای پرشده (برای نمایش وب یا PDF)؛ ورودی باید sanitize‌شده باشد */
export async function renderContractBody(contractId: number, sanitizedHtml: string, mode: "web" | "pdf" = "web"): Promise<string> {
  if (!sanitizedHtml.includes("{{")) return sanitizedHtml;
  return renderFieldTokens(sanitizedHtml, await getFieldValueMap(contractId), mode);
}

export interface PreparedFields {
  ok: true;
  rows: { key: string; label: string; type: string; value: string }[];
}

/**
 * فیلدهای امضاکننده را پیش از ثبت امضا اعتبارسنجی می‌کند (برای فیلدهای اجباری و نوع‌ها).
 * خروجی `rows` همان چیزی است که هنگام امضا ذخیره می‌شود.
 */
export function prepareFieldValues(
  bodyHtml: string,
  signers: { position: number }[],
  signer: { position: number },
  input: Record<string, unknown> | undefined,
): PreparedFields | { ok: false; error: string } {
  const defs = parseFieldDefs(bodyHtml);
  const mine = defsForSigner(defs, signers.map((s) => s.position), signer.position);
  const rows: PreparedFields["rows"] = [];
  for (const d of mine) {
    const r = validateFieldValue(d, input?.[d.key]);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.value) rows.push({ key: d.key, label: d.label, type: d.type, value: r.value });
  }
  return { ok: true, rows };
}

export async function saveFieldValues(contractId: number, signerId: number, rows: PreparedFields["rows"]) {
  if (rows.length === 0) return;
  await db
    .insert(contractFieldValues)
    .values(rows.map((r) => ({ contractId, signerId, key: r.key, label: r.label, type: r.type, value: r.value })))
    .onConflictDoNothing();
}

/** فیلدهای نوبت فعلی برای نمایش فرم در صفحه‌ی امضا */
export function fieldsToFill(bodyHtml: string, signers: { position: number }[], signer: { position: number }): FieldDef[] {
  return defsForSigner(parseFieldDefs(bodyHtml), signers.map((s) => s.position), signer.position);
}
