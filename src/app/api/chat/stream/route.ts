import { fail, json, requesterConversation } from "@/modules/chat/actor";
import { conversationView } from "@/modules/chat/api";
import { getConversation, listMessages, requesterState, touchRequester } from "@/modules/chat/service";
import { eventStream } from "@/modules/chat/sse";

export const dynamic = "force-dynamic";

/**
 * جریان زنده‌ی گفتگو برای مشتری (SSE): پیام‌های تازه (event: msg) و وضعیت (event: state).
 * احراز هویت یک‌بار در لحظه‌ی اتصال انجام می‌شود؛ ادامه‌ی جریان فقط همان گفتگو را می‌خواند.
 * after: آخرین شناسه‌ی پیام دریافتی (هنگام اتصال مجدد، مرورگر Last-Event-ID را هم می‌فرستد).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("c") || "";
    const conv = await requesterConversation(code);
    if (!conv) return json({ error: "not_found", message: "گفتگو یافت نشد" }, 404);
    let last = Number(req.headers.get("last-event-id") || url.searchParams.get("after") || 0) || 0;
    let sig = "";
    let touched = 0;
    return eventStream(req, {
      wake: conv.code,
      intervalMs: 2500,
      run: async (emit) => {
        const cur = await getConversation(conv.code);
        if (!cur) return false;
        if (Date.now() - touched > 20_000) {
          touched = Date.now();
          await touchRequester(cur.id);
        }
        const fresh = await listMessages(cur.id, { after: last, staff: false });
        for (const m of fresh) {
          emit("msg", m, m.id);
          last = Math.max(last, m.id);
        }
        const state = await requesterState(cur);
        const s = JSON.stringify(state);
        if (s !== sig) {
          sig = s;
          emit("state", state);
        }
      },
    });
  } catch (e) {
    return fail(e);
  }
}

/** پولینگ جایگزین (اگر SSE در شبکه‌ی کاربر مسدود باشد): پیام‌های جدیدتر از after + وضعیت */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { c?: unknown; after?: unknown } | null;
    const conv = await requesterConversation(String(body?.c ?? ""));
    if (!conv) return json({ error: "not_found", message: "گفتگو یافت نشد" }, 404);
    const after = Number(body?.after) || 0;
    if (after <= 0) return json(await conversationView(conv));
    const [messages, state] = await Promise.all([listMessages(conv.id, { after, staff: false }), requesterState(conv)]);
    return json({ code: conv.code, queue: conv.queue, state, messages });
  } catch (e) {
    return fail(e);
  }
}
