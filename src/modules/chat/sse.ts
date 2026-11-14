import { onChatWake } from "./bus";

export type Emit = (event: string, data: unknown, id?: number) => void;

/**
 * پاسخ SSE (Server-Sent Events) عمومی گفتگو.
 *  - `run` در لحظه‌ی اتصال، با هر بیدارباش (نوشتن در دیتابیس) و با هر `intervalMs` اجرا می‌شود.
 *    اگر false برگرداند، اتصال بسته می‌شود.
 *  - هر `maxMs` اتصال به‌صورت منظم بسته می‌شود؛ EventSource مرورگر خودکار و با Last-Event-ID دوباره وصل می‌شود
 *    (اتصال‌های مرده و پروکسی‌های بافردار هرگز برای همیشه نمی‌مانند).
 */
export function eventStream(req: Request, o: { wake: string | null; intervalMs?: number; maxMs?: number; run: (emit: Emit) => Promise<boolean | void> }): Response {
  const enc = new TextEncoder();
  let finish: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let running = false;
      let pending = false;
      const write = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          closed = true;
        }
      };
      const emit: Emit = (event, data, id) => write(`${id != null ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const tick = async () => {
        if (closed) return;
        if (running) {
          pending = true;
          return;
        }
        running = true;
        try {
          do {
            pending = false;
            if ((await o.run(emit)) === false) {
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

      const off = onChatWake(o.wake, () => void tick());
      const poll = setInterval(() => void tick(), o.intervalMs ?? 4000);
      const beat = setInterval(() => write(": ping\n\n"), 15_000);
      const end = setTimeout(() => finish(), o.maxMs ?? 55_000);
      finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(poll);
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
      void tick();
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
