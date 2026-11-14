"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { Check, CheckCheck, Clock3, RotateCw, StickyNote } from "lucide-react";
import type { ChatMsg } from "@/modules/chat/meta";

export type LocalMsg = ChatMsg & { local?: "sending" | "failed" };

const FA = "۰۱۲۳۴۵۶۷۸۹";
export const faNum = (n: number | string) => String(n).replace(/\d/g, (d) => FA[Number(d)]);

export const hm = (iso: string) => new Date(iso).toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" });
const dayKey = (iso: string) => new Date(iso).toDateString();
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const t = new Date();
  const y = new Date(Date.now() - 86400_000);
  if (d.toDateString() === t.toDateString()) return "امروز";
  if (d.toDateString() === y.toDateString()) return "دیروز";
  return d.toLocaleDateString("fa-IR", { day: "numeric", month: "long" });
}

export function ago(iso: string): string {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "هم‌اکنون";
  const rtf = new Intl.RelativeTimeFormat("fa", { numeric: "auto" });
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

/** شناسه‌ی یکتای سمت مرورگر برای هر پیام (ارسال مجدد امن) */
export function newClientId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** ادغام پیام‌های رسیده با فهرست فعلی (بدون تکرار؛ پیام موقتِ هم‌شناسه با نسخه‌ی سرور جایگزین می‌شود) */
export function mergeMessages(list: LocalMsg[], incoming: ChatMsg[]): LocalMsg[] {
  if (incoming.length === 0) return list;
  const next = [...list];
  for (const m of incoming) {
    const byId = next.findIndex((x) => x.id === m.id);
    if (byId >= 0) {
      next[byId] = m;
      continue;
    }
    const byCid = m.cid ? next.findIndex((x) => x.cid === m.cid && x.id < 0) : -1;
    if (byCid >= 0) next[byCid] = m;
    else next.push(m);
  }
  // پیام‌های موقت (id منفی) همیشه آخر؛ بقیه به ترتیب شناسه
  const real = next.filter((x) => x.id > 0).sort((a, b) => a.id - b.id);
  const temp = next.filter((x) => x.id < 0);
  return [...real, ...temp];
}

export function TypingDots({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-1 text-[11px] text-ink/65" role="status" aria-live="polite">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink/45" style={{ animationDelay: `${i * 140}ms` }} />
        ))}
      </span>
      {label}
    </div>
  );
}

function Ticks({ m, seen }: { m: LocalMsg; seen: boolean }) {
  if (m.local === "sending") return <Clock3 size={11} className="opacity-60" aria-label="در حال ارسال" />;
  if (seen) return <CheckCheck size={13} className="text-emerald-700" aria-label="دیده شد" />;
  return <Check size={13} className="opacity-60" aria-label="ارسال شد" />;
}

/**
 * فهرست پیام‌ها. viewer مشخص می‌کند کدام حباب «از من» است:
 *  requester → پیام‌های requester | staff → پیام‌های staff
 */
export function MessageList({
  messages,
  viewer,
  seenUpTo,
  typing,
  typingLabel,
  otherLabel,
  onRetry,
  empty,
}: {
  messages: LocalMsg[];
  viewer: "requester" | "staff";
  seenUpTo: number;
  typing?: boolean;
  typingLabel: string;
  otherLabel: string;
  onRetry?: (m: LocalMsg) => void;
  empty?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastLen = useRef(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    const grew = messages.length !== lastLen.current;
    lastLen.current = messages.length;
    if (grew && (stick.current || last?.kind === viewer)) el.scrollTop = el.scrollHeight;
  }, [messages, typing, viewer]);

  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="thin-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3"
      role="log"
      aria-live="polite"
      aria-label="پیام‌های گفتگو"
    >
      {messages.length === 0 && empty}
      {messages.map((m, i) => {
        const sep = i === 0 || dayKey(messages[i - 1].at) !== dayKey(m.at);
        const mine = m.kind === viewer;
        return (
          <div key={m.cid || m.id} className="flex flex-col gap-2">
            {sep && <div className="mx-auto rounded-full bg-ink/[0.06] px-3 py-0.5 text-[10px] font-bold text-ink/60">{dayLabel(m.at)}</div>}
            {m.kind === "system" ? (
              <div className="mx-auto max-w-[92%] rounded-xl bg-ink/[0.05] px-3 py-1.5 text-center text-[11px] leading-6 text-ink/70">{m.body}</div>
            ) : (
              <div className={`flex max-w-[86%] flex-col ${mine ? "self-start items-start" : "self-end items-end"}`}>
                {!mine && <span className="mb-0.5 px-1 text-[10px] font-bold text-ink/55">{m.kind === "staff" && viewer === "requester" ? otherLabel : m.name || otherLabel}</span>}
                <div
                  className={`msg-bubble rounded-2xl px-3.5 py-1.5 ${
                    m.internal
                      ? "border border-dashed border-amber-300 bg-amber-50 text-amber-900"
                      : mine
                        ? "rounded-tr-md bg-mint text-[#06231b]"
                        : "rounded-tl-md bg-stone-100 text-ink"
                  } ${m.local === "failed" ? "opacity-60 ring-1 ring-rose-400" : ""}`}
                >
                  {m.internal && (
                    <span className="mb-0.5 flex items-center gap-1 text-[10px] font-black text-amber-700">
                      <StickyNote size={11} />یادداشت داخلی
                    </span>
                  )}
                  {m.body}
                </div>
                <div className="mt-0.5 flex items-center gap-1 px-1 text-[10px] text-ink/50">
                  <span>{m.id > 0 || m.local ? hm(m.at) : ""}</span>
                  {mine && !m.internal && <Ticks m={m} seen={m.id > 0 && m.id <= seenUpTo} />}
                  {m.local === "failed" && onRetry && (
                    <button type="button" onClick={() => onRetry(m)} className="flex items-center gap-1 font-bold text-rose-600 hover:underline">
                      <RotateCw size={11} />ارسال مجدد
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
      {typing && <TypingDots label={typingLabel} />}
    </div>
  );
}

export function Stars({ value, onPick, size = 22 }: { value: number | null; onPick?: (n: number) => void; size?: number }) {
  return (
    <div className="flex items-center justify-center gap-1" role={onPick ? "radiogroup" : "img"} aria-label={value ? `امتیاز ${faNum(value)} از ۵` : "بدون امتیاز"}>
      {[1, 2, 3, 4, 5].map((n) => {
        const on = (value ?? 0) >= n;
        return (
          <button
            key={n}
            type="button"
            disabled={!onPick}
            role={onPick ? "radio" : undefined}
            aria-checked={value === n}
            aria-label={`${faNum(n)} ستاره`}
            onClick={() => onPick?.(n)}
            className={`transition ${onPick ? "hover:scale-110" : "cursor-default"}`}
            style={{ fontSize: size, lineHeight: 1, color: on ? "#f5a623" : "rgba(120,130,130,.4)" }}
          >
            ★
          </button>
        );
      })}
    </div>
  );
}
