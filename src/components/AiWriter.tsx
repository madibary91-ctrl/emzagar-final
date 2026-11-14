"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, BookMarked, FilePlus2, LoaderCircle, PencilLine, Replace, RotateCcw, Sparkles, Undo2, User, Wand2, X } from "lucide-react";
import { countHtmlWords, sanitizeForInsert } from "@/lib/html-client";

const IDEAS = [
  "قرارداد طراحی و توسعه‌ی وب‌سایت با پرداخت سه‌مرحله‌ای و پشتیبانی ۳ ماهه",
  "قرارداد همکاری فریلنسری با تحویل مرحله‌ای و حق‌الزحمه‌ی ماهانه",
  "تعهدنامه محرمانگی (NDA) یک‌طرفه برای پیمانکار با مدت اعتبار ۲ سال",
  "قرارداد اجاره‌ی تجهیزات به مدت ۶ ماه با ودیعه و جریمه‌ی دیرکرد",
  "قرارداد فروش اقساطی کالا با چک تضمین",
];

type Knowledge = { enabled: boolean; docs: number; activeDocs: number; hasProfile: boolean; hasInstructions: boolean };
type Source = { id: number; title: string; kind: string };
type Status = { configured: boolean; used: number; limit: number; knowledge?: Knowledge } | null;
type Mode = "generate" | "improve";
type Turn =
  | { id: number; role: "user"; text: string; mode: Mode; refined: boolean }
  | { id: number; role: "ai"; html: string; sources: Source[]; memory: boolean; edited: boolean }
  | { id: number; role: "error"; text: string };
const KIND_FA: Record<string, string> = { sample: "نمونه", policy: "قانون", style: "راهنمای نگارش", clauses: "بند آماده" };

/**
 * دستیار هوش مصنوعی نگارش قرارداد — رابط گفتگو (مثل ChatGPT): گفتگو و پاسخ‌ها بالا، کادر تایپ ثابت پایین.
 * خروجی هر پاسخ پیش از درج در ویرایشگر قابل ویرایش و پیش‌نمایش است.
 */
export default function AiWriter({ getHtml, onInsert }: { getHtml: () => string; onInsert: (html: string, mode: "replace" | "append") => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("generate");
  const [prompt, setPrompt] = useState("");
  const [length, setLength] = useState("standard");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [personalize, setPersonalize] = useState(true);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [refineId, setRefineId] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const threadEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const drafts = useRef<Record<number, HTMLDivElement | null>>({});
  const nextId = useRef(1);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const loadingRef = useRef(false);
  loadingRef.current = loading;

  /** پیش‌نویس تولیدشده تا درج نشده، ارزش از دست رفتن دارد */
  const hasUnsaved = () => turnsRef.current.some((t) => t.role === "ai") && !loadingRef.current;
  const requestClose = () => {
    if (hasUnsaved() && !window.confirm("پیش‌نویس هوش مصنوعی هنوز در قرارداد درج نشده است. بستن و از دست دادن آن؟")) return;
    setOpen(false);
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  useEffect(() => {
    if (!open) return;
    fetch("/api/ai/contract", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => j.ok && setStatus({ configured: j.configured, used: j.used, limit: j.limit, knowledge: j.knowledge }))
      .catch(() => undefined);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && requestCloseRef.current();
    window.addEventListener("keydown", onKey);
    // فضای کامل صفحه در اختیار دستیار است؛ پس‌زمینه نباید اسکرول شود
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // پیام تازه ← اسکرول به پایین گفتگو
  useEffect(() => {
    threadEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, loading]);

  const configured = status === null || status.configured;
  const canSend = !loading && prompt.trim().length >= 8 && configured;
  const hasResult = turns.some((t) => t.role === "ai");

  async function generate() {
    if (!canSend) return;
    const text = prompt.trim();
    const refineTurn = refineId !== null ? turns.find((t): t is Extract<Turn, { role: "ai" }> => t.role === "ai" && t.id === refineId) : undefined;
    const effMode: Mode = refineTurn ? "improve" : mode;
    const existingHtml = refineTurn ? (drafts.current[refineTurn.id]?.innerHTML ?? refineTurn.html) : effMode === "improve" ? getHtml() : undefined;
    setTurns((t) => [...t, { id: nextId.current++, role: "user", text, mode: effMode, refined: !!refineTurn }]);
    setPrompt("");
    setRefineId(null);
    setLoading(true);
    try {
      const res = await fetch("/api/ai/contract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, mode: effMode, length, personalize, existingHtml }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) {
        setTurns((t) => [...t, { id: nextId.current++, role: "error", text: j?.error || "خطا در ارتباط با سرور" }]);
      } else {
        setTurns((t) => [...t, { id: nextId.current++, role: "ai", html: j.html, sources: Array.isArray(j.sources) ? j.sources : [], memory: !!j.personalized, edited: false }]);
        setStatus((s) => (s ? { ...s, used: s.limit - j.remaining } : s));
      }
    } catch {
      setTurns((t) => [...t, { id: nextId.current++, role: "error", text: "ارتباط با سرور برقرار نشد" }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  const insert = (turn: Extract<Turn, { role: "ai" }>, how: "replace" | "append") => {
    const html = sanitizeForInsert(drafts.current[turn.id]?.innerHTML ?? turn.html);
    onInsert(html, how);
    // درج انجام شد؛ گفتگو پاک می‌شود تا بستن بعدی هشدار ندهد
    setTurns([]);
    setRefineId(null);
    setOpen(false);
  };
  const resetDraft = (turn: Extract<Turn, { role: "ai" }>) => {
    const el = drafts.current[turn.id];
    if (el) el.innerHTML = turn.html;
    setTurns((t) => t.map((x) => (x.id === turn.id && x.role === "ai" ? { ...x, edited: false } : x)));
  };
  const markEdited = (id: number) => setTurns((t) => t.map((x) => (x.id === id && x.role === "ai" && !x.edited ? { ...x, edited: true } : x)));

  const knowledge = status?.knowledge;
  const memoryAvailable = !!knowledge && knowledge.enabled && (knowledge.activeDocs > 0 || knowledge.hasInstructions || knowledge.hasProfile);
  const lastAiId = [...turns].reverse().find((t) => t.role === "ai")?.id;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1 text-xs font-bold text-white shadow-sm transition hover:opacity-90"
      >
        <Sparkles size={13} className="text-mint" />
        نوشتن با هوش مصنوعی
      </button>

      {open &&
        createPortal(
          <div
            ref={box}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="دستیار هوش مصنوعی"
            className="fixed inset-0 z-[90] flex flex-col bg-stone-100 text-ink outline-none"
            dir="rtl"
          >
            {/* ── سربرگ ── */}
            <header className="flex items-center justify-between gap-3 border-b border-ink/10 bg-white px-4 py-3 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ink text-mint"><Wand2 size={18} /></span>
                <div className="min-w-0">
                  <b className="block truncate text-sm">دستیار هوشمند نگارش قرارداد</b>
                  <span className="text-xs text-ink/72">
                    {status ? (status.configured ? `سهمیه‌ی امروز: ${status.used.toLocaleString("fa-IR")} از ${status.limit.toLocaleString("fa-IR")}` : "هنوز فعال نشده") : "…"}
                  </span>
                </div>
              </div>
              <button type="button" onClick={requestClose} aria-label="بستن" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-stone-100 hover:bg-stone-200"><X size={18} /></button>
            </header>

            {/* ── گفتگو (بالا) ── */}
            <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6" aria-live="polite" data-testid="ai-thread">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
                {status && !status.configured && (
                  <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-7 text-amber-800">
                    برای فعال‌سازی، کلید API خود را در <a href="/admin/settings#ai" className="font-bold underline">تنظیمات ← هوش مصنوعی</a> وارد کنید.
                  </p>
                )}

                {turns.length === 0 && !loading && (
                  <div className="grid min-h-[40vh] place-items-center text-center">
                    <div className="max-w-xl space-y-4">
                      <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-ink text-mint"><Sparkles size={24} /></span>
                      <h2 className="text-lg font-black">چه قراردادی لازم دارید؟</h2>
                      <p className="text-xs leading-7 text-ink/72">موضوع، طرفین، مبلغ و مدت را در کادر پایین بنویسید؛ پاسخ همین‌جا بالای کادر می‌آید و پیش از درج در ویرایشگر قابل ویرایش است.</p>
                      <div className="flex flex-wrap justify-center gap-2">
                        {IDEAS.map((i) => (
                          <button key={i} type="button" onClick={() => { setMode("generate"); setPrompt(i); inputRef.current?.focus(); }} className="rounded-full border border-ink/10 bg-white px-3 py-1.5 text-xs text-ink/75 shadow-sm hover:border-ink/30">{i.split(" با ")[0].split(" به ")[0]}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {turns.map((t) => {
                  if (t.role === "user")
                    return (
                      <div key={t.id} className="flex items-start gap-3">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink/10 text-ink"><User size={15} /></span>
                        <div className="min-w-0 max-w-[90%] rounded-2xl rounded-ss-sm bg-white px-4 py-3 text-sm leading-7 shadow-sm">
                          <span className="mb-1 block text-[11px] font-bold text-ink/60">{t.refined ? "بهبود پیش‌نویس انتخاب‌شده" : t.mode === "improve" ? "بهبود متن فعلی ویرایشگر" : "متن جدید"}</span>
                          <p className="whitespace-pre-wrap break-words">{t.text}</p>
                        </div>
                      </div>
                    );
                  if (t.role === "error")
                    return (
                      <div key={t.id} className="flex items-start gap-3">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-rose-100 text-rose-700"><X size={15} /></span>
                        <p role="alert" data-persist="true" className="rounded-2xl rounded-ss-sm border border-rose-200 bg-rose-50 px-4 py-3 text-xs leading-7 text-rose-700">{t.text}</p>
                      </div>
                    );
                  const words = countHtmlWords(t.html);
                  return (
                    <div key={t.id} className="flex items-start gap-3">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink text-mint"><Sparkles size={15} /></span>
                      <div className="min-w-0 flex-1 space-y-3">
                        {t.memory && (
                          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-6 text-emerald-900" data-testid="ai-sources">
                            <b>با حافظه‌ی شما نوشته شد.</b>{t.sources.length > 0 && " منابع استفاده‌شده: "}
                            {t.sources.map((x) => <span key={x.id} className="me-1.5 inline-block rounded-full bg-white px-2 py-0.5 text-[11px]">{x.title} · {KIND_FA[x.kind] ?? x.kind}</span>)}
                          </div>
                        )}
                        <div className="overflow-hidden rounded-2xl rounded-ss-sm border border-ink/10 bg-white shadow-sm">
                          <div className="flex flex-wrap items-center gap-2 border-b border-ink/10 bg-stone-50 px-4 py-2 text-xs text-ink/72">
                            <PencilLine size={13} />
                            <span>پیش‌نمایش قابل ویرایش · {words.toLocaleString("fa-IR")} کلمه{t.edited ? " · ویرایش‌شده" : ""}</span>
                            {t.edited && <button type="button" onClick={() => resetDraft(t)} className="ms-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 font-bold hover:bg-white"><Undo2 size={13} />بازگشت به خروجی اصلی</button>}
                          </div>
                          <div
                            ref={(el) => { drafts.current[t.id] = el; }}
                            contentEditable
                            suppressContentEditableWarning
                            role="textbox"
                            aria-multiline="true"
                            aria-label="ویرایش پیش‌نویس هوش مصنوعی"
                            onInput={() => markEdited(t.id)}
                            className="contract-body max-h-[55vh] min-h-32 overflow-y-auto p-5 outline-none focus:bg-stone-50/40 sm:p-7"
                            dangerouslySetInnerHTML={{ __html: t.html }}
                          />
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button type="button" className="btn-primary btn-mint btn-sm" onClick={() => insert(t, "replace")}><Replace size={14} />جایگزینی متن ویرایشگر</button>
                          <button type="button" className="btn-secondary btn-sm" onClick={() => insert(t, "append")}><FilePlus2 size={14} />افزودن به انتهای متن</button>
                          <button type="button" className="btn-secondary btn-sm" onClick={() => { setRefineId(t.id); inputRef.current?.focus(); }} aria-pressed={refineId === t.id}><Wand2 size={14} />ادامه و اصلاح همین پیش‌نویس</button>
                        </div>
                        {t.id === lastAiId && <p className="text-[11px] leading-6 text-ink/60">متن تولیدشده پیش‌نویس است؛ پیش از استفاده حتماً توسط شما (یا مشاور حقوقی) بازبینی شود.</p>}
                      </div>
                    </div>
                  );
                })}

                {loading && (
                  <div className="flex items-start gap-3" role="status">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink text-mint"><Sparkles size={15} /></span>
                    <div className="flex items-center gap-3 rounded-2xl rounded-ss-sm bg-white px-4 py-3 text-xs text-ink/75 shadow-sm">
                      <LoaderCircle size={16} className="animate-spin" />
                      در حال نگارش قرارداد… این کار معمولاً ۲۰ تا ۶۰ ثانیه طول می‌کشد.
                    </div>
                  </div>
                )}
                <div ref={threadEnd} />
              </div>
            </div>

            {/* ── کادر تایپ (پایین، ثابت) ── */}
            <footer className="border-t border-ink/10 bg-white px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
              <div className="mx-auto w-full max-w-3xl space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <div className="inline-flex rounded-xl bg-stone-100 p-1 font-bold">
                    {([["generate", "نوشتن متن جدید"], ["improve", "بهبود متن فعلی ویرایشگر"]] as const).map(([k, l]) => (
                      <button key={k} type="button" onClick={() => { setMode(k); setRefineId(null); }} aria-pressed={mode === k && refineId === null} className={`rounded-lg px-3 py-1.5 transition ${mode === k && refineId === null ? "bg-white shadow" : "text-ink/75"}`}>{l}</button>
                    ))}
                  </div>
                  {mode === "generate" && refineId === null && (
                    <div className="flex items-center gap-1">
                      <span className="font-bold text-ink/75">تفصیل:</span>
                      {([["short", "خلاصه"], ["standard", "استاندارد"], ["detailed", "کامل"]] as const).map(([k, l]) => (
                        <button key={k} type="button" onClick={() => setLength(k)} aria-pressed={length === k} className={`rounded-lg border px-2.5 py-1 font-semibold ${length === k ? "border-ink bg-ink text-white" : "border-ink/10 bg-white text-ink/75"}`}>{l}</button>
                      ))}
                    </div>
                  )}
                  {memoryAvailable ? (
                    <label className="ms-auto inline-flex cursor-pointer items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-1.5 font-semibold" data-testid="ai-memory-toggle">
                      <input type="checkbox" checked={personalize} onChange={(e) => setPersonalize(e.target.checked)} className="h-4 w-4 accent-[var(--ink)]" />
                      <BookMarked size={13} />با حافظه‌ی حقوقی من بنویس ({knowledge!.activeDocs.toLocaleString("fa-IR")} سند)
                    </label>
                  ) : (
                    knowledge && <a href="/admin/knowledge" className="ms-auto text-ink/72 underline">اسناد خود را در حافظه‌ی حقوقی بگذارید</a>
                  )}
                </div>

                {refineId !== null && (
                  <div className="flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs text-sky-900">
                    <Wand2 size={13} />تغییر درخواستی روی همان پیش‌نویسِ انتخاب‌شده اعمال می‌شود.
                    <button type="button" onClick={() => setRefineId(null)} className="ms-auto font-bold underline">لغو</button>
                  </div>
                )}

                <div className="flex items-end gap-2 rounded-2xl border border-ink/20 bg-white p-2 shadow-sm transition focus-within:border-[#3f9c7d] focus-within:shadow-[0_0_0_4px_rgba(65,228,173,.22)]">
                  <label className="sr-only" htmlFor="ai-prompt">{mode === "generate" && refineId === null ? "چه قراردادی لازم دارید؟" : "چه تغییری می‌خواهید؟"}</label>
                  <textarea
                    id="ai-prompt"
                    ref={inputRef}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void generate();
                      }
                    }}
                    maxLength={2000}
                    rows={2}
                    className="max-h-48 min-h-12 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-7 outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:shadow-none"
                    placeholder={mode === "generate" && refineId === null ? "مثلاً: قرارداد طراحی سایت فروشگاهی، مدت ۲ ماه، پرداخت ۳ مرحله‌ای، ۳ ماه پشتیبانی رایگان…" : "مثلاً: بند جریمه‌ی تأخیر را اضافه کن و لحن را رسمی‌تر کن"}
                  />
                  <button
                    type="button"
                    onClick={() => void generate()}
                    disabled={!canSend}
                    className="btn-primary btn-sm shrink-0 disabled:opacity-50"
                  >
                    {hasResult ? <RotateCcw size={14} /> : <ArrowUp size={14} />}
                    {hasResult ? "تولید دوباره" : "تولید متن"}
                  </button>
                </div>
                <div className="flex justify-between text-[11px] text-ink/60">
                  <span>Enter = ارسال · Shift+Enter = خط جدید</span>
                  <span>{prompt.length.toLocaleString("fa-IR")} / ۲٬۰۰۰</span>
                </div>
              </div>
            </footer>
          </div>,
          document.body,
        )}
    </>
  );
}
