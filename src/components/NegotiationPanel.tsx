"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CornerDownLeft, Eye, EyeOff, Lock, MessageSquareText, PenLine, Quote, RotateCcw, Send, TextSelect, Users } from "lucide-react";
import { guestPostCommentAction, postCommentAction, resolveCommentAction, type CommentPayload, type CommentResult } from "@/modules/contracts/negotiation-actions";

export interface PanelComment {
  id: number;
  parentId: number | null;
  authorName: string;
  authorSide: string;
  visibility: string;
  kind: string;
  quote: string;
  body: string;
  status: string;
  at: string;
  resolvedAt: string | null;
}

export type PanelMode =
  | { kind: "user"; contractId: number; isTeam: boolean; canResolve: boolean; draft: boolean }
  | { kind: "guest"; token: string };

type Filter = "all" | "shared" | "internal";

/**
 * پنل «مذاکره و پیام‌ها»: گفتگوی رشته‌ای روی خودِ قرارداد، با یادداشت داخلی تیم، پیام مشترک با طرف مقابل،
 * درخواست اصلاح همراه با نقل‌قول بند، و بستن موضوع. در صفحه‌ی امضای مهمان هم (با لینک اختصاصی) کار می‌کند.
 */
export default function NegotiationPanel({ comments, mode, articleId = "contract-article", readOnly = false }: { comments: PanelComment[]; mode: PanelMode; articleId?: string; readOnly?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const isTeam = mode.kind === "user" && mode.isTeam;
  const draft = mode.kind === "user" && mode.draft;
  const [filter, setFilter] = useState<Filter>("all");
  const [body, setBody] = useState("");
  const [quote, setQuote] = useState("");
  const [visibility, setVisibility] = useState<"shared" | "internal">(draft ? "internal" : "shared");
  const [changeReq, setChangeReq] = useState(false);
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [error, setError] = useState("");

  const roots = useMemo(() => comments.filter((c) => !c.parentId), [comments]);
  const repliesOf = (id: number) => comments.filter((c) => c.parentId === id);
  const visible = roots.filter((c) => filter === "all" || c.visibility === filter);
  const openReqs = roots.filter((c) => c.kind === "change_request" && c.status === "open").length;

  const send = (payload: CommentPayload): Promise<CommentResult> =>
    mode.kind === "guest" ? guestPostCommentAction(mode.token, payload) : postCommentAction(mode.contractId, payload);

  const submit = (payload: CommentPayload, after: () => void) => {
    setError("");
    start(async () => {
      const res = await send(payload);
      if (!res.ok) {
        setError(res.error ?? "خطا در ارسال");
        return;
      }
      after();
      router.refresh();
    });
  };

  const grabSelection = () => {
    const sel = window.getSelection();
    const text = sel?.toString().replace(/\s+/g, " ").trim() ?? "";
    const article = document.getElementById(articleId);
    if (!text || !article || !sel?.anchorNode || !article.contains(sel.anchorNode)) {
      setError("ابتدا بخشی از متن قرارداد را (با ماوس یا انگشت) انتخاب کنید");
      return;
    }
    setError("");
    setQuote(text.slice(0, 400));
  };

  const resolve = (id: number, resolved: boolean) => {
    if (mode.kind !== "user") return;
    start(async () => {
      const res = await resolveCommentAction(mode.contractId, id, resolved);
      if (!res.ok) setError(res.error ?? "خطا");
      else router.refresh();
    });
  };

  return (
    <section id="negotiation" className="panel-solid scroll-mt-24 space-y-4 p-5 sm:p-6" aria-labelledby="negotiation-title">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-mint"><MessageSquareText size={18} /></span>
        <div className="min-w-0 flex-1">
          <h2 id="negotiation-title" className="text-sm font-black">مذاکره و پیام‌ها</h2>
          <p className="mt-0.5 text-xs text-ink/72">
            {mode.kind === "guest"
              ? "اگر پیش از امضا نیاز به اصلاح یا توضیح دارید، همین‌جا بنویسید. پیام شما فوراً به صادرکننده‌ی قرارداد اطلاع داده می‌شود."
              : isTeam
                ? "گفتگو با طرف‌های قرارداد و یادداشت‌های داخلی تیم؛ همه‌چیز در شناسنامه‌ی دیجیتال ثبت می‌شود."
                : "پیام یا درخواست اصلاح خود را برای صادرکننده‌ی قرارداد بنویسید."}
          </p>
        </div>
        {openReqs > 0 && <span className="badge border border-rose-200 bg-rose-50 text-rose-700">{openReqs.toLocaleString("fa-IR")} درخواست اصلاح باز</span>}
      </div>

      {isTeam && (
        <div role="tablist" aria-label="فیلتر پیام‌ها" className="flex flex-wrap gap-1.5">
          {([["all", "همه", Users], ["shared", "مشترک با طرف مقابل", Eye], ["internal", "یادداشت داخلی", Lock]] as [Filter, string, typeof Users][]).map(([k, l, Icon]) => (
            <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${filter === k ? "border-ink bg-ink text-white" : "border-ink/15 bg-white hover:bg-stone-50"}`}>
              <Icon size={12} />{l}
            </button>
          ))}
        </div>
      )}

      <ul className="space-y-3">
        {visible.length === 0 && <li className="rounded-2xl bg-stone-50 p-4 text-center text-xs text-ink/72">هنوز پیامی ثبت نشده است.</li>}
        {visible.map((c) => {
          const replies = repliesOf(c.id);
          const internal = c.visibility === "internal";
          const resolved = c.status === "resolved";
          return (
            <li key={c.id} className={`rounded-2xl border p-4 ${internal ? "border-amber-200 bg-amber-50/60" : c.kind === "change_request" && !resolved ? "border-rose-200 bg-rose-50/50" : "border-ink/10 bg-stone-50/60"} ${resolved ? "opacity-75" : ""}`}>
              <Message c={c} />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {!readOnly && <button type="button" onClick={() => { setReplyTo(replyTo === c.id ? null : c.id); setReplyBody(""); }} className="btn-ghost btn-sm !px-2"><CornerDownLeft size={13} />پاسخ</button>}
                {mode.kind === "user" && mode.canResolve && !readOnly && (
                  <button type="button" disabled={pending} onClick={() => resolve(c.id, !resolved)} className="btn-ghost btn-sm !px-2">
                    {resolved ? <><RotateCcw size={13} />بازکردن مجدد</> : <><CheckCircle2 size={13} />بستن موضوع</>}
                  </button>
                )}
                {resolved && <span className="badge border border-emerald-200 bg-emerald-50 text-emerald-700">بسته شد{c.resolvedAt ? ` • ${c.resolvedAt}` : ""}</span>}
              </div>
              {replies.length > 0 && (
                <ul className="mt-3 space-y-2 border-r-2 border-ink/10 pr-3">
                  {replies.map((r) => (
                    <li key={r.id} className="rounded-xl bg-white/80 p-3"><Message c={r} compact /></li>
                  ))}
                </ul>
              )}
              {replyTo === c.id && (
                <form
                  className="mt-3 flex flex-col gap-2 sm:flex-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submit({ body: replyBody, parentId: c.id, visibility: internal ? "internal" : "shared" }, () => { setReplyBody(""); setReplyTo(null); });
                  }}
                >
                  <label className="sr-only" htmlFor={`reply-${c.id}`}>متن پاسخ</label>
                  <textarea id={`reply-${c.id}`} value={replyBody} onChange={(e) => setReplyBody(e.target.value)} rows={2} maxLength={2000} required className="input flex-1" placeholder="پاسخ شما…" />
                  <button disabled={pending || replyBody.trim().length < 2} className="btn-primary self-end"><Send size={14} />ارسال</button>
                </form>
              )}
            </li>
          );
        })}
      </ul>

      {!readOnly && <form
        className="space-y-3 rounded-2xl border border-dashed border-ink/20 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit({ body, quote, visibility: draft ? "internal" : isTeam ? visibility : "shared", kind: changeReq && !isTeam ? "change_request" : "comment" }, () => {
            setBody("");
            setQuote("");
            setChangeReq(false);
          });
        }}
      >
        <h3 className="flex items-center gap-2 text-xs font-black"><PenLine size={14} />{draft ? "یادداشت داخلی جدید" : "پیام جدید"}</h3>
        {isTeam && !draft && (
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="گیرنده‌ی پیام">
            <button type="button" role="radio" aria-checked={visibility === "shared"} onClick={() => setVisibility("shared")} className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold ${visibility === "shared" ? "border-ink bg-ink text-white" : "border-ink/15 bg-white"}`}><Eye size={13} />مشترک با طرف‌های قرارداد</button>
            <button type="button" role="radio" aria-checked={visibility === "internal"} onClick={() => setVisibility("internal")} className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold ${visibility === "internal" ? "border-amber-600 bg-amber-500 text-white" : "border-ink/15 bg-white"}`}><EyeOff size={13} />یادداشت داخلی (فقط تیم)</button>
          </div>
        )}
        {quote && (
          <div className="flex items-start gap-2 rounded-xl border border-ink/10 bg-white p-3 text-xs leading-6">
            <Quote size={14} className="mt-1 shrink-0 text-ink/50" />
            <span className="min-w-0 flex-1 break-words text-ink/80">{quote}</span>
            <button type="button" onClick={() => setQuote("")} className="text-ink/60 hover:text-ink" aria-label="حذف نقل‌قول">✕</button>
          </div>
        )}
        <label className="sr-only" htmlFor="neg-body">متن پیام</label>
        <textarea id="neg-body" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={2000} required className="input" placeholder={draft ? "مثلاً: بند پرداخت باید با مالی هماهنگ شود…" : isTeam ? "پیام یا توضیح برای طرف‌های قرارداد…" : "مثلاً: لطفاً مدت قرارداد در ماده ۳ به ۶ ماه اصلاح شود…"} />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={grabSelection} className="btn-secondary btn-sm"><TextSelect size={14} />نقل‌قول از متن قرارداد</button>
          {!isTeam && (
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-ink/80">
              <input type="checkbox" checked={changeReq} onChange={(e) => setChangeReq(e.target.checked)} className="h-4 w-4 accent-[var(--ink)]" />
              این یک «درخواست اصلاح متن» است
            </label>
          )}
          <span className="flex-1" />
          <span className="text-[11px] text-ink/60">{body.length.toLocaleString("fa-IR")} / ۲٬۰۰۰</span>
          <button disabled={pending || body.trim().length < 2} className="btn-primary btn-mint"><Send size={14} />{pending ? "در حال ارسال…" : "ارسال"}</button>
        </div>
        {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
      </form>}
    </section>
  );
}

function Message({ c, compact }: { c: PanelComment; compact?: boolean }) {
  const internal = c.visibility === "internal";
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <b>{c.authorName || "—"}</b>
        <span className={`badge border ${c.authorSide === "team" ? "border-sky-200 bg-sky-50 text-sky-800" : "border-violet-200 bg-violet-50 text-violet-800"}`}>{c.authorSide === "team" ? "تیم" : "طرف قرارداد"}</span>
        {internal && <span className="badge border border-amber-300 bg-amber-100 text-amber-900"><Lock size={11} />فقط تیم</span>}
        {c.kind === "change_request" && <span className="badge border border-rose-200 bg-rose-50 text-rose-700">درخواست اصلاح</span>}
        <span className="text-ink/60">{c.at}</span>
      </div>
      {c.quote && !compact && <blockquote className="mt-2 border-r-4 border-ink/20 bg-white/70 px-3 py-2 text-xs leading-6 text-ink/75">«{c.quote}»</blockquote>}
      <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-7">{c.body}</p>
    </div>
  );
}
