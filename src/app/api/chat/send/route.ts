import { conversationView, limitSend, parseWidgetContext } from "@/modules/chat/api";
import { fail, getRequester, json, sameOriginOk } from "@/modules/chat/actor";
import { ChatError, findConversation, requesterSend, resolveContext } from "@/modules/chat/service";

export const dynamic = "force-dynamic";

/** ارسال پیام مشتری؛ اگر گفتگویی نباشد ساخته می‌شود */
export async function POST(req: Request) {
  try {
    if (!(await sameOriginOk())) throw new ChatError("origin", "درخواست نامعتبر است", 403);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new ChatError("bad_body", "درخواست نامعتبر است");
    const input = parseWidgetContext(body);
    const who = await getRequester(input.kind, true);
    if (!who) throw new ChatError("auth", "برای گفتگو وارد حساب خود شوید", 401);
    const ctx = await resolveContext(who, input, typeof body.name === "string" ? body.name : undefined);
    const existing = await findConversation(who, ctx.key);
    await limitSend(who, !existing || existing.status === "closed");
    const r = await requesterSend(who, ctx, {
      text: String(body.text ?? ""),
      clientId: typeof body.clientId === "string" ? body.clientId : null,
      pagePath: typeof body.path === "string" ? body.path : "",
    });
    return json({ ok: true, created: r.created, message: r.msg, conversation: await conversationView(r.conv) });
  } catch (e) {
    return fail(e);
  }
}
