import { fail, getStaff, json, staffConversation } from "@/modules/chat/actor";
import { parseFilter, parseQueue } from "@/modules/chat/api";
import { agentScope, agentsOnline, getConversation, listMessages, staffList, touchAgent } from "@/modules/chat/service";
import { TYPING_MS } from "@/modules/chat/meta";
import { eventStream } from "@/modules/chat/sse";

export const dynamic = "force-dynamic";

/**
 * جریان زنده‌ی کنسول پشتیبان (SSE):
 *  - event: inbox  → فهرست و شمارنده‌ها (هر وقت تغییر کند)
 *  - event: msg    → پیام تازه‌ی گفتگوی بازشده (c=کد گفتگو)
 *  - event: thread → وضعیت گفتگوی بازشده (تایپ، دیده‌شدن، مسئول، بسته/باز)
 * هر اتصال، ضربان «آنلاین بودن پشتیبان» را هم تازه می‌کند (به مشتری «آنلاین» نشان داده می‌شود).
 */
export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const staff = await getStaff(parseQueue(sp.get("queue")));
    if (!staff) return json({ error: "forbidden", message: "دسترسی ندارید" }, 403);
    const code = sp.get("c") || "";
    const open = code ? await staffConversation(staff, code) : null;
    if (code && !open) return json({ error: "not_found", message: "گفتگو یافت نشد" }, 404);
    const filter = parseFilter(sp.get("filter"));
    const q = (sp.get("q") || "").trim().slice(0, 80) || undefined;
    let last = Number(req.headers.get("last-event-id") || sp.get("after") || 0) || 0;
    let inboxSig = "";
    let threadSig = "";
    let touched = 0;
    return eventStream(req, {
      wake: null,
      intervalMs: open ? 2500 : 4000,
      run: async (emit) => {
        if (Date.now() - touched > 20_000) {
          touched = Date.now();
          await touchAgent(staff.userId, agentScope(staff.queue, staff.workspaceId));
        }
        const list = await staffList(staff, { filter, q });
        const online = await agentsOnline(staff.queue, staff.workspaceId);
        const payload = { ...list, online };
        const s = JSON.stringify(payload);
        if (s !== inboxSig) {
          inboxSig = s;
          emit("inbox", payload);
        }
        if (!open) return;
        const cur = await getConversation(open.code);
        if (!cur) return false;
        const fresh = await listMessages(cur.id, { after: last, staff: true });
        for (const m of fresh) {
          emit("msg", m, m.id);
          last = Math.max(last, m.id);
        }
        const st = {
          status: cur.status,
          assigneeId: cur.assigneeId,
          requesterTyping: !!cur.requesterTypingAt && Date.now() - cur.requesterTypingAt.getTime() < TYPING_MS,
          requesterOnline: !!cur.requesterSeenAt && Date.now() - cur.requesterSeenAt.getTime() < 45_000,
          requesterReadId: cur.requesterReadId,
          rating: cur.rating,
          hasTicket: !!cur.ticketId,
          unread: cur.unreadStaff,
        };
        const ts = JSON.stringify(st);
        if (ts !== threadSig) {
          threadSig = ts;
          emit("thread", st);
        }
      },
    });
  } catch (e) {
    return fail(e);
  }
}
