"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { ticketMessages, tickets } from "@/db/schema";
import { requireUser } from "@/modules/auth/session";
import { getTeamContext } from "@/modules/tenancy/context";
import { requirePlatformAdmin, platformAdminEmails } from "@/modules/platform/admin";
import { rateLimit } from "@/lib/rate-limit";
import { escapeHtml } from "@/lib/html";
import { getOrigin } from "@/lib/request";
import { sendMail } from "@/modules/mail";
import { logAudit } from "@/modules/audit/service";
import { users } from "@/db/schema";
import { BODY_MAX, CATEGORIES, PRIORITIES, SUBJECT_MAX, isStatus } from "./meta";
import { createTicket } from "./service";

export type TicketFormState = { error?: string; ok?: boolean };

const clean = (v: FormDataEntryValue | null, max: number) => String(v ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);

/** ثبت تیکت جدید توسط هر کاربر واردشده */
export async function createTicketAction(_prev: TicketFormState, fd: FormData): Promise<TicketFormState> {
  const user = await requireUser();
  const rl = rateLimit(`ticket:new:${user.id}`, 5, 60 * 60_000);
  if (!rl.ok) return { error: "تعداد تیکت‌های ثبت‌شده در یک ساعت گذشته زیاد بود؛ کمی بعد دوباره تلاش کنید." };

  const subject = clean(fd.get("subject"), SUBJECT_MAX);
  const body = clean(fd.get("body"), BODY_MAX);
  const category = String(fd.get("category") || "general");
  const priority = String(fd.get("priority") || "normal");
  if (subject.length < 4) return { error: "موضوع تیکت را کمی کامل‌تر بنویسید (حداقل ۴ نویسه)" };
  if (body.length < 10) return { error: "شرح مشکل یا درخواست را کامل‌تر بنویسید (حداقل ۱۰ نویسه)" };
  if (!(category in CATEGORIES)) return { error: "دسته‌بندی نامعتبر است" };
  if (!(priority in PRIORITIES)) return { error: "اولویت نامعتبر است" };

  const team = await getTeamContext();
  const id = await createTicket({ userId: user.id, workspaceId: team?.workspaceId ?? 0, subject, category, priority, body });
  await logAudit({ action: "ticket.created", workspaceId: team?.workspaceId ?? 0, userId: user.id, detail: subject.slice(0, 80) });

  // اعلان به مدیران کل (در صورت ناموفق بودن ایمیل، ثبت تیکت مختل نمی‌شود)
  try {
    const link = `${await getOrigin()}/platform/tickets/${id}`;
    for (const to of await platformAdminEmails()) {
      await sendMail({
        to,
        workspaceId: 0,
        subject: `تیکت جدید: ${subject}`,
        html: `<div dir="rtl"><p>تیکت جدید از <b>${escapeHtml(user.name)}</b> (${escapeHtml(user.email)}) ثبت شد.</p><p>${escapeHtml(subject)}</p><p><a href="${link}">مشاهده و پاسخ</a></p></div>`,
      });
    }
  } catch {
    /* ignore */
  }
  revalidatePath("/support");
  redirect(`/support/${id}`);
}

/** پاسخ مشتری؛ اگر تیکت بسته بود دوباره باز می‌شود */
export async function customerReplyAction(_prev: TicketFormState, fd: FormData): Promise<TicketFormState> {
  const user = await requireUser();
  const id = Number(fd.get("ticketId"));
  const body = clean(fd.get("body"), BODY_MAX);
  if (!Number.isInteger(id)) return { error: "تیکت نامعتبر است" };
  if (body.length < 2) return { error: "متن پیام را بنویسید" };
  if (!rateLimit(`ticket:reply:${user.id}`, 20, 10 * 60_000).ok) return { error: "پیام‌های پشت‌سرهم زیاد بود؛ کمی صبر کنید." };

  const [t] = await db.select().from(tickets).where(and(eq(tickets.id, id), eq(tickets.userId, user.id)));
  if (!t) return { error: "تیکت پیدا نشد" };
  await db.insert(ticketMessages).values({ ticketId: id, userId: user.id, isStaff: false, body });
  await db.update(tickets).set({ status: "open", lastReplyBy: "customer", updatedAt: new Date(), closedAt: null }).where(eq(tickets.id, id));
  revalidatePath(`/support/${id}`);
  revalidatePath("/support");
  return { ok: true };
}

/** بستن تیکت توسط مشتری (با امتیاز اختیاری) */
export async function customerCloseAction(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("ticketId"));
  const r = Number(fd.get("rating"));
  if (!Number.isInteger(id)) return;
  const rating = Number.isInteger(r) && r >= 1 && r <= 5 ? r : null;
  await db
    .update(tickets)
    .set({ status: "closed", closedAt: new Date(), updatedAt: new Date(), ...(rating ? { rating } : {}) })
    .where(and(eq(tickets.id, id), eq(tickets.userId, user.id)));
  revalidatePath(`/support/${id}`);
  revalidatePath("/support");
}

/** پاسخ پشتیبان (یا یادداشت داخلی) + تغییر وضعیت */
export async function staffReplyAction(_prev: TicketFormState, fd: FormData): Promise<TicketFormState> {
  const admin = await requirePlatformAdmin();
  const id = Number(fd.get("ticketId"));
  const body = clean(fd.get("body"), BODY_MAX);
  const internal = fd.get("internal") === "1";
  const wanted = String(fd.get("status") || "keep");
  if (!Number.isInteger(id)) return { error: "تیکت نامعتبر است" };
  if (wanted !== "keep" && !isStatus(wanted)) return { error: "وضعیت نامعتبر است" };

  const [t] = await db.select().from(tickets).where(eq(tickets.id, id));
  if (!t) return { error: "تیکت پیدا نشد" };
  if (body.length === 0 && wanted === "keep") return { error: "متن پاسخ را بنویسید" };

  if (body) await db.insert(ticketMessages).values({ ticketId: id, userId: admin.id, isStaff: true, internal, body });
  const status = wanted !== "keep" ? wanted : !internal && body && t.status === "open" ? "in_progress" : t.status;
  await db
    .update(tickets)
    .set({
      status,
      updatedAt: new Date(),
      closedAt: status === "closed" ? new Date() : null,
      ...(body && !internal ? { lastReplyBy: "staff" } : {}),
    })
    .where(eq(tickets.id, id));
  await logAudit({ action: "ticket.replied", workspaceId: t.workspaceId, userId: admin.id, detail: `${t.number} · ${internal ? "یادداشت داخلی" : "پاسخ"} · ${status}` });

  if (body && !internal) {
    try {
      const [owner] = await db.select().from(users).where(eq(users.id, t.userId));
      if (owner) {
        const link = `${await getOrigin()}/support/${id}`;
        await sendMail({
          to: owner.email,
          workspaceId: 0,
          subject: `پاسخ جدید به تیکت ${t.number}`,
          html: `<div dir="rtl"><p>${escapeHtml(owner.name)} عزیز، به تیکت «${escapeHtml(t.subject)}» پاسخ داده شد.</p><p><a href="${link}">مشاهده‌ی پاسخ</a></p></div>`,
        });
      }
    } catch {
      /* ignore */
    }
  }
  revalidatePath(`/platform/tickets/${id}`);
  revalidatePath("/platform/tickets");
  return { ok: true };
}
