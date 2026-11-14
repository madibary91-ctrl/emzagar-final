import { EventEmitter } from "node:events";

/**
 * «بیدارباش» درون‌پردازه‌ای گفتگو: هر نوشتن در دیتابیس، اتصال‌های SSE همین پردازه را فوراً بیدار می‌کند.
 * دیتابیس همیشه منبع حقیقت است؛ اتصال‌های SSE هر چند ثانیه هم خودشان دیتابیس را می‌خوانند،
 * پس در استقرار چندنمونه‌ای پیام‌ها حداکثر چند ثانیه دیرتر می‌رسند ولی هرگز گم نمی‌شوند.
 */
type G = typeof globalThis & { __emzChatBus?: EventEmitter };
const g = globalThis as G;

function bus(): EventEmitter {
  if (!g.__emzChatBus) {
    g.__emzChatBus = new EventEmitter();
    g.__emzChatBus.setMaxListeners(0);
  }
  return g.__emzChatBus;
}

/** رویداد مخصوص یک گفتگو + رویداد عمومی «any» برای صندوق‌های پشتیبان */
export function chatWake(code: string): void {
  const b = bus();
  b.emit(`c:${code}`);
  b.emit("any");
}

export function onChatWake(code: string | null, fn: () => void): () => void {
  const b = bus();
  const ev = code ? `c:${code}` : "any";
  b.on(ev, fn);
  return () => void b.off(ev, fn);
}
