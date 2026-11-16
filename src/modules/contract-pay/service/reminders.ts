import { and, eq, lte, sql } from "drizzle-orm";
import { contractInstallments, contracts, users } from "@/db/schema";
import { db } from "@/db";
import { escapeHtml } from "@/lib/html";
import { fa } from "@/lib/jalali";
import { getAllSettings } from "@/modules/settings/service";
import { getOrigin } from "@/lib/request";
import { getPayContext } from "./payment";
import { notifyTeam } from "@/modules/inbox/service";
import { sendMail } from "@/modules/mail";
import { sendSms } from "@/modules/sms";

/* ───────────────────────────── یادآوری خودکار اقساط ───────────────────────────── */
const REMIND_EVERY_MS = 3 * 86400_000;
const MAX_REMINDERS = 6;
export async function runInstallmentReminders(workspaceId?: number): Promise<number> {
  const horizon = new Date(Date.now() + 2 * 86400_000);
  const cutoff = new Date(Date.now() - REMIND_EVERY_MS);
  const rows = await db
    .select({ i: contractInstallments, c: contracts })
    .from(contractInstallments)
    .innerJoin(contracts, eq(contracts.id, contractInstallments.contractId))
    .where(
      and(
        eq(contractInstallments.status, "pending"),
        eq(contracts.status, "signed"),
        lte(contractInstallments.dueAt, horizon),
        sql`${contractInstallments.reminderCount} < ${MAX_REMINDERS}`,
        sql`(${contractInstallments.lastReminderAt} is null or ${contractInstallments.lastReminderAt} < ${cutoff})`,
        ...(workspaceId ? [eq(contractInstallments.workspaceId, workspaceId)] : []),
      ),
    )
    .limit(200);
  let sent = 0;
  for (const { i, c } of rows) {
    try {
      // «ادعا»ی اتمی: دو اجرای هم‌زمان زمان‌بند یک یادآوری تکراری نمی‌فرستند
      const claim = await db
        .update(contractInstallments)
        .set({ reminderCount: sql`${contractInstallments.reminderCount} + 1`, lastReminderAt: new Date() })
        .where(and(eq(contractInstallments.id, i.id), eq(contractInstallments.status, "pending"), sql`(${contractInstallments.lastReminderAt} is null or ${contractInstallments.lastReminderAt} < ${cutoff})`))
        .returning({ id: contractInstallments.id });
      if (claim.length === 0) continue;
      const ctx = await getPayContext(i.payCode);
      const payer = ctx?.payer;
      if (!payer) continue;
      const cfg = await getAllSettings(c.workspaceId);
      const base = (cfg.app_url || (await getOrigin().catch(() => ""))).replace(/\/+$/, "");
      const url = `${base}/pay/${i.payCode}`;
      const overdue = !!i.dueAt && i.dueAt.getTime() < Date.now() - 86400_000;
      const amount = i.amount.toLocaleString("fa-IR");
      if (/^09\d{9}$/.test(payer.mobile)) {
        await sendSms({ to: payer.mobile, text: `${cfg.site_name}: ${overdue ? "سررسید گذشته" : "یادآوری پرداخت"} — ${i.title} قرارداد ${c.number} (${amount} تومان)\n${url}` }, c.id).catch(() => undefined);
      }
      const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, payer.id));
      if (u?.email && !u.email.endsWith(".invalid")) {
        await sendMail({
          to: u.email,
          subject: `${overdue ? "سررسید گذشته" : "یادآوری پرداخت"}: ${i.title} — ${c.number}`,
          html: `<div dir="rtl" style="font-family:Tahoma,sans-serif;line-height:2"><p>${escapeHtml(payer.name)} عزیز، ${overdue ? "سررسید" : "موعد"} پرداخت «${escapeHtml(i.title)}» قرارداد «${escapeHtml(c.title)}» ${i.dueAt ? `(${fa(i.dueAt)})` : ""} به مبلغ ${amount} تومان رسیده است.</p><p><a href="${url}" style="display:inline-block;background:#102c31;color:#41e4ad;padding:12px 26px;border-radius:12px;text-decoration:none;font-weight:bold">پرداخت آنلاین</a></p></div>`,
          contractId: c.id,
        }).catch(() => undefined);
      }
      if (i.reminderCount === 0 && overdue) {
        await notifyTeam(c.workspaceId, { kind: "warning", title: `قسط سررسیدگذشته: ${c.number}`, body: `${i.title} — ${amount} تومان — ${payer.name}`, href: `/contracts/${c.id}#pay` }, [c.createdBy], ["owner", "admin", "member"]).catch(() => 0);
      }
      sent++;
    } catch (e) {
      console.error("[pay:reminder]", e);
    }
  }
  return sent;
}
