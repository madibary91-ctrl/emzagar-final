import { rateLimit } from "@/lib/rate-limit";
import { fail, json, requesterConversation, sameOriginOk } from "@/modules/chat/actor";
import { ChatError, closeByRequester, markRead, rate, setTyping } from "@/modules/chat/service";

export const dynamic = "force-dynamic";

/** کنش‌های سبک مشتری روی گفتگوی خودش: typing | read | close | rate */
export async function POST(req: Request) {
  try {
    if (!(await sameOriginOk())) throw new ChatError("origin", "درخواست نامعتبر است", 403);
    const body = (await req.json().catch(() => null)) as { code?: unknown; action?: unknown; rating?: unknown } | null;
    const code = String(body?.code ?? "");
    const conv = await requesterConversation(code);
    if (!conv) throw new ChatError("not_found", "گفتگو یافت نشد", 404);
    const action = String(body?.action ?? "");
    if (!rateLimit(`chat:act:${conv.id}`, 120, 60_000).ok) throw new ChatError("rate", "درخواست‌ها بیش از حد است", 429);
    if (action === "typing") await setTyping(conv, "requester");
    else if (action === "read") await markRead(conv, "requester");
    else if (action === "close") await closeByRequester(conv);
    else if (action === "rate") await rate(conv, Number(body?.rating));
    else throw new ChatError("bad_action", "کنش نامعتبر است");
    return json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
