import { CONTRACT_PLAN_PREFIX } from "../fulfill";
import { type Installment, PayError, dueDate, listInstallments, newCode } from "./core";
import { type PlanItem, withScheduleBlock } from "../schedule";
import { and, eq, inArray, sql } from "drizzle-orm";
import { contractInstallments, contractSigners, contracts, payments } from "@/db/schema";
import { db, withTransaction } from "@/db";
import { invalidateApprovals } from "@/modules/contracts/approvals";
import { logAudit } from "@/modules/audit/service";
import { sanitizeHtml } from "@/lib/html";
import { snapshotRevision } from "@/modules/contracts/revisions";

/** درج برنامه‌ی پرداخت (بدون اعتبارسنجی وضعیت قرارداد). داخل تراکنش صدور هم قابل‌استفاده است. */
export async function insertPlan(contractId: number, workspaceId: number, items: PlanItem[]): Promise<void> {
  if (items.length === 0) return;
  await db.insert(contractInstallments).values(
    items.map((it, i) => ({
      workspaceId,
      contractId,
      position: i + 1,
      title: it.title,
      kind: it.kind,
      amount: it.amount,
      dueAt: dueDate(it.dueAt),
      payerPosition: it.payerPosition,
      gate: it.gate,
      payCode: newCode(),
    })),
  );
}
/**
 * ثبت/جایگزینی برنامه‌ی پرداخت یک قرارداد موجود.
 * فقط تا پیش از «اولین امضا» و «اولین پرداخت» مجاز است، چون جدول برنامه بخشی از متن امضاشده (و هش سند) است.
 */
export async function setPlan(p: { contractId: number; workspaceId: number; actorId: number; items: PlanItem[] }): Promise<void> {
  await withTransaction(async () => {
    const [c] = await db.select().from(contracts).where(and(eq(contracts.id, p.contractId), eq(contracts.workspaceId, p.workspaceId))).for("update");
    if (!c) throw new PayError("قرارداد یافت نشد");
    if (c.status !== "draft" && c.status !== "sent") throw new PayError("برنامه‌ی پرداخت فقط برای پیش‌نویس یا قرارداد در انتظار امضا قابل تغییر است");
    const signers = await db.select({ status: contractSigners.status }).from(contractSigners).where(eq(contractSigners.contractId, c.id));
    if (signers.some((s) => s.status !== "pending")) throw new PayError("پس از شروع امضا، برنامه‌ی پرداخت قابل تغییر نیست (برای تغییر، الحاقیه ثبت کنید)");
    const existing = await listInstallments(c.id);
    if (existing.some((e) => e.status === "paid")) throw new PayError("برای این قرارداد پرداخت ثبت شده و برنامه قابل تغییر نیست");
    // پرداخت درگاهِ در جریان نباید با حذف قسط یتیم شود
    const pend = existing.length ? await db.select({ id: payments.id }).from(payments).where(and(eq(payments.workspaceId, p.workspaceId), eq(payments.status, "pending"), inArray(payments.plan, existing.map((e) => `${CONTRACT_PLAN_PREFIX}${e.id}`)), sql`${payments.createdAt} > now() - interval '30 minutes'`)).limit(1) : [];
    if (pend.length) throw new PayError("یک پرداخت در جریان است؛ چند دقیقه بعد دوباره تلاش کنید");

    await db.delete(contractInstallments).where(eq(contractInstallments.contractId, c.id));
    await insertPlan(c.id, p.workspaceId, p.items);
    if (p.items.length > 0 && p.items.some((i) => i.gate === "before_sign") && signers.length === 0) throw new PayError("امضاکننده‌ای برای قرارداد ثبت نشده است");

    // جدول در متن قرارداد (بخشی از سند و هش) درج/جایگزین می‌شود
    const body = sanitizeHtml(withScheduleBlock(c.bodyHtml, p.items.length ? p.items : null));
    const total = p.items.reduce((s, i) => s + i.amount, 0);
    await db.update(contracts).set({ bodyHtml: body, ...(total > 0 ? { contractValue: Math.min(total, 2_000_000_000) } : {}) }).where(eq(contracts.id, c.id));
    const created = await snapshotRevision(c.id, { title: c.title, bodyHtml: body, kind: c.status === "draft" ? "draft" : "publish", note: "برنامه‌ی پرداخت", userId: p.actorId });
    if (created && c.status === "draft") await invalidateApprovals(c.id, p.actorId, "تغییر برنامه‌ی پرداخت");
    await logAudit({ action: "pay.plan_saved", contractId: c.id, workspaceId: p.workspaceId, userId: p.actorId, detail: p.items.length ? `${p.items.length} ردیف — مجموع ${total.toLocaleString("fa-IR")} تومان` : "برنامه‌ی پرداخت حذف شد" });
  });
}
export type PlanSummary = { total: number; paid: number; remaining: number; count: number; paidCount: number; nextDue: Date | null };
export function summarize(rows: Installment[]): PlanSummary {
  const live = rows.filter((r) => r.status !== "cancelled");
  const paid = live.filter((r) => r.status === "paid");
  const pend = live.filter((r) => r.status === "pending");
  const dues = pend.map((r) => r.dueAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime());
  return { total: live.reduce((s, r) => s + r.amount, 0), paid: paid.reduce((s, r) => s + r.amount, 0), remaining: pend.reduce((s, r) => s + r.amount, 0), count: live.length, paidCount: paid.length, nextDue: dues[0] ?? null };
}
