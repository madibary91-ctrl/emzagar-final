import { rateLimit } from "@/lib/rate-limit";
import { fail, getStaff, json, sameOriginOk, staffConversation } from "@/modules/chat/actor";
import { parseQueue } from "@/modules/chat/api";
import { ChatError, markRead, setTyping, staffClaim, staffClose, staffReopen, staffSend, staffToTicket } from "@/modules/chat/service";
import { logAudit } from "@/modules/audit/service";

export const dynamic = "force-dynamic";

/** کنش‌های پشتیبان: send | note | typing | read | claim | release | close | reopen | ticket */
export async function POST(req: Request) {
  try {
    if (!(await sameOriginOk())) throw new ChatError("origin", "درخواست نامعتبر است", 403);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new ChatError("bad_body", "درخواست نامعتبر است");
    const staff = await getStaff(parseQueue(typeof body.queue === "string" ? body.queue : null));
    if (!staff) return json({ error: "forbidden", message: "دسترسی ندارید" }, 403);
    const conv = await staffConversation(staff, String(body.code ?? ""));
    if (!conv) throw new ChatError("not_found", "گفتگو یافت نشد", 404);
    if (!rateLimit(`chat:staff:${staff.userId}`, 240, 60_000).ok) throw new ChatError("rate", "درخواست‌ها بیش از حد است", 429);
    const action = String(body.action ?? "");
    const clientId = typeof body.clientId === "string" ? body.clientId : null;

    if (action === "send" || action === "note") {
      const msg = await staffSend(staff, conv, { text: String(body.text ?? ""), clientId, internal: action === "note" });
      return json({ ok: true, message: msg });
    }
    if (action === "typing") await setTyping(conv, "staff");
    else if (action === "read") await markRead(conv, "staff");
    else if (action === "claim") await staffClaim(staff, conv, "take");
    else if (action === "release") await staffClaim(staff, conv, "release");
    else if (action === "close") await staffClose(staff, conv);
    else if (action === "reopen") await staffReopen(staff, conv);
    else if (action === "ticket") {
      const number = await staffToTicket(staff, conv);
      await logAudit({ workspaceId: staff.workspaceId || undefined, userId: staff.userId, action: "chat.ticket", detail: `گفتگوی ${conv.code} → تیکت ${number}` }).catch(() => undefined);
      return json({ ok: true, ticketNumber: number });
    } else throw new ChatError("bad_action", "کنش نامعتبر است");
    return json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
