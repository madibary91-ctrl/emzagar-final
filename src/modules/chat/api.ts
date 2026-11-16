import { rateLimit } from "@/lib/rate-limit";
import { getRequestInfo } from "@/lib/request";
import { ChatError, agentsOnline, findConversation, listMessages, requesterState, resolveContext, type Conv, type Requester, type StaffFilter } from "./service";
import type { ChatBootstrap, ChatConversationView, ChatQueue, ChatWidgetContext } from "./meta";

const KINDS = ["panel", "sign", "pay", "site"] as const;

/** ورودی ویجت (query یا body) → زمینه‌ی نوع‌دار؛ مقدارهای ناشناخته رد می‌شوند */
export function parseWidgetContext(src: Record<string, unknown>): ChatWidgetContext {
  const kind = String(src.kind || "");
  if (!(KINDS as readonly string[]).includes(kind)) throw new ChatError("bad_context", "زمینه‌ی گفتگو نامعتبر است");
  const cid = Number(src.contractId);
  return {
    kind: kind as ChatWidgetContext["kind"],
    ref: typeof src.ref === "string" ? src.ref.slice(0, 80) : undefined,
    contractId: Number.isInteger(cid) && cid > 0 ? cid : undefined,
    target: src.target === "platform" ? "platform" : src.target === "issuer" ? "issuer" : undefined,
  };
}

/** سقف نرخ: به‌ازای هر بازدیدکننده/کاربر و هر IP (جلوگیری از اسپم و فشار روی تیم پشتیبانی) */
export async function limitSend(who: Requester, newConversation: boolean): Promise<void> {
  const id = who.kind === "user" ? `u${who.userId}` : `v${who.hash.slice(0, 16)}`;
  let ip = "";
  try {
    ({ ip } = await getRequestInfo());
  } catch {
    /* بدون IP */
  }
  if (!rateLimit(`chat:msg:${id}`, 20, 60_000).ok) throw new ChatError("rate", "پیام‌ها خیلی سریع ارسال می‌شوند؛ چند لحظه صبر کنید.", 429);
  if (ip && !rateLimit(`chat:ip:${ip}`, 60, 60_000).ok) throw new ChatError("rate", "درخواست‌ها از این شبکه بیش از حد است؛ کمی بعد دوباره تلاش کنید.", 429);
  if (newConversation && ip && !rateLimit(`chat:new:${ip}`, 8, 60 * 60_000).ok) throw new ChatError("rate", "تعداد گفتگوهای تازه از این شبکه زیاد است؛ کمی بعد دوباره تلاش کنید.", 429);
}

export async function conversationView(conv: Conv): Promise<ChatConversationView> {
  const [messages, state] = await Promise.all([listMessages(conv.id, { staff: false }), requesterState(conv)]);
  return { code: conv.code, queue: conv.queue as ChatQueue, state, messages };
}

export async function buildBootstrap(who: Requester | null, input: ChatWidgetContext): Promise<ChatBootstrap> {
  const ctx = await resolveContext(who, input);
  const conv = who ? await findConversation(who, ctx.key) : null;
  return {
    title: ctx.title,
    queue: ctx.queue,
    targets: ctx.targets,
    target: ctx.target,
    online: await agentsOnline(ctx.queue, ctx.workspaceId),
    name: ctx.name,
    needsName: ctx.kind === "site" && !conv,
    contextLabel: ctx.contextLabel,
    conversation: conv ? await conversationView(conv) : null,
  };
}

export const parseQueue = (v: string | null | undefined): ChatQueue => (v === "workspace" ? "workspace" : "platform");
export const parseFilter = (v: string | null | undefined): StaffFilter => (v === "mine" || v === "unassigned" || v === "closed" ? v : "open");
