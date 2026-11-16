import { DEFAULT_OPTIONS, type MergeMapping, type MergeOptions, checkRow, renderMerge, renderPlain, rowValues } from "../pure";
import { type PlanItem, buildSchedule, parseAmount, withScheduleBlock } from "@/modules/contract-pay/schedule";
import { mergeBatches, mergeRows } from "@/db/schema";
import { normalizeTags } from "@/modules/contracts/service";

export class MergeError extends Error {}
export type Batch = typeof mergeBatches.$inferSelect;
export type MergeRow = typeof mergeRows.$inferSelect;
const parseJson = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
export const batchMapping = (b: Batch): MergeMapping => parseJson<MergeMapping>(b.mapping, { roles: { name: "", mobile: "", amount: "", deposit: "", count: "" }, vars: {} });
export const batchOptions = (b: Batch): MergeOptions => ({ ...DEFAULT_OPTIONS, ...parseJson<Partial<MergeOptions>>(b.options, {}), plan: { ...DEFAULT_OPTIONS.plan, ...(parseJson<Partial<MergeOptions>>(b.options, {}).plan ?? {}) } });
export const batchHeaders = (b: Batch): string[] => parseJson<string[]>(b.headers, []);
export const rowData = (r: MergeRow): Record<string, string> => parseJson<Record<string, string>>(r.data, {});
export function sanitizeConfig(raw: { mapping: MergeMapping; options: Partial<MergeOptions> }, headers: string[]): { mapping: MergeMapping; options: MergeOptions } {
  const ok = (h: unknown) => (typeof h === "string" && headers.includes(h) ? h : "");
  const r = raw.mapping?.roles ?? ({} as MergeMapping["roles"]);
  const mapping: MergeMapping = { roles: { name: ok(r.name), mobile: ok(r.mobile), amount: ok(r.amount), deposit: ok(r.deposit), count: ok(r.count) }, vars: {} };
  for (const [k, v] of Object.entries(raw.mapping?.vars ?? {})) if (k.length <= 60) mapping.vars[k] = ok(v);
  const o = raw.options ?? {};
  const p = o.plan ?? DEFAULT_OPTIONS.plan;
  const num = (n: unknown, d: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(Number(n)) ? Math.floor(Number(n)) : d));
  const options: MergeOptions = {
    contractTitle: String(o.contractTitle ?? "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 160),
    signerLabel: String(o.signerLabel ?? "امضاکننده").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 40) || "امضاکننده",
    expiryDays: o.expiryDays === null || o.expiryDays === undefined || Number(o.expiryDays) <= 0 ? null : num(o.expiryDays, 14, 1, 365),
    tags: normalizeTags(String(o.tags ?? "")),
    skipDuplicates: o.skipDuplicates !== false,
    plan: { enabled: !!p.enabled, depositPercent: num(p.depositPercent, 30, 0, 90), count: num(p.count, 3, 0, 36), intervalDays: num(p.intervalDays, 30, 1, 365), gateDeposit: p.gateDeposit !== false },
  };
  return { mapping, options };
}
type Resolved = { ok: true; name: string; mobile: string; title: string; body: string; amount: number | null; items: PlanItem[] | null } | { ok: false; error: string };
/** تبدیل یک ردیف خام به سند شخصی‌سازی‌شده (متن، عنوان، برنامه‌ی پرداخت)؛ مشترک بین اعتبارسنجی و ارسال */
export function resolveRow(batch: Pick<Batch, "bodyHtml" | "contractTitle">, data: Record<string, string>, mapping: MergeMapping, options: MergeOptions, render = true): Resolved {
  const chk = checkRow(data, mapping);
  if (!chk.ok) return chk;
  let amount: number | null = null;
  if (mapping.roles.amount && (data[mapping.roles.amount] ?? "").trim() !== "") {
    amount = parseAmount(data[mapping.roles.amount]);
    if (amount === null) return { ok: false, error: `مبلغ «${data[mapping.roles.amount].slice(0, 20)}» معتبر نیست` };
  }
  let items: PlanItem[] | null = null;
  if (options.plan.enabled) {
    if (amount === null) return { ok: false, error: "برای برنامه‌ی پرداخت، مبلغ هر ردیف لازم است" };
    const dep = mapping.roles.deposit && (data[mapping.roles.deposit] ?? "").trim() !== "" ? parseAmount(data[mapping.roles.deposit]) : undefined;
    if (dep === null) return { ok: false, error: "مبلغ بیعانه معتبر نیست" };
    const cnt = mapping.roles.count && (data[mapping.roles.count] ?? "").trim() !== "" ? Number(parseAmount(data[mapping.roles.count])) : undefined;
    if (cnt !== undefined && (!Number.isInteger(cnt) || cnt > 36)) return { ok: false, error: "تعداد اقساط معتبر نیست" };
    const s = buildSchedule({ total: amount, depositAmount: dep, depositPercent: dep === undefined ? options.plan.depositPercent : 0, count: cnt ?? options.plan.count, intervalDays: options.plan.intervalDays, gateDeposit: options.plan.gateDeposit });
    if (!s.ok) return { ok: false, error: s.error };
    items = s.items;
  }
  if (!render) return { ok: true, name: chk.name, mobile: chk.mobile, title: "", body: "", amount, items };
  const values = rowValues(data, mapping, { name: chk.name, mobile: chk.mobile, amount });
  const title = (renderPlain(options.contractTitle || batch.contractTitle, values) || batch.contractTitle).slice(0, 160);
  const body = withScheduleBlock(renderMerge(batch.bodyHtml, values), items);
  return { ok: true, name: chk.name, mobile: chk.mobile, title, body, amount, items };
}
