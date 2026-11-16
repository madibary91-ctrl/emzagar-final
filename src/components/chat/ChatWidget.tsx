"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Headset, LoaderCircle, MessageCircle, MinusCircle, X } from "lucide-react";
import type { ChatBootstrap, ChatMsg, ChatState, ChatTarget, ChatWidgetContext } from "@/modules/chat/meta";
import { CHAT_BODY_MAX } from "@/modules/chat/meta";
import { MessageList, Stars, faNum, mergeMessages, newClientId, type LocalMsg } from "./ChatBits";

const PROMPTS: Record<ChatWidgetContext["kind"], string[]> = {
  sign: ["کد پیامکی برایم نمی‌رسد", "درباره‌ی یکی از بندهای قرارداد سؤال دارم", "در ثبت امضا مشکل دارم"],
  pay: ["پرداخت من انجام نشد", "مبلغ کسر شد ولی تأیید نشد", "درباره‌ی اقساط سؤال دارم"],
  panel: ["برای صدور قرارداد راهنمایی می‌خواهم", "مشکلی در پرداخت یا اشتراک دارم", "می‌خواهم یک خطا را گزارش کنم"],
  site: ["درباره‌ی قیمت و طرح‌ها سؤال دارم", "می‌خواهم نسخه‌ی آزمایشی ببینم"],
};

const OPEN_KEY = "emz-chat-open";

/**
 * ویجت گفتگوی زنده‌ی پشتیبانی (شناور). در سه جا نصب می‌شود:
 *  - پنل (کاربر واردشده؛ با تشخیص قرارداد جاری)
 *  - صفحه‌ی امضا و صفحه‌ی پرداخت (مهمان؛ بدون ثبت‌نام، با لینک اختصاصی)
 *  - صفحه‌های عمومی سایت (بازدیدکننده)
 * انتقال لحظه‌ای با SSE؛ در صورت مسدود بودن SSE، به پولینگ سبک برمی‌گردد.
 */
export default function ChatWidget({ context }: { context: ChatWidgetContext }) {
  const [target, setTarget] = useState<ChatTarget | undefined>(context.target);
  const [boot, setBoot] = useState<ChatBootstrap | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [messages, setMessages] = useState<LocalMsg[]>([]);
  const [state, setState] = useState<ChatState | null>(null);
  const [draft, setDraft] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [error, setError] = useState("");
  const [busyTarget, setBusyTarget] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastId = useRef(0);
  const typedAt = useRef(0);
  const tmp = useRef(0);

  const { contractId } = context;

  const ctx = useMemo<ChatWidgetContext>(() => ({ kind: context.kind, ref: context.ref, contractId, target }), [context.kind, context.ref, contractId, target]);
  const ctxKey = JSON.stringify(ctx);

  const hidden = unavailable;

  /* ───── بارگذاری وضعیت اولیه ───── */
  const applyBoot = useCallback((b: ChatBootstrap) => {
    setBoot(b);
    const c = b.conversation;
    setCode(c?.code ?? null);
    setMessages(c?.messages ?? []);
    setState(c?.state ?? null);
    lastId.current = Math.max(0, ...(c?.messages ?? []).map((m) => m.id));
  }, []);

  useEffect(() => {
    let dead = false;
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ kind: ctx.kind });
        if (ctx.ref) qs.set("ref", ctx.ref);
        if (ctx.contractId) qs.set("contractId", String(ctx.contractId));
        if (ctx.target) qs.set("target", ctx.target);
        const r = await fetch(`/api/chat/bootstrap?${qs}`, { cache: "no-store" });
        if (dead) return;
        if (!r.ok) {
          setUnavailable(true);
          return;
        }
        applyBoot((await r.json()) as ChatBootstrap);
        setBusyTarget(false);
        try {
          if (sessionStorage.getItem(OPEN_KEY) === "1") setOpen(true);
        } catch {
          /* حالت خصوصی مرورگر */
        }
      } catch {
        /* آفلاین: ویجت بی‌صدا پنهان می‌ماند تا بارگذاری بعدی */
      }
    }, 500);
    return () => {
      dead = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxKey]);

  // لینک اعلان (?chat=open) ویجت را باز می‌کند
  useEffect(() => {
    const u = new URL(window.location.href);
    if (u.searchParams.get("chat") === "open") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpen(true);
      u.searchParams.delete("chat");
      window.history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
    }
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (open) setTimeout(() => input.current?.focus(), 60);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  /* ───── انتقال لحظه‌ای: SSE (با بازگشت به پولینگ) ───── */
  const status = state?.status;
  useEffect(() => {
    if (!code || status !== "open") return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let fails = 0;
    let stopped = false;

    const incoming = (ms: ChatMsg[]) => {
      if (ms.length === 0) return;
      lastId.current = Math.max(lastId.current, ...ms.map((m) => m.id));
      setMessages((prev) => mergeMessages(prev, ms));
    };

    const poll = () => {
      if (timer || stopped) return;
      const tick = async () => {
        if (document.visibilityState !== "visible") return;
        try {
          const r = await fetch("/api/chat/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ c: code, after: lastId.current || 1 }) });
          if (!r.ok) return;
          const d = (await r.json()) as { messages: ChatMsg[]; state: ChatState };
          incoming(d.messages);
          setState(d.state);
        } catch {
          /* شبکه قطع: دور بعدی */
        }
      };
      void tick();
      timer = setInterval(tick, 4000);
    };

    if (typeof EventSource === "undefined") poll();
    else {
      es = new EventSource(`/api/chat/stream?c=${encodeURIComponent(code)}&after=${lastId.current}`);
      es.addEventListener("msg", (ev) => {
        fails = 0;
        incoming([JSON.parse((ev as MessageEvent<string>).data) as ChatMsg]);
      });
      es.addEventListener("state", (ev) => {
        fails = 0;
        setState(JSON.parse((ev as MessageEvent<string>).data) as ChatState);
      });
      es.addEventListener("fatal", () => {
        es?.close();
        poll();
      });
      es.onerror = () => {
        fails++;
        // خطای دائمی (۴۰۴/مسدود بودن SSE) → پولینگ
        if (es?.readyState === EventSource.CLOSED || fails >= 4) {
          es?.close();
          poll();
        }
      };
    }
    return () => {
      stopped = true;
      es?.close();
      if (timer) clearInterval(timer);
    };
  }, [code, status]);

  /* ───── «خوانده شد»: وقتی ویجت باز و تب فعال است ───── */
  const unread = state?.unread ?? 0;
  useEffect(() => {
    if (!open || !code || unread <= 0) return;
    if (document.visibilityState !== "visible") return;
    void fetch("/api/chat/act", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, action: "read" }) }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((s) => (s ? { ...s, unread: 0 } : s));
  }, [open, code, unread]);

  const act = useCallback(
    async (action: "typing" | "close" | "rate", extra: Record<string, unknown> = {}) => {
      if (!code) return;
      try {
        await fetch("/api/chat/act", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, action, ...extra }) });
      } catch {
        /* ignore */
      }
    },
    [code],
  );

  /* ───── ارسال ───── */
  const doSend = useCallback(
    async (text: string, cid: string) => {
      setError("");
      try {
        const r = await fetch("/api/chat/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...ctx, text, clientId: cid, name: nameInput || undefined, path: window.location.pathname }),
        });
        const d = (await r.json().catch(() => ({}))) as { message?: unknown; conversation?: { code: string; state: ChatState; messages: ChatMsg[] } };
        if (!r.ok || !d.conversation) {
          setMessages((p) => p.map((m) => (m.cid === cid ? { ...m, local: "failed" } : m)));
          setError(typeof d.message === "string" && r.status !== 500 ? d.message : "ارسال ناموفق بود؛ اتصال خود را بررسی کنید.");
          return;
        }
        setCode(d.conversation.code);
        setState(d.conversation.state);
        lastId.current = Math.max(lastId.current, ...d.conversation.messages.map((m) => m.id));
        setMessages((p) => mergeMessages(p, d.conversation!.messages));
        setBoot((b) => (b ? { ...b, needsName: false } : b));
      } catch {
        setMessages((p) => p.map((m) => (m.cid === cid ? { ...m, local: "failed" } : m)));
        setError("ارتباط با سرور برقرار نشد. دوباره تلاش کنید.");
      }
    },
    [ctx, nameInput],
  );

  const submit = () => {
    const text = draft.trim();
    if (!text || !boot) return;
    if (boot.needsName && nameInput.trim().length < 2) {
      setError("لطفاً نام خود را وارد کنید.");
      return;
    }
    const cid = newClientId();
    const temp: LocalMsg = { id: --tmp.current, kind: "requester", name: "", body: text.slice(0, CHAT_BODY_MAX), at: new Date().toISOString(), internal: false, cid, local: "sending" };
    setMessages((p) => [...p, temp]);
    setDraft("");
    void doSend(text, cid);
  };

  const retry = (m: LocalMsg) => {
    if (!m.cid) return;
    setMessages((p) => p.map((x) => (x.cid === m.cid ? { ...x, local: "sending" } : x)));
    void doSend(m.body, m.cid);
  };

  const onType = (v: string) => {
    setDraft(v.slice(0, CHAT_BODY_MAX));
    if (code && Date.now() - typedAt.current > 3000 && v.trim()) {
      typedAt.current = Date.now();
      void act("typing");
    }
  };

  const switchTarget = (t: ChatTarget) => {
    if (t === boot?.target) return;
    setBusyTarget(true);
    setCode(null);
    setMessages([]);
    setState(null);
    setTarget(t);
  };

  const startNew = () => {
    setCode(null);
    setMessages([]);
    setState(null);
    lastId.current = 0;
  };

  const closeChat = async () => {
    await act("close");
    setState((s) => (s ? { ...s, status: "closed" } : s));
  };

  if (hidden || !boot) return null;

  const closed = state?.status === "closed";
  const online = state ? state.online : boot.online;
  const label = boot.title;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-4 left-4 z-40 flex h-14 items-center gap-2 rounded-full bg-mint px-5 text-[#06231b] shadow-[0_10px_30px_rgba(16,44,49,.28)] transition hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink pb-[env(safe-area-inset-bottom)]"
          aria-label={unread > 0 ? `گفتگو با پشتیبانی — ${faNum(unread)} پیام خوانده‌نشده` : "گفتگوی آنلاین با پشتیبانی"}
          data-testid="chat-launcher"
        >
          <span className="relative">
            <MessageCircle size={22} />
            {online && <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-mint bg-emerald-600" aria-hidden />}
          </span>
          <span className="hidden text-sm font-black sm:inline">{unread > 0 ? "پیام جدید" : "گفتگوی آنلاین"}</span>
          {unread > 0 && <span className="absolute -top-1 -right-1 grid h-6 min-w-6 animate-pulse place-items-center rounded-full bg-coral px-1 text-xs font-black text-white">{faNum(unread)}</span>}
        </button>
      )}

      {open && (
        <section
          role="dialog"
          aria-label="گفتگوی آنلاین با پشتیبانی"
          className="panel-solid fixed inset-0 z-50 flex flex-col overflow-hidden !rounded-none text-ink shadow-2xl sm:inset-auto sm:bottom-4 sm:left-4 sm:h-[620px] sm:max-h-[calc(100dvh-2rem)] sm:w-[390px] sm:!rounded-3xl"
          data-testid="chat-panel"
        >
          <header className="flex items-center gap-3 bg-ink px-4 py-3 text-white">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-mint/20 text-mint"><Headset size={20} /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-black">{label}</p>
              <p className="flex items-center gap-1.5 text-[11px] opacity-85">
                <span className={`h-2 w-2 rounded-full ${online ? "bg-mint" : "bg-stone-400"}`} aria-hidden />
                {online ? (state?.assignee ? `آنلاین · ${state.assignee}` : "آنلاین — معمولاً در چند دقیقه پاسخ می‌دهیم") : "آفلاین — پیام بگذارید، پاسخ می‌دهیم"}
              </p>
            </div>
            {code && !closed && (
              <button type="button" onClick={closeChat} className="grid h-8 place-items-center rounded-lg px-2 text-[11px] font-bold opacity-80 transition hover:bg-white/10 hover:opacity-100" title="پایان گفتگو">
                پایان
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} className="grid h-8 w-8 place-items-center rounded-lg transition hover:bg-white/10" aria-label="کوچک‌کردن گفتگو"><MinusCircle size={18} className="sm:hidden" /><X size={18} className="hidden sm:block" /></button>
          </header>

          {boot.targets.length > 1 && (
            <div className="flex gap-1 border-b border-ink/10 bg-stone-50 p-1.5" role="tablist" aria-label="مقصد گفتگو">
              {boot.targets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={boot.target === t.id}
                  onClick={() => switchTarget(t.id)}
                  className={`flex-1 truncate rounded-xl px-2 py-1.5 text-[11px] font-black transition ${boot.target === t.id ? "bg-white text-ink shadow-sm" : "text-ink/60 hover:text-ink"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {boot.contextLabel && <p className="border-b border-ink/10 bg-mint/15 px-4 py-1.5 text-[11px] font-bold text-ink/80">درباره‌ی: {boot.contextLabel}</p>}

          {busyTarget ? (
            <div className="grid flex-1 place-items-center"><LoaderCircle className="animate-spin text-ink/50" /></div>
          ) : (
            <MessageList
              messages={messages}
              viewer="requester"
              seenUpTo={state?.staffReadId ?? 0}
              typing={!!state?.typing && !closed}
              typingLabel="پشتیبان در حال نوشتن…"
              otherLabel="پشتیبان"
              onRetry={retry}
              empty={
                <div className="m-auto max-w-[280px] py-6 text-center">
                  <span className="mx-auto grid h-14 w-14 place-items-center rounded-3xl bg-mint/25 text-ink"><MessageCircle size={26} /></span>
                  <p className="mt-3 text-sm font-black">سلام! چطور می‌توانیم کمک کنیم؟</p>
                  <p className="mt-1 text-xs leading-6 text-ink/65">سؤال یا مشکلتان را بنویسید؛ همین‌جا و بدون ترک صفحه پاسخ می‌دهیم.</p>
                  <div className="mt-4 flex flex-col gap-1.5">
                    {PROMPTS[context.kind].map((p) => (
                      <button key={p} type="button" onClick={() => { setDraft(p); input.current?.focus(); }} className="rounded-xl border border-ink/12 bg-white px-3 py-2 text-xs font-bold text-ink/85 transition hover:border-ink/30 hover:bg-stone-50">
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              }
            />
          )}

          {error && <p role="alert" className="mx-3 mb-1 rounded-xl bg-rose-50 px-3 py-1.5 text-[11px] font-bold text-rose-700">{error}</p>}

          {closed ? (
            <div className="border-t border-ink/10 p-4 text-center">
              {state?.ticketNumber ? (
                <p className="text-xs font-bold leading-6">این گفتگو به تیکت <span dir="ltr" className="font-mono">{state.ticketNumber}</span> تبدیل شد؛ از بخش «پشتیبانی» پیگیری کنید.</p>
              ) : (
                <>
                  <p className="text-xs font-bold">{state?.rating ? "از امتیاز شما سپاسگزاریم 🙏" : "این گفتگو بسته شد. از پشتیبانی راضی بودید؟"}</p>
                  <div className="mt-2"><Stars value={state?.rating ?? null} onPick={state?.rating ? undefined : (n) => { setState((s) => (s ? { ...s, rating: n } : s)); void act("rate", { rating: n }); }} /></div>
                </>
              )}
              <button type="button" onClick={startNew} className="btn-secondary btn-sm mt-3">شروع گفتگوی جدید</button>
            </div>
          ) : (
            <form
              className="border-t border-ink/10 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              {boot.needsName && (
                <input value={nameInput} onChange={(e) => setNameInput(e.target.value.slice(0, 60))} className="input mb-2 !min-h-[40px] text-sm" placeholder="نام شما" aria-label="نام شما" autoComplete="name" />
              )}
              <div className="flex items-end gap-2">
                <textarea
                  ref={input}
                  value={draft}
                  onChange={(e) => onType(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  rows={Math.min(4, Math.max(1, draft.split("\n").length))}
                  className="input !min-h-[44px] flex-1 resize-none py-2.5 text-sm leading-6"
                  placeholder="پیام خود را بنویسید…"
                  aria-label="متن پیام"
                  maxLength={CHAT_BODY_MAX}
                />
                <button type="submit" disabled={!draft.trim()} className="btn-primary btn-mint grid h-11 w-11 shrink-0 place-items-center !p-0 disabled:opacity-40" aria-label="ارسال پیام">
                  <ArrowUp size={20} />
                </button>
              </div>
              {draft.length > 1800 && <p className="mt-1 text-left text-[10px] text-ink/55" dir="ltr">{draft.length}/{CHAT_BODY_MAX}</p>}
            </form>
          )}
        </section>
      )}
    </>
  );
}
