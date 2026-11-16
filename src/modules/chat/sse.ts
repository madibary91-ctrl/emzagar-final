import { onChatWake } from "./bus";

export type Emit = (event: string, data: unknown, id?: number) => void;
/**
 * زمینه‌ی هر اجرای `run`:
 *  - reason: "connect" (اتصال تازه) | "wake" (نوشتنِ همین پروسه) | "poll" (دوره‌ای؛ تنها راهِ دیدن نوشتنِ پروسه‌ی دیگر)
 *  - n: شماره‌ی اجراهای poll از اتصال؛ `full` هر چند poll یک‌بار true می‌شود (شبکه‌ی ایمنی: خواندن کامل حتی اگر «کاوشگر ارزان» تغییری ندید).
 */
export type TickCtx = { reason: "connect" | "wake" | "poll"; n: number; full: boolean };
export const FULL_REFRESH_EVERY = 6;

/**
 * پاسخ SSE (Server-Sent Events) عمومی گفتگو.
 *  - `run` در لحظه‌ی اتصال، با هر بیدارباش (نوشتن در دیتابیس) و با هر `intervalMs` اجرا می‌شود.
 *    اگر false برگرداند، اتصال بسته می‌شود.
 *  - P-07: poll «تطبیقی» است: اتصالِ بی‌تغییر آرام‌آرام تا `idleMaxMs` کندتر poll می‌کند؛ هر رویداد/بیدارباش فاصله را به پایه برمی‌گرداند.
 *    (بیدارباش درون‌پروسه‌ای همیشه فوری است؛ poll فقط برای دیدن نوشتن‌های پروسه‌ی دیگر لازم است.)
 *  - هر `maxMs` اتصال به‌صورت منظم بسته می‌شود؛ EventSource مرورگر خودکار و با Last-Event-ID دوباره وصل می‌شود
 *    (اتصال‌های مرده و پروکسی‌های بافردار هرگز برای همیشه نمی‌مانند).
 */
export function eventStream(req: Request, o: { wake: string | null; intervalMs?: number; maxMs?: number; /** سقف فاصله‌ی poll وقتی اتصال بی‌تغییر است (پیش‌فرض ۲٫۴× پایه) */ idleMaxMs?: number; run: (emit: Emit, ctx: TickCtx) => Promise<boolean | void> }): Response {
  const enc = new TextEncoder();
  let finish: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let running = false;
      let pending = false;
      let emitted = 0;
      let pollN = 0;
      let wakePending = false;
      let idle = 0;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const base = o.intervalMs ?? 4000;
      const cap = Math.max(base, o.idleMaxMs ?? Math.round(base * 2.4));
      const write = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          closed = true;
        }
      };
      const emit: Emit = (event, data, id) => {
        emitted++;
        write(`${id != null ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const tick = async (why: TickCtx["reason"]) => {
        if (closed) return;
        if (running) {
          pending = true;
          if (why === "wake") wakePending = true;
          return;
        }
        running = true;
        let cur = why;
        try {
          do {
            pending = false;
            if (wakePending) {
              cur = "wake";
              wakePending = false;
            }
            const ctx: TickCtx = cur === "poll" ? { reason: "poll", n: ++pollN, full: pollN % FULL_REFRESH_EVERY === 0 } : { reason: cur, n: pollN, full: true };
            cur = "poll";
            const before = emitted;
            const res = await o.run(emit, ctx);
            idle = emitted !== before || ctx.reason !== "poll" ? 0 : idle + 1;
            if (res === false) {
              finish();
              return;
            }
          } while (pending && !closed);
        } catch (e) {
          console.error("[chat:sse]", e);
          emit("fatal", { message: "connection error" });
          finish();
        } finally {
          running = false;
        }
      };

      const off = onChatWake(o.wake, () => {
        idle = 0;
        void tick("wake");
      });
      const schedule = () => {
        if (closed) return;
        const wait = Math.min(cap, Math.round(base * 1.25 ** Math.min(idle, 12)));
        pollTimer = setTimeout(() => {
          void tick("poll").finally(schedule);
        }, wait);
      };
      const beat = setInterval(() => write(": ping\n\n"), 15_000);
      const end = setTimeout(() => finish(), o.maxMs ?? 55_000);
      finish = () => {
        if (closed) return;
        closed = true;
        clearTimeout(pollTimer);
        clearInterval(beat);
        clearTimeout(end);
        off();
        try {
          controller.close();
        } catch {
          /* قبلاً بسته شده */
        }
      };
      req.signal.addEventListener("abort", () => finish());
      write("retry: 2500\n\n");
      void tick("connect");
      schedule();
    },
    cancel() {
      finish();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
