import { CONTRACT_PLAN_PREFIX, REFUND_ORPHAN, REFUND_REQUIRED } from "../fulfill";
import { type Installment, PAY_CODE_RE, PayError, listInstallments } from "./core";
import { and, eq } from "drizzle-orm";
import { contractInstallments, contractSigners, contracts, payments, users } from "@/db/schema";
import { db, withTransaction } from "@/db";
import { logAudit } from "@/modules/audit/service";
import { notifyTeam } from "@/modules/inbox/service";
import { payerSigner } from "../gate";
import { startPayment } from "@/modules/payments/service";

export async function getInstallmentByCode(code: string): Promise<Installment | null> {
  if (!PAY_CODE_RE.test(code)) return null;
  const [r] = await db.select().from(contractInstallments).where(eq(contractInstallments.payCode, code));
  return r ?? null;
}
export async function getPayContext(code: string) {
  const inst = await getInstallmentByCode(code);
  if (!inst) return null;
  const [c] = await db.select().from(contracts).where(eq(contracts.id, inst.contractId));
  if (!c) return null;
  const signers = await db.select({ id: contractSigners.id, position: contractSigners.position, userId: contractSigners.userId }).from(contractSigners).where(eq(contractSigners.contractId, c.id));
  const payer = payerSigner(signers, inst.payerPosition);
  const [u] = payer ? await db.select({ id: users.id, name: users.name, mobile: users.mobile }).from(users).where(eq(users.id, payer.userId)) : [];
  const all = await listInstallments(c.id);
  return { inst, contract: c, payer: u ?? null, all };
}
const PAYABLE_CONTRACT = ["sent", "signed"];
/** شروع پرداخت یک قسط با «کد پرداخت» (لینک غیرقابل‌حدس). مبلغ همیشه از دیتابیس خوانده می‌شود. */
export async function startInstallmentPayment(p: { code: string; gateway?: string; origin: string; returnPath?: string }): Promise<string> {
  const ctx = await getPayContext(p.code);
  if (!ctx) throw new PayError("لینک پرداخت نامعتبر است");
  const { inst, contract, payer } = ctx;
  if (inst.status === "paid") throw new PayError("این مورد قبلاً پرداخت شده است");
  if (inst.status !== "pending") throw new PayError("این مورد لغو شده است");
  if (!PAYABLE_CONTRACT.includes(contract.status)) throw new PayError("قرارداد فعال نیست و پرداخت آن ممکن نیست");
  if (!payer) throw new PayError("پرداخت‌کننده‌ی این مورد مشخص نیست");
  // مسیر بازگشت فقط به صفحه‌های داخلی خود سیستم
  const rp = p.returnPath && /^\/(sign\/[A-Za-z0-9_-]{43}|pay\/[A-Za-z0-9_-]{20,40}|contracts\/\d+)$/.test(p.returnPath) ? p.returnPath : `/pay/${inst.payCode}`;
  await db.update(contractInstallments).set({ returnPath: rp }).where(eq(contractInstallments.id, inst.id));
  // MX-02: ردیف پرداخت «زیر همان قفل ردیف قراردادی» درج می‌شود که setPlan می‌گیرد؛ یا پرداخت پیش از جایگزینی برنامه ثبت می‌شود
  // (و setPlan آن را در حال جریان می‌بیند و رد می‌کند) یا بعد از آن (و اینجا قسط حذف‌شده دیده می‌شود و پرداخت شروع نمی‌شود).
  const guardInsert = (insert: () => Promise<{ id: number }>) =>
    withTransaction(async () => {
      const [c] = await db.select({ status: contracts.status }).from(contracts).where(eq(contracts.id, contract.id)).for("no key update");
      const [cur] = await db.select({ status: contractInstallments.status }).from(contractInstallments).where(eq(contractInstallments.id, inst.id));
      if (!c || !cur) throw new PayError("برنامه‌ی پرداخت قرارداد تغییر کرده است؛ صفحه را دوباره باز کنید");
      if (cur.status !== "pending") throw new PayError(cur.status === "paid" ? "این مورد قبلاً پرداخت شده است" : "این مورد لغو شده است");
      if (!PAYABLE_CONTRACT.includes(c.status)) throw new PayError("قرارداد فعال نیست و پرداخت آن ممکن نیست");
      return insert();
    });
  return startPayment(
    {
      kind: "contract",
      workspaceId: contract.workspaceId,
      userId: payer.id,
      plan: `${CONTRACT_PLAN_PREFIX}${inst.id}`,
      amountToman: inst.amount,
      origin: p.origin,
      gateway: p.gateway,
      description: `${inst.title} — قرارداد ${contract.number}`,
      mobile: payer.mobile || undefined,
    },
    { guardInsert },
  );
}
export async function returnPathFor(plan: string): Promise<string> {
  const id = Number(plan.slice(CONTRACT_PLAN_PREFIX.length));
  if (!Number.isInteger(id)) return "/";
  const [r] = await db.select({ returnPath: contractInstallments.returnPath, code: contractInstallments.payCode }).from(contractInstallments).where(eq(contractInstallments.id, id));
  return r?.returnPath || (r ? `/pay/${r.code}` : "/");
}
/** پس از commit موفق پرداخت: ممیزی و اعلان تیم؛ شکست آن هرگز نتیجه‌ی پرداخت را تغییر نمی‌دهد */
export async function announceInstallmentPaid(pay: typeof payments.$inferSelect, refId: string): Promise<string> {
  const id = Number(pay.plan.slice(CONTRACT_PLAN_PREFIX.length));
  const [inst] = await db.select().from(contractInstallments).where(eq(contractInstallments.id, id));
  // پرداختی که اعمالش «بدون قسطِ قابل‌تخصیص» بوده (قسط حذف/جایگزین شده یا هم‌زمان دستی پرداخت شده) باید دیده شود، نه بی‌صدا «موفق» گزارش شود
  const [fresh] = await db.select({ error: payments.error }).from(payments).where(eq(payments.id, pay.id));
  const refund = fresh?.error && fresh.error.startsWith(REFUND_REQUIRED) ? fresh.error : null;
  if (refund) {
    const why = refund === REFUND_ORPHAN ? "ردیف قسط مربوط دیگر در برنامه‌ی پرداخت نیست (برنامه پس از شروع پرداخت تغییر کرده)" : "این قسط هم‌زمان با روش دیگری پرداخت شده بود";
    await logAudit({ action: "pay.refund_required", contractId: inst?.contractId ?? null, workspaceId: pay.workspaceId, userId: pay.userId, detail: `پرداخت #${pay.id} — ${pay.amount.toLocaleString("fa-IR")} تومان — ${pay.gateway} — کد پیگیری ${refId}: ${why}؛ بازپرداخت یا تهاتر دستی لازم است` }).catch(() => undefined);
    await notifyTeam(pay.workspaceId, { kind: "warning", title: "پرداخت بدون قسطِ قابل‌تخصیص دریافت شد", body: `${pay.amount.toLocaleString("fa-IR")} تومان — کد پیگیری ${refId}. ${why}. لطفاً بازپرداخت یا ثبت دستی را رسیدگی کنید.`, href: inst ? `/contracts/${inst.contractId}#pay` : "/admin" }, [], ["owner", "admin"]).catch(() => 0);
    return `پرداخت شما دریافت و ثبت شد (کد پیگیری ${refId})، اما ${refund === REFUND_ORPHAN ? "برنامه‌ی پرداخت قرارداد هم‌زمان تغییر کرده بود" : "این مورد هم‌زمان پرداخت شده بود"}. موضوع برای مسئول قرارداد گزارش شد و مبلغ بازگردانده یا تهاتر می‌شود.`;
  }
  if (inst) {
    const [c] = await db.select().from(contracts).where(eq(contracts.id, inst.contractId));
    await logAudit({ action: "pay.installment_paid", contractId: inst.contractId, workspaceId: pay.workspaceId, userId: pay.userId, detail: `${inst.title} — ${pay.amount.toLocaleString("fa-IR")} تومان — ${pay.gateway}${pay.test ? " (آزمایشی)" : ""} — کد پیگیری ${refId}` }).catch(() => undefined);
    await notifyTeam(pay.workspaceId, { kind: "success", title: `پرداخت دریافت شد: ${inst.title}`, body: `${pay.amount.toLocaleString("fa-IR")} تومان${c ? ` — قرارداد ${c.number}` : ""}`, href: `/contracts/${inst.contractId}#pay` }, [c?.createdBy], ["owner", "admin", "member"]).catch(() => 0);
  }
  return "پرداخت با موفقیت انجام شد. رسید شما ثبت گردید";
}
/** ثبت پرداخت دستی (کارت‌به‌کارت، نقد، چک) توسط مدیر */
export async function markManualPaid(p: { installmentId: number; workspaceId: number; actorId: number; note: string }): Promise<void> {
  const note = p.note.replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 200);
  const upd = await db
    .update(contractInstallments)
    .set({ status: "paid", method: "manual", paidAt: new Date(), note: note || null, refId: note ? note.slice(0, 40) : "manual" })
    .where(and(eq(contractInstallments.id, p.installmentId), eq(contractInstallments.workspaceId, p.workspaceId), eq(contractInstallments.status, "pending")))
    .returning();
  if (upd.length === 0) throw new PayError("این مورد پرداخت‌نشده نیست یا یافت نشد");
  await logAudit({ action: "pay.manual_paid", contractId: upd[0].contractId, workspaceId: p.workspaceId, userId: p.actorId, detail: `${upd[0].title} — ${upd[0].amount.toLocaleString("fa-IR")} تومان${note ? ` — ${note}` : ""}` });
}
/** لغو یک ردیف پرداخت‌نشده (مثلاً بخشودگی). پرداخت‌شده‌ها هرگز لغو نمی‌شوند. */
export async function cancelInstallment(p: { installmentId: number; workspaceId: number; actorId: number }): Promise<void> {
  const upd = await db
    .update(contractInstallments)
    .set({ status: "cancelled" })
    .where(and(eq(contractInstallments.id, p.installmentId), eq(contractInstallments.workspaceId, p.workspaceId), eq(contractInstallments.status, "pending")))
    .returning();
  if (upd.length === 0) throw new PayError("فقط ردیف پرداخت‌نشده قابل لغو است");
  await logAudit({ action: "pay.installment_cancelled", contractId: upd[0].contractId, workspaceId: p.workspaceId, userId: p.actorId, detail: `${upd[0].title} — ${upd[0].amount.toLocaleString("fa-IR")} تومان` });
}
