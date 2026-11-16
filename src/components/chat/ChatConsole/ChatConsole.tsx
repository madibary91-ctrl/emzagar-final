"use client";
import { ArrowRight, BellRing, Check, Headset, Info, LifeBuoy, LoaderCircle, MessageSquareText, Search, Send, StickyNote, UserCheck, UserMinus, Volume2, VolumeX, Zap } from "lucide-react";
import { CHAT_BODY_MAX, CONTEXT_LABELS, type ChatMsg, type ChatQueue, QUICK_REPLIES, type StaffThread, renderQuickReply } from "@/modules/chat/meta";
import { ContextCard } from "./parts";
import { type Filter, type Inbox, SOUND_KEY, type ThreadState, api, beep } from "./helpers";
import { type LocalMsg, MessageList, Stars, ago, faNum, mergeMessages, newClientId } from "../ChatBits";
import { useCallback, useEffect, useRef, useState } from "react";

/** کنسول پشتیبان گفتگوی زنده: صندوق + رشته‌ی پیام + زمینه‌ی مشتری/قرارداد */
export default function ChatConsole({ queue, initialCode, staffName, staffId }: { queue: ChatQueue; initialCode?: string; staffName: string; staffId: number }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [q, setQ] = useState("");
  const [qs, setQs] = useState("");
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [code, setCode] = useState<string | null>(initialCode || null);
  const [thread, setThread] = useState<StaffThread | null>(null);
  const [ts, setTs] = useState<ThreadState | null>(null);
  const [messages, setMessages] = useState<LocalMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState(false);
  const [showQuick, setShowQuick] = useState(false);
  const [showCtx, setShowCtx] = useState(false);
  const [error, setError] = useState("");
  const [loadingThread, setLoadingThread] = useState(false);
  const [sound, setSound] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastId = useRef(0);
  const typedAt = useRef(0);
  const tmp = useRef(0);
  const prevUnread = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const soundRef = useRef(false);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSound(localStorage.getItem(SOUND_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    soundRef.current = sound;
  }, [sound]);

  useEffect(() => {
    const t = setTimeout(() => setQs(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  /* ───── بارگذاری رشته‌ی گفتگوی انتخاب‌شده ───── */
  const loadThread = useCallback(
    async (c: string) => {
      setLoadingThread(true);
      try {
        const r = await fetch(`/api/chat/staff/thread?queue=${queue}&c=${encodeURIComponent(c)}`, { cache: "no-store" });
        if (!r.ok) {
          setError("گفتگو یافت نشد یا دسترسی ندارید.");
          setCode(null);
          return;
        }
        const t = (await r.json()) as StaffThread;
        setThread(t);
        setTs({ status: t.status, assigneeId: t.assigneeId, requesterTyping: t.requesterTyping, requesterOnline: t.requesterOnline, requesterReadId: t.requesterReadId, rating: t.rating, hasTicket: !!t.ticketNumber, unread: 0 });
        setMessages(t.messages);
        lastId.current = Math.max(0, ...t.messages.map((m) => m.id));
        void api("/api/chat/staff/act", { queue, code: c, action: "read" });
      } finally {
        setLoadingThread(false);
      }
    },
    [queue],
  );

  useEffect(() => {
    if (!code) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setThread(null);
      setTs(null);
      setMessages([]);
      return;
    }
    setError("");
    void loadThread(code);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("c", code);
      window.history.replaceState(null, "", u.pathname + u.search);
    } catch {
      /* ignore */
    }
  }, [code, loadThread]);

  /* ───── جریان زنده (SSE) با بازگشت به پولینگ ───── */
  const threadReady = thread?.code === code ? code : null;
  useEffect(() => {
    if (code && !threadReady) return; // اول رشته بارگذاری شود تا after درست باشد
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let fails = 0;
    let stopped = false;

    const onInbox = (d: Inbox) => {
      setInbox(d);
      if (d.counts.unread > prevUnread.current && soundRef.current && document.visibilityState !== "visible") beep();
      prevUnread.current = d.counts.unread;
    };
    const incoming = (ms: ChatMsg[]) => {
      if (ms.length === 0) return;
      lastId.current = Math.max(lastId.current, ...ms.map((m) => m.id));
      setMessages((p) => mergeMessages(p, ms));
      if (ms.some((m) => m.kind === "requester") && document.visibilityState === "visible" && code) void api("/api/chat/staff/act", { queue, code, action: "read" });
    };

    const poll = () => {
      if (timer || stopped) return;
      const tick = async () => {
        try {
          const r = await fetch(`/api/chat/staff/list?queue=${queue}&filter=${filter}&q=${encodeURIComponent(qs)}`, { cache: "no-store" });
          if (r.ok) onInbox((await r.json()) as Inbox);
          if (code) {
            const t = await fetch(`/api/chat/staff/thread?queue=${queue}&c=${encodeURIComponent(code)}`, { cache: "no-store" });
            if (t.ok) {
              const d = (await t.json()) as StaffThread;
              setMessages((p) => mergeMessages(p, d.messages));
              setTs({ status: d.status, assigneeId: d.assigneeId, requesterTyping: d.requesterTyping, requesterOnline: d.requesterOnline, requesterReadId: d.requesterReadId, rating: d.rating, hasTicket: !!d.ticketNumber, unread: 0 });
            }
          }
        } catch {
          /* دور بعدی */
        }
      };
      void tick();
      timer = setInterval(tick, 4000);
    };

    if (typeof EventSource === "undefined") poll();
    else {
      const p = new URLSearchParams({ queue, filter, q: qs });
      if (code) {
        p.set("c", code);
        p.set("after", String(lastId.current));
      }
      es = new EventSource(`/api/chat/staff/stream?${p}`);
      es.addEventListener("inbox", (ev) => {
        fails = 0;
        onInbox(JSON.parse((ev as MessageEvent<string>).data) as Inbox);
      });
      es.addEventListener("msg", (ev) => {
        fails = 0;
        incoming([JSON.parse((ev as MessageEvent<string>).data) as ChatMsg]);
      });
      es.addEventListener("thread", (ev) => setTs(JSON.parse((ev as MessageEvent<string>).data) as ThreadState));
      es.addEventListener("fatal", () => {
        es?.close();
        poll();
      });
      es.onerror = () => {
        fails++;
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
  }, [queue, filter, qs, code, threadReady]);

  // نشان تعداد خوانده‌نشده در عنوان تب
  useEffect(() => {
    const n = inbox?.counts.unread ?? 0;
    const base = document.title.replace(/^\(\d+\)\s*/, "");
    document.title = n > 0 ? `(${faNum(n)}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [inbox?.counts.unread]);

  /* ───── کنش‌ها ───── */
  const send = async (text: string, cid: string, internal: boolean) => {
    if (!code) return;
    setError("");
    try {
      const r = await api("/api/chat/staff/act", { queue, code, action: internal ? "note" : "send", text, clientId: cid });
      const d = (await r.json().catch(() => ({}))) as { message?: ChatMsg | string };
      if (!r.ok || typeof d.message === "string" || !d.message) {
        setMessages((p) => p.map((m) => (m.cid === cid ? { ...m, local: "failed" } : m)));
        setError(typeof d.message === "string" ? d.message : "ارسال ناموفق بود.");
        return;
      }
      const msg = d.message;
      lastId.current = Math.max(lastId.current, msg.id);
      setMessages((p) => mergeMessages(p, [msg]));
    } catch {
      setMessages((p) => p.map((m) => (m.cid === cid ? { ...m, local: "failed" } : m)));
      setError("ارتباط با سرور برقرار نشد.");
    }
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || !code) return;
    const cid = newClientId();
    const temp: LocalMsg = { id: --tmp.current, kind: "staff", name: staffName, body: text, at: new Date().toISOString(), internal: note, cid, local: "sending" };
    setMessages((p) => [...p, temp]);
    setDraft("");
    setShowQuick(false);
    void send(text, cid, note);
  };

  const retry = (m: LocalMsg) => {
    if (!m.cid) return;
    setMessages((p) => p.map((x) => (x.cid === m.cid ? { ...x, local: "sending" } : x)));
    void send(m.body, m.cid, m.internal);
  };

  const command = async (action: "claim" | "release" | "close" | "reopen" | "ticket") => {
    if (!code || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await api("/api/chat/staff/act", { queue, code, action });
      const d = (await r.json().catch(() => ({}))) as { message?: string; ticketNumber?: string };
      if (!r.ok) setError(d.message || "انجام نشد.");
      else if (action === "ticket" && d.ticketNumber) await loadThread(code);
    } finally {
      setBusy(false);
    }
  };

  const onType = (v: string) => {
    setDraft(v.slice(0, CHAT_BODY_MAX));
    if (code && !note && v.trim() && Date.now() - typedAt.current > 3000) {
      typedAt.current = Date.now();
      void api("/api/chat/staff/act", { queue, code, action: "typing" });
    }
  };

  const items = inbox?.items ?? [];
  const counts = inbox?.counts;
  const tabs: { id: Filter; label: string; n?: number }[] = [
    { id: "open", label: "باز", n: counts?.open },
    { id: "mine", label: "من", n: counts?.mine },
    { id: "unassigned", label: "بدون مسئول", n: counts?.unassigned },
    { id: "closed", label: "بسته", n: counts?.closed },
  ];
  const closed = ts?.status === "closed";
  const ctx = thread?.context;
  const assigneeLabel = items.find((i) => i.code === code)?.assigneeName ?? thread?.assigneeName ?? null;
  const requesterName = ctx?.requester.name ?? "";
  const quick = QUICK_REPLIES.map((r) => ({ title: r.title, text: renderQuickReply(r.text, requesterName) }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-black"><Headset size={24} />گفتگوی زنده{queue === "platform" ? " — پشتیبانی پلتفرم" : " — مشتریان من"}</h1>
          <p className="mt-1 text-xs text-ink/65">
            تا وقتی این صفحه باز است «آنلاین» محسوب می‌شوید و مشتری وضعیت آنلاین را می‌بیند؛ در غیر این‌صورت پیام‌ها از راه زنگوله و ربات پیام‌رسان به شما می‌رسد.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            const v = !sound;
            setSound(v);
            try {
              localStorage.setItem(SOUND_KEY, v ? "1" : "0");
            } catch {
              /* ignore */
            }
            if (v) beep();
          }}
          className="btn-secondary btn-sm"
          aria-pressed={sound}
        >
          {sound ? <Volume2 size={14} /> : <VolumeX size={14} />}
          {sound ? "صدای اعلان روشن" : "صدای اعلان خاموش"}
        </button>
      </div>

      <div className="grid h-[calc(100dvh-210px)] min-h-[540px] gap-3 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_300px]">
        {/* ───── صندوق ───── */}
        <aside className={`card flex min-h-0 flex-col !p-0 ${code ? "hidden lg:flex" : "flex"}`} aria-label="فهرست گفتگوها">
          <div className="border-b border-ink/10 p-3">
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink/45" />
              <input value={q} onChange={(e) => setQ(e.target.value)} className="input !min-h-[40px] pr-9 text-sm" placeholder="جستجوی نام، موبایل یا متن…" aria-label="جستجو در گفتگوها" />
            </div>
            <div className="mt-2 flex gap-1" role="tablist">
              {tabs.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={filter === t.id} onClick={() => setFilter(t.id)} className={`flex-1 rounded-xl px-1 py-1.5 text-[11px] font-black transition ${filter === t.id ? "bg-ink text-white" : "bg-stone-100 text-ink/70 hover:text-ink"}`}>
                  {t.label}
                  {t.n ? <span className="mr-1 opacity-70">{faNum(t.n)}</span> : null}
                </button>
              ))}
            </div>
          </div>
          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto" data-testid="chat-inbox">
            {!inbox ? (
              <div className="grid h-40 place-items-center"><LoaderCircle className="animate-spin text-ink/45" /></div>
            ) : items.length === 0 ? (
              <div className="grid place-items-center gap-2 px-6 py-14 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-stone-100 text-ink/60"><MessageSquareText size={22} /></span>
                <p className="text-sm font-black">گفتگویی در این بخش نیست</p>
                <p className="text-xs leading-6 text-ink/60">وقتی مشتری پیام بدهد، همین‌جا و به‌صورت زنده می‌بینید.</p>
              </div>
            ) : (
              items.map((c) => (
                <button key={c.code} type="button" onClick={() => setCode(c.code)} className={`flex w-full items-start gap-3 border-b border-ink/[0.06] px-3 py-3 text-right transition hover:bg-stone-50 ${code === c.code ? "bg-mint/15" : ""}`}>
                  <span className="relative grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-ink/[0.07] text-sm font-black">
                    {c.name.trim().slice(0, 1) || "؟"}
                    {c.requesterOnline && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-500" title="آنلاین" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <b className="truncate text-sm">{c.name}</b>
                      <span className="shrink-0 text-[10px] text-ink/50">{ago(c.at)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5">
                      <span className="rounded-md bg-ink/[0.07] px-1.5 py-0.5 text-[10px] font-bold text-ink/70">{CONTEXT_LABELS[c.contextKind]}</span>
                      {c.contractNumber && <span dir="ltr" className="truncate font-mono text-[10px] text-ink/55">{c.contractNumber}</span>}
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-2">
                      <span className={`truncate text-xs ${c.unread > 0 ? "font-black text-ink" : "text-ink/65"}`}>{c.lastBy === "staff" ? "شما: " : ""}{c.preview || "—"}</span>
                      {c.unread > 0 && <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-coral px-1 text-[10px] font-black text-white">{faNum(c.unread)}</span>}
                    </span>
                    {c.assigneeName && <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-bold text-ink/55"><UserCheck size={10} />{c.mine ? "شما" : c.assigneeName}</span>}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* ───── رشته‌ی گفتگو ───── */}
        <section className={`card flex min-h-0 flex-col !p-0 ${code ? "flex" : "hidden lg:flex"}`} aria-label="گفتگو">
          {!code ? (
            <div className="grid flex-1 place-items-center p-8 text-center">
              <div>
                <span className="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-mint/25"><MessageSquareText size={30} /></span>
                <p className="mt-4 text-base font-black">یک گفتگو را انتخاب کنید</p>
                <p className="mt-1 text-xs leading-7 text-ink/60">با کلید Enter پیام می‌فرستید و با Shift+Enter خط جدید می‌سازید.</p>
              </div>
            </div>
          ) : !thread || loadingThread ? (
            <div className="grid flex-1 place-items-center"><LoaderCircle className="animate-spin text-ink/45" /></div>
          ) : (
            <>
              <header className="flex flex-wrap items-center gap-2 border-b border-ink/10 p-3">
                <button type="button" onClick={() => setCode(null)} className="btn-ghost btn-sm lg:hidden" aria-label="بازگشت به فهرست"><ArrowRight size={16} /></button>
                <div className="min-w-0 flex-1">
                  <b className="block truncate text-sm">{ctx?.requester.name}</b>
                  <span className="flex items-center gap-1.5 text-[11px] text-ink/60">
                    <span className={`h-2 w-2 rounded-full ${ts?.requesterOnline ? "bg-emerald-500" : "bg-stone-400"}`} />
                    {ts?.requesterOnline ? "آنلاین" : "آفلاین"}
                    {ctx?.requester.mobile && <span dir="ltr" className="font-mono">· {ctx.requester.mobile}</span>}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {ts?.assigneeId === staffId ? (
                    <button type="button" disabled={busy} onClick={() => command("release")} className="btn-ghost btn-sm" title="رها کردن گفتگو برای همکاران"><UserMinus size={14} />رها کردن</button>
                  ) : (
                    <button type="button" disabled={busy || closed} onClick={() => command("claim")} className="btn-secondary btn-sm" title={ts?.assigneeId ? "گفتگو را از همکار بگیرید" : "مسئول این گفتگو شوید"}>
                      <UserCheck size={14} />{ts?.assigneeId ? `مسئول: ${assigneeLabel ?? "همکار"} — بگیر` : "برعهده می‌گیرم"}
                    </button>
                  )}
                  {thread.canTicket && !ts?.hasTicket && (
                    <button type="button" disabled={busy} onClick={() => command("ticket")} className="btn-secondary btn-sm" title="تبدیل به تیکت پشتیبانی"><LifeBuoy size={14} />تبدیل به تیکت</button>
                  )}
                  {closed ? (
                    <button type="button" disabled={busy} onClick={() => command("reopen")} className="btn-secondary btn-sm">بازکردن دوباره</button>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => command("close")} className="btn-danger btn-sm"><Check size={14} />بستن گفتگو</button>
                  )}
                  <button type="button" onClick={() => setShowCtx((v) => !v)} className="btn-ghost btn-sm xl:hidden" aria-expanded={showCtx}><Info size={14} />اطلاعات</button>
                </div>
              </header>

              {showCtx && ctx && <div className="max-h-[45%] overflow-y-auto border-b border-ink/10 p-3 xl:hidden"><ContextCard ctx={ctx} /></div>}

              <MessageList messages={messages} viewer="staff" seenUpTo={ts?.requesterReadId ?? 0} typing={!!ts?.requesterTyping && !closed} typingLabel="مشتری در حال نوشتن…" otherLabel={ctx?.requester.name ?? "مشتری"} onRetry={retry} />

              {error && <p role="alert" className="mx-3 mb-1 rounded-xl bg-rose-50 px-3 py-1.5 text-[11px] font-bold text-rose-700">{error}</p>}
              {thread.ticketNumber && <p className="mx-3 mb-1 rounded-xl bg-sky-50 px-3 py-1.5 text-[11px] font-bold text-sky-800">این گفتگو به تیکت <span dir="ltr" className="font-mono">{thread.ticketNumber}</span> تبدیل شده است.</p>}
              {ts?.rating ? <div className="flex items-center justify-center gap-2 pb-1 text-[11px] text-ink/60">امتیاز مشتری: <Stars value={ts.rating} size={15} /></div> : null}

              <div className="relative border-t border-ink/10 p-3">
                {showQuick && (
                  <div className="absolute bottom-full right-3 left-3 z-10 mb-2 max-h-56 overflow-y-auto rounded-2xl border border-ink/12 bg-white p-1.5 shadow-xl" role="menu">
                    {quick.map((r) => (
                      <button key={r.title} type="button" role="menuitem" onClick={() => { setDraft(r.text); setShowQuick(false); input.current?.focus(); }} className="block w-full rounded-xl px-3 py-2 text-right transition hover:bg-stone-100">
                        <b className="text-xs">{r.title}</b>
                        <span className="mt-0.5 line-clamp-2 block text-[11px] leading-5 text-ink/60">{r.text}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="mb-2 flex items-center gap-2">
                  <button type="button" onClick={() => setShowQuick((v) => !v)} className="btn-secondary btn-sm" aria-expanded={showQuick}><Zap size={14} />پاسخ آماده</button>
                  <label className={`flex cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[11px] font-black transition ${note ? "border-amber-300 bg-amber-50 text-amber-800" : "border-ink/12 text-ink/65"}`}>
                    <input type="checkbox" checked={note} onChange={(e) => setNote(e.target.checked)} className="sr-only" />
                    <StickyNote size={13} />یادداشت داخلی (مشتری نمی‌بیند)
                  </label>
                </div>
                <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex items-end gap-2">
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
                    rows={Math.min(5, Math.max(1, draft.split("\n").length))}
                    disabled={closed && !note}
                    className={`input flex-1 resize-none py-2.5 text-sm leading-6 ${note ? "!border-amber-300 !bg-amber-50/60" : ""}`}
                    placeholder={closed && !note ? "گفتگو بسته است؛ برای پاسخ آن را دوباره باز کنید." : note ? "یادداشت داخلی برای همکاران…" : "پاسخ خود را بنویسید…"}
                    aria-label="متن پاسخ"
                  />
                  <button type="submit" disabled={!draft.trim() || (closed && !note)} className="btn-primary h-11 w-11 shrink-0 !p-0 disabled:opacity-40" aria-label="ارسال"><Send size={18} className="-scale-x-100" /></button>
                </form>
              </div>
            </>
          )}
        </section>

        {/* ───── زمینه‌ی مشتری و قرارداد ───── */}
        <aside className="card hidden min-h-0 overflow-y-auto xl:block" aria-label="اطلاعات مشتری">
          {ctx ? <ContextCard ctx={ctx} /> : <div className="grid h-full place-items-center text-center text-xs leading-7 text-ink/55"><div><BellRing className="mx-auto mb-2" size={22} />اطلاعات مشتری و قرارداد مرتبط اینجا نمایش داده می‌شود.</div></div>}
        </aside>
      </div>
    </div>
  );
}
