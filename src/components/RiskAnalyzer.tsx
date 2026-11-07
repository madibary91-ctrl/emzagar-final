"use client";

import { useActionState, useState } from "react";
import { AlertTriangle, CheckCircle2, Lightbulb, Loader2, ScanSearch, Sparkles, XCircle } from "lucide-react";
import { analyzeRiskAction, type RiskState } from "@/modules/risk/actions";
import { LEVEL_LABELS, SEVERITY_LABELS, type Level, type RiskResult, type Severity } from "@/modules/risk/rules";

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
const LEVEL_COLOR: Record<Level, string> = { low: "#16a34a", medium: "#d97706", high: "#ea580c", critical: "#dc2626" };
const SEV_STYLE: Record<Severity, string> = {
  high: "border-red-200 bg-red-50 text-red-800",
  medium: "border-amber-200 bg-amber-50 text-amber-900",
  low: "border-sky-200 bg-sky-50 text-sky-900",
  info: "border-ink/10 bg-stone-50 text-ink/80",
};

export function RiskGauge({ score, level }: { score: number; level: Level }) {
  const r = 70;
  const c = Math.PI * r;
  const color = LEVEL_COLOR[level];
  return (
    <div className="relative mx-auto w-[200px]" role="img" aria-label={`امتیاز ریسک ${score} از ۱۰۰ — ${LEVEL_LABELS[level]}`}>
      <svg viewBox="0 0 180 100" className="w-full">
        <path d="M20 90 A70 70 0 0 1 160 90" fill="none" stroke="rgba(16,44,49,.1)" strokeWidth="14" strokeLinecap="round" />
        <path d="M20 90 A70 70 0 0 1 160 90" fill="none" stroke={color} strokeWidth="14" strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`} style={{ transition: "stroke-dasharray .8s ease" }} />
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <b className="block text-3xl font-black leading-none" style={{ color }}>{fn(score)}</b>
        <span className="text-xs font-bold text-ink/75">{LEVEL_LABELS[level]}</span>
      </div>
    </div>
  );
}

export function RiskReport({ title, result, engine, aiNote }: { title?: string; result: RiskResult; engine?: string; aiNote?: string }) {
  return (
    <div className="space-y-5">
      <section className="panel-solid grid items-center gap-6 p-6 md:grid-cols-[220px_1fr]">
        <RiskGauge score={result.score} level={result.level} />
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {title && <b className="text-sm">{title}</b>}
            <span className={`badge ${engine === "ai+rules" ? "bg-violet-50 text-violet-700" : "bg-stone-100 text-ink/75"}`}>
              {engine === "ai+rules" ? <><Sparkles size={12} />هوش مصنوعی + قواعد</> : "موتور قواعد"}
            </span>
          </div>
          <p className="text-sm leading-8 text-ink/80">{result.summary}</p>
          {aiNote && <p className="mt-2 rounded-xl bg-amber-50 p-2.5 text-xs font-semibold text-amber-800">تحلیل هوش مصنوعی انجام نشد ({aiNote})؛ نتیجه فقط بر پایه‌ی قواعد است.</p>}
          <p className="mt-3 text-xs leading-6 text-ink/72">این گزارش راهنمای اولیه است و جایگزین مشاوره‌ی حقوقی نیست. حدود {fn(result.wordCount)} کلمه بررسی شد.</p>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
        <section className="space-y-3">
          <h2 className="font-bold">یافته‌ها ({fn(result.findings.length)})</h2>
          {result.findings.length === 0 && (
            <p className="flex items-center gap-2 rounded-2xl bg-emerald-50 p-4 text-sm font-bold text-emerald-800"><CheckCircle2 size={18} />مورد ریسکی شناسایی نشد.</p>
          )}
          {result.findings.map((f, i) => (
            <article key={`${f.title}-${i}`} className={`rounded-2xl border p-4 ${SEV_STYLE[f.severity]}`}>
              <header className="mb-1.5 flex flex-wrap items-center gap-2">
                <AlertTriangle size={15} />
                <b className="text-sm">{f.title}</b>
                <span className="badge bg-white/70 text-xs">{SEVERITY_LABELS[f.severity]}</span>
                {f.source === "ai" && <span className="badge bg-white/70 text-xs"><Sparkles size={10} />AI</span>}
              </header>
              {f.detail && <p className="text-[13px] leading-7">{f.detail}</p>}
              {f.quote && <blockquote className="my-2 rounded-lg border-r-4 border-current/30 bg-white/60 p-2.5 text-xs leading-6 opacity-90">«{f.quote}»</blockquote>}
              {f.suggestion && <p className="mt-1 flex items-start gap-1.5 text-[13px] font-semibold leading-7"><Lightbulb size={14} className="mt-1 shrink-0" />{f.suggestion}</p>}
            </article>
          ))}
        </section>

        <aside className="panel-solid h-fit p-5">
          <h3 className="mb-3 text-sm font-bold">پوشش بندهای کلیدی</h3>
          <ul className="space-y-2 text-[13px]">
            {result.present.map((p) => (<li key={p} className="flex items-center gap-2 text-emerald-700"><CheckCircle2 size={14} />{p}</li>))}
            {result.missing.map((p) => (<li key={p} className="flex items-center gap-2 text-red-600"><XCircle size={14} />{p}</li>))}
          </ul>
        </aside>
      </div>
    </div>
  );
}

export default function RiskAnalyzer({ contracts, initialContractId, aiReady, aiLeft }: { contracts: { id: number; number: string; title: string }[]; initialContractId?: number; aiReady: boolean; aiLeft: number }) {
  const [state, action, pending] = useActionState<RiskState, FormData>(analyzeRiskAction, {});
  const [contractId, setContractId] = useState<string>(initialContractId ? String(initialContractId) : "");

  return (
    <div className="space-y-6">
      <form action={action} className="panel-solid space-y-4 p-5">
        <div>
          <label htmlFor="risk-contract" className="label">قرارداد موجود</label>
          <select id="risk-contract" name="contractId" value={contractId} onChange={(e) => setContractId(e.target.value)} className="input">
            <option value="">— متن دلخواه را در کادر زیر بچسبانید —</option>
            {contracts.map((c) => (<option key={c.id} value={c.id}>{c.number} — {c.title}</option>))}
          </select>
        </div>
        {!contractId && (
          <>
            <div>
              <label htmlFor="risk-title" className="label">عنوان (اختیاری)</label>
              <input id="risk-title" name="title" maxLength={200} className="input" placeholder="مثلاً قرارداد همکاری با پیمانکار" />
            </div>
            <div>
              <label htmlFor="risk-text" className="label">متن قرارداد</label>
              <textarea id="risk-text" name="text" rows={10} maxLength={60000} className="input" placeholder="متن کامل قرارداد را اینجا بچسبانید…" />
            </div>
          </>
        )}
        <label className={`flex items-start gap-3 rounded-2xl border p-3 text-[13px] ${aiReady ? "border-violet-200 bg-violet-50/60" : "border-ink/10 bg-stone-50 opacity-70"}`}>
          <input type="checkbox" name="useAi" defaultChecked={aiReady} disabled={!aiReady} className="mt-1 h-4 w-4" />
          <span>
            <b className="flex items-center gap-1.5"><Sparkles size={14} />تحلیل عمیق با هوش مصنوعی</b>
            <span className="mt-0.5 block text-ink/75">
              {aiReady ? `یک درخواست از سهمیه‌ی روزانه کم می‌شود (${fn(aiLeft)} باقی‌مانده).` : "برای فعال‌سازی، کلید هوش مصنوعی را در «تنظیمات» وارد کنید. تحلیل قواعد همیشه رایگان است."}
            </span>
          </span>
        </label>
        {state.error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">{state.error}</p>}
        <button className="btn-primary" disabled={pending}>
          {pending ? <Loader2 size={16} className="animate-spin" /> : <ScanSearch size={16} />}
          {pending ? "در حال تحلیل…" : "تحلیل ریسک"}
        </button>
      </form>
      {state.result && <RiskReport title={state.title} result={state.result} engine={state.engine} aiNote={state.aiNote} />}
    </div>
  );
}
