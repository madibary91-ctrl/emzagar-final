"use client";

import { useEffect, useRef, useState } from "react";
import { BookMarked, LoaderCircle, RotateCcw, Sparkles, Wand2, X } from "lucide-react";

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
const KIND_FA: Record<string, string> = { sample: "نمونه", policy: "قانون", style: "راهنمای نگارش", clauses: "بند آماده" };

/** دستیار هوش مصنوعی نگارش قرارداد (GapGPT) — خروجی پیش از درج در ویرایشگر پیش‌نمایش داده می‌شود */
export default function AiWriter({ getHtml, onInsert }: { getHtml: () => string; onInsert: (html: string, mode: "replace" | "append") => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"generate" | "improve">("generate");
  const [prompt, setPrompt] = useState("");
  const [length, setLength] = useState("standard");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [personalize, setPersonalize] = useState(true);
  const [sources, setSources] = useState<Source[]>([]);
  const [usedMemory, setUsedMemory] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    fetch("/api/ai/contract", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => j.ok && setStatus({ configured: j.configured, used: j.used, limit: j.limit, knowledge: j.knowledge }))
      .catch(() => undefined);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    box.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function generate() {
    setLoading(true);
    setError("");
    setResult("");
    setSources([]);
    setUsedMemory(false);
    try {
      const res = await fetch("/api/ai/contract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, mode, length, personalize, existingHtml: mode === "improve" ? getHtml() : undefined }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) setError(j?.error || "خطا در ارتباط با سرور");
      else {
        setResult(j.html);
        setSources(Array.isArray(j.sources) ? j.sources : []);
        setUsedMemory(!!j.personalized);
        setStatus((s) => (s ? { ...s, used: s.limit - j.remaining } : s));
      }
    } catch {
      setError("ارتباط با سرور برقرار نشد");
    } finally {
      setLoading(false);
    }
  }

  const close = () => setOpen(false);

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

      {open && (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/55 p-3 backdrop-blur-sm" onClick={close} role="presentation">
          <div
            ref={box}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="دستیار هوش مصنوعی"
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl outline-none"
          >
            <div className="flex items-center justify-between border-b border-ink/10 px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-mint"><Wand2 size={18} /></span>
                <div>
                  <b className="block text-sm">دستیار هوشمند نگارش قرارداد</b>
                  <span className="text-xs text-ink/72">
                    {status ? (status.configured ? `سهمیه‌ی امروز: ${status.used.toLocaleString("fa-IR")} از ${status.limit.toLocaleString("fa-IR")}` : "هنوز فعال نشده") : "…"}
                  </span>
                </div>
              </div>
              <button type="button" onClick={close} aria-label="بستن" className="grid h-9 w-9 place-items-center rounded-xl bg-stone-100"><X size={17} /></button>
            </div>

            <div className="thin-scroll space-y-4 overflow-y-auto p-5">
              {status && !status.configured && (
                <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-7 text-amber-800">
                  برای فعال‌سازی، کلید API خود را در <a href="/admin/settings#ai" className="font-bold underline">تنظیمات ← هوش مصنوعی</a> وارد کنید.
                </p>
              )}

              {status?.knowledge && (status.knowledge.activeDocs > 0 || status.knowledge.hasInstructions || status.knowledge.hasProfile) && status.knowledge.enabled ? (
                <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3 text-xs leading-6" data-testid="ai-memory-toggle">
                  <input type="checkbox" checked={personalize} onChange={(e) => setPersonalize(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--ink)]" />
                  <span>
                    <b className="flex items-center gap-1"><BookMarked size={13} />با حافظه‌ی حقوقی من بنویس</b>
                    لحن، قوانین و بندهای {status.knowledge.activeDocs.toLocaleString("fa-IR")} سند شما رعایت می‌شود. <a href="/admin/knowledge" className="font-bold underline">مدیریت حافظه</a>
                  </span>
                </label>
              ) : (
                status?.knowledge && (
                  <p className="rounded-xl border border-ink/10 bg-stone-50 p-3 text-xs leading-6 text-ink/75">
                    می‌خواهید متن‌ها دقیقاً به لحن و قوانین شما نوشته شوند؟ <a href="/admin/knowledge" className="font-bold underline">اسناد خود را در حافظه‌ی حقوقی بگذارید</a>.
                  </p>
                )
              )}

              <div className="inline-flex rounded-xl bg-stone-100 p-1 text-xs font-bold">
                {([["generate", "نوشتن متن جدید"], ["improve", "بهبود متن فعلی ویرایشگر"]] as const).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setMode(k)} className={`rounded-lg px-3 py-1.5 transition ${mode === k ? "bg-white shadow" : "text-ink/75"}`}>{l}</button>
                ))}
              </div>

              <div>
                <label className="label" htmlFor="ai-prompt">{mode === "generate" ? "چه قراردادی لازم دارید؟" : "چه تغییری می‌خواهید؟"}</label>
                <textarea
                  id="ai-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  maxLength={2000}
                  rows={4}
                  className="input !h-auto py-3 leading-7"
                  placeholder={mode === "generate" ? "مثلاً: قرارداد طراحی سایت فروشگاهی، مدت ۲ ماه، پرداخت ۳ مرحله‌ای، ۳ ماه پشتیبانی رایگان…" : "مثلاً: بند جریمه‌ی تأخیر را اضافه کن و لحن را رسمی‌تر کن"}
                />
                <div className="mt-1 text-left text-xs text-ink/72">{prompt.length.toLocaleString("fa-IR")} / ۲٬۰۰۰</div>
              </div>

              {mode === "generate" && (
                <>
                  <div className="flex flex-wrap gap-2">
                    {IDEAS.map((i) => (
                      <button key={i} type="button" onClick={() => setPrompt(i)} className="rounded-full border border-ink/10 bg-stone-50 px-3 py-1 text-xs text-ink/72 hover:bg-white">{i.split(" با ")[0].split(" به ")[0]}</button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-bold text-ink/75">میزان تفصیل:</span>
                    {([["short", "خلاصه"], ["standard", "استاندارد"], ["detailed", "کامل"]] as const).map(([k, l]) => (
                      <button key={k} type="button" onClick={() => setLength(k)} className={`rounded-lg border px-3 py-1.5 font-semibold ${length === k ? "border-ink bg-ink text-white" : "border-ink/10 bg-white text-ink/75"}`}>{l}</button>
                    ))}
                  </div>
                </>
              )}

              {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}

              {loading && (
                <div className="flex items-center gap-3 rounded-2xl bg-stone-50 p-5 text-xs text-ink/75">
                  <LoaderCircle size={18} className="animate-spin" />
                  در حال نگارش قرارداد… این کار معمولاً ۲۰ تا ۶۰ ثانیه طول می‌کشد.
                </div>
              )}

              {result && !loading && (
                <div>
                  <div className="mb-2 text-xs font-bold text-ink/75">پیش‌نمایش (پیش از درج می‌توانید آن را بررسی کنید):</div>
                  <div className="contract-body thin-scroll max-h-72 overflow-y-auto rounded-2xl border border-ink/10 bg-stone-50 p-4 text-sm" dangerouslySetInnerHTML={{ __html: result }} />
                  {usedMemory && (
                    <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-6 text-emerald-900" data-testid="ai-sources">
                      <b>با حافظه‌ی شما نوشته شد.</b>{sources.length > 0 && " منابع استفاده‌شده: "}
                      {sources.map((x) => <span key={x.id} className="me-1.5 inline-block rounded-full bg-white px-2 py-0.5 text-[11px]">{x.title} · {KIND_FA[x.kind] ?? x.kind}</span>)}
                    </div>
                  )}
                  <p className="mt-2 text-xs leading-6 text-ink/72">متن تولیدشده پیش‌نویس است؛ پیش از استفاده حتماً توسط شما (یا مشاور حقوقی) بازبینی شود.</p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink/10 bg-stone-50 px-5 py-3">
              <button type="button" onClick={generate} disabled={loading || prompt.trim().length < 8 || (status !== null && !status.configured)} className="btn-primary btn-sm disabled:opacity-50">
                {result ? <RotateCcw size={14} /> : <Sparkles size={14} />}
                {result ? "تولید دوباره" : "تولید متن"}
              </button>
              {result && !loading && (
                <div className="flex gap-2">
                  <button type="button" className="btn-secondary btn-sm" onClick={() => { onInsert(result, "append"); close(); }}>افزودن به انتهای متن</button>
                  <button type="button" className="btn-primary btn-mint btn-sm" onClick={() => { onInsert(result, "replace"); close(); }}>جایگزینی متن ویرایشگر</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
