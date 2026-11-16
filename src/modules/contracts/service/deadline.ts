import { and, eq } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { contracts, contractSigners } from "@/db/schema";
import { logAudit } from "@/modules/audit/service";
import { fa } from "@/lib/jalali";
import { notifyTeam } from "@/modules/inbox/service";
import { currentStageSigners } from "@/modules/signing/stages";
import { notifySigner } from "@/modules/signing/links";

const DAY = 86_400_000;
export const MAX_EXTEND_DAYS = 365;

export class DeadlineError extends Error {}

export interface ExtendResult {
  /** true = قراردادِ «منقضی‌شده» دوباره باز شد (و لینک تازه برای امضاکننده‌ی فعلی رفت) */
  reopened: boolean;
  expiresAt: Date;
}

/**
 * مهلت جدید:
 *  - قرارداد در انتظار امضا و هنوز در مهلت: «از پایان مهلت فعلی» + N روز (نه از امروز؛ وگرنه تمدید ۷ روزه‌ی قراردادی که ۳۰ روز مهلت دارد آن را کوتاه می‌کرد)
 *  - مهلت‌گذشته یا منقضی: از «همین الان» + N روز
 */
export function nextDeadline(c: { status: string; expiresAt: Date | null }, days: number, now = new Date()): Date {
  const base = c.status === "sent" && c.expiresAt && c.expiresAt.getTime() > now.getTime() ? c.expiresAt.getTime() : now.getTime();
  return new Date(base + days * DAY);
}

export function parseExtendDays(raw: unknown): number | null {
  const s = String(raw ?? "")
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_EXTEND_DAYS ? n : null;
}

/**
 * تمدید مهلت امضا یا بازگشایی قرارداد منقضی‌شده.
 * پیش‌تر قرارداد منقضی‌شده بن‌بست بود: تنها راه «صدور مجدد» با شماره‌ی تازه و از نو انتشار بود و امضاهای ثبت‌شده‌ی همان قرارداد از دست می‌رفت.
 * اینجا همان قرارداد (با همان شماره و امضاهای ثبت‌شده) باز می‌شود؛ سهمیه‌ی ماهانه‌ی تازه‌ای مصرف نمی‌شود چون قبلاً یک‌بار مصرف شده است.
 */
export async function extendContractDeadline(id: number, actorId: number, workspaceId: number, days: number): Promise<ExtendResult> {
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXTEND_DAYS) throw new DeadlineError(`مدت تمدید باید بین ۱ تا ${MAX_EXTEND_DAYS} روز باشد`);

  const res = await withTransaction(async () => {
    const [c] = await db
      .select()
      .from(contracts)
      .where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId)))
      .for("update");
    if (!c) throw new DeadlineError("قرارداد یافت نشد");
    if (c.status !== "sent" && c.status !== "expired") throw new DeadlineError("فقط قرارداد در انتظار امضا یا منقضی‌شده قابل تمدید مهلت است");
    if (c.status === "sent" && !c.expiresAt) throw new DeadlineError("این قرارداد مهلت ندارد (نامحدود است)؛ تمدید لازم نیست");

    const signers = await db
      .select({ id: contractSigners.id, label: contractSigners.label, status: contractSigners.status, position: contractSigners.position, stage: contractSigners.stage })
      .from(contractSigners)
      .where(eq(contractSigners.contractId, id));
    if (signers.some((s) => s.status === "rejected")) throw new DeadlineError("یکی از طرف‌ها این قرارداد را رد کرده است؛ برای ادامه «صدور مجدد» کنید");
    const pending = signers.filter((s) => s.status === "pending");
    if (pending.length === 0) throw new DeadlineError("امضاکننده‌ی در انتظاری برای این قرارداد نمانده است");

    const expiresAt = nextDeadline(c, days);
    const reopened = c.status === "expired";
    // شرط status از رقابت با لغو/انقضای هم‌زمان جلوگیری می‌کند
    const updated = await db
      .update(contracts)
      .set({ status: "sent", expiresAt, ...(reopened ? { reminderCount: 0, lastReminderAt: null } : {}) })
      .where(and(eq(contracts.id, id), eq(contracts.status, c.status)))
      .returning({ id: contracts.id });
    if (updated.length === 0) throw new DeadlineError("وضعیت قرارداد هم‌زمان تغییر کرد؛ صفحه را تازه کنید");
    await logAudit({
      action: reopened ? "contract.reopened" : "contract.deadline_extended",
      contractId: id,
      userId: actorId,
      workspaceId,
      detail: `${c.number} — مهلت جدید: ${fa(expiresAt)} (${days} روز)`,
    });
    return { reopened, expiresAt, number: c.number, title: c.title, turns: currentStageSigners(pending) };
  });

  // کار شبکه‌ای فقط پس از commit: لینک امضای تازه (لینک‌های قدیمی هنگام انقضا باطل شده‌اند)
  if (res.reopened) {
    for (const t of res.turns) {
      await notifySigner(id, t.id, "reminder", { smsOverride: false }).catch((e) => console.error("[deadline:notify]", e));
    }
  }
  await notifyTeam(workspaceId, {
    kind: "info",
    title: res.reopened ? `قرارداد ${res.number} دوباره باز شد` : `مهلت قرارداد ${res.number} تمدید شد`,
    body: `مهلت امضای «${res.title}» تا ${fa(res.expiresAt)} است.`,
    href: `/contracts/${id}`,
  });
  return { reopened: res.reopened, expiresAt: res.expiresAt };
}
