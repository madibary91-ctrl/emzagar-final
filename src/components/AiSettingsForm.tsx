"use client";

import { useActionState, useState } from "react";
import { Bot, CheckCircle2, ExternalLink, Eye, EyeOff, LoaderCircle, PlugZap, ShieldCheck } from "lucide-react";
import { saveAiSettingsAction, type AiSettingsState } from "@/modules/settings/ai-actions";
import { PROVIDER_LIST, PROVIDERS, type AiProviderId } from "@/modules/ai/providers";

type Props = {
  hasKey: boolean;
  masked: string;
  source: "workspace" | "platform" | "none";
  provider: AiProviderId;
  model: string;
  baseUrl: string;
  used: number;
  limit: number;
};

/** تنظیمات دستیار هوش مصنوعی: انتخاب سرویس (OpenAI، Gemini، Claude، …)، کلید ماسک‌شده، مدل، تست اتصال و سهمیه */
export default function AiSettingsForm(p: Props) {
  const [state, action, pending] = useActionState<AiSettingsState, FormData>(saveAiSettingsAction, {});
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [provider, setProvider] = useState<AiProviderId>(p.provider);
  const [model, setModel] = useState(p.model);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  const [clear, setClear] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const info = PROVIDERS[provider];
  const changedProvider = provider !== p.provider && p.source === "workspace";
  const pct = Math.min(100, Math.round((p.used / Math.max(1, p.limit)) * 100));

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const res = await fetch("/api/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: clear ? "" : key, baseUrl, model, provider }),
      });
      const j = await res.json().catch(() => null);
      if (j?.ok) {
        setModels(j.models || []);
        setTest({ ok: true, text: j.models?.length ? `اتصال موفق بود · ${j.models.length} مدل در دسترس است` : "اتصال موفق بود" });
      } else setTest({ ok: false, text: j?.error || "اتصال ناموفق بود" });
    } catch {
      setTest({ ok: false, text: "ارتباط با سرور برقرار نشد" });
    } finally {
      setTesting(false);
    }
  }

  function pickProvider(id: AiProviderId) {
    setProvider(id);
    setModel("");
    setBaseUrl("");
    setModels([]);
    setTest(null);
  }

  const options = [...new Set([...(models.length ? models : []), ...info.models])];

  return (
    <form id="ai" action={action} className="card space-y-5 scroll-mt-24">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-ink text-mint"><Bot size={20} /></span>
          <div>
            <h2 className="font-bold">دستیار هوش مصنوعی</h2>
            <p className="mt-0.5 text-xs text-stone-600">کلید خودتان را اینجا وارد کنید؛ دیگر نیازی به ویرایش فایل .env نیست.</p>
          </div>
        </div>
        <span className={`badge ${p.hasKey ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
          {p.source === "workspace" ? "کلید اختصاصی فعال" : p.source === "platform" ? "کلید پیش‌فرض پلتفرم" : "غیرفعال"}
        </span>
      </div>

      <div>
        <label htmlFor="ai_provider" className="label">سرویس هوش مصنوعی</label>
        <select id="ai_provider" name="ai_provider" value={provider} onChange={(e) => pickProvider(e.target.value as AiProviderId)} className="input">
          {PROVIDER_LIST.map((x) => (
            <option key={x.id} value={x.id}>{x.label}</option>
          ))}
        </select>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-stone-600">
          <span>{info.description}</span>
          {info.docsUrl && (
            <a href={info.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-bold text-ink underline">
              دریافت کلید <ExternalLink size={11} aria-hidden="true" />
            </a>
          )}
        </p>
        {changedProvider && <p role="status" className="mt-2 rounded-xl bg-amber-50 p-2.5 text-xs text-amber-800">با تغییر سرویس، باید کلید API همان سرویس را وارد کنید؛ کلید قبلی برای سرویس دیگری ارسال نمی‌شود.</p>}
      </div>

      <div>
        <label htmlFor="ai_api_key" className="label">کلید API</label>
        <div className="relative">
          <input
            id="ai_api_key"
            name="ai_api_key"
            type={show ? "text" : "password"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            disabled={clear}
            placeholder={p.source === "workspace" && !changedProvider ? `${p.masked}  (برای حفظ، خالی بگذارید)` : info.keyHint}
            className="input pl-12"
          />
          <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "پنهان کردن کلید" : "نمایش کلید"} className="absolute left-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-xl text-ink/75 hover:bg-ink/5">
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-stone-600">
          <ShieldCheck size={13} className="text-emerald-700" /> کلید به‌صورت رمزنگاری‌شده (AES-256) در دیتابیس ذخیره می‌شود و هرگز دوباره به مرورگر ارسال نمی‌شود.
        </p>
        {p.source === "workspace" && (
          <label className="mt-2 flex items-center gap-2 text-xs text-rose-700">
            <input type="checkbox" name="clear_key" value="1" checked={clear} onChange={(e) => setClear(e.target.checked)} />
            حذف کلید ذخیره‌شده
          </label>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="ai_model" className="label">مدل</label>
          <input id="ai_model" name="ai_model" list="ai-models" value={model} onChange={(e) => setModel(e.target.value)} dir="ltr" placeholder={info.defaultModel || "نام مدل"} className="input" autoComplete="off" />
          <datalist id="ai-models">{options.map((m) => <option key={m} value={m} />)}</datalist>
          <p className="mt-1.5 text-xs text-stone-600">از فهرست انتخاب کنید یا نام دقیق مدل را بنویسید. با «تست اتصال» فهرست زنده‌ی سرویس را بگیرید.</p>
        </div>
        <div>
          <label className="label">سهمیه‌ی ۲۴ ساعت گذشته</label>
          <div className="rounded-2xl border border-ink/10 bg-white p-3">
            <div className="mb-2 flex justify-between text-xs"><b>{p.used.toLocaleString("fa-IR")} از {p.limit.toLocaleString("fa-IR")}</b><span className="text-stone-600">{pct.toLocaleString("fa-IR")}٪</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-stone-100"><div className="h-full rounded-full bg-mint" style={{ width: `${pct}%` }} /></div>
          </div>
        </div>
      </div>

      <details className="rounded-2xl border border-ink/10 bg-white/60 p-4" open={!!info.requiresBaseUrl}>
        <summary className="cursor-pointer text-xs font-bold">تنظیمات پیشرفته</summary>
        <div className="mt-3">
          <label htmlFor="ai_base_url" className="label">{info.requiresBaseUrl ? "آدرس سرویس (الزامی)" : "آدرس سرویس (اختیاری)"}</label>
          <input id="ai_base_url" name="ai_base_url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} dir="ltr" placeholder={info.baseUrl || "https://api.example.com/v1"} className="input" autoComplete="off" />
          <p className="mt-1.5 text-xs text-stone-600">{info.requiresBaseUrl ? "آدرس پایه‌ی رابط سازگار با OpenAI." : "خالی = آدرس رسمی سرویس انتخاب‌شده."} فقط آدرس HTTPS عمومی پذیرفته می‌شود.</p>
        </div>
      </details>

      {test && (
        <p role="status" className={`flex items-center gap-2 rounded-xl p-3 text-xs ${test.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>
          {test.ok && <CheckCircle2 size={15} />} {test.text}
        </p>
      )}
      {state.error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-xs text-rose-700">{state.error}</p>}
      {state.saved && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-800">تنظیمات هوش مصنوعی ذخیره شد.</p>}

      <div className="flex flex-wrap gap-2">
        <button disabled={pending} className="btn-primary">{pending ? "در حال ذخیره…" : "ذخیره‌ی تنظیمات هوش مصنوعی"}</button>
        <button type="button" onClick={runTest} disabled={testing || (!key && !p.hasKey)} className="btn-secondary">
          {testing ? <LoaderCircle size={15} className="animate-spin" /> : <PlugZap size={15} />}
          تست اتصال
        </button>
      </div>
    </form>
  );
}
