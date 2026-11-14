"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BookCheck, Briefcase, Car, Check, Eye, FilePlus2, Home, Library, Search, Sparkles, Store, UserRound, Wallet, X } from "lucide-react";
import { addLibraryTemplateAction } from "@/modules/library/actions";

export interface LibItem {
  key: string;
  category: string;
  title: string;
  summary: string;
  tags: string[];
  legalBasis: string;
  roles: [string, string];
  extraSigners: string[];
  articleCount: number;
  wordCount: number;
  /** HTML پیش‌نمایش (جاهای خالی و فیلدهای امضاکننده به‌صورت خوانا) */
  preview: string;
  placeholders: { key: string; label: string }[];
  added: boolean;
}
export interface LibCategory { id: string; label: string; hint: string; icon: string; tone: string }

const ICONS: Record<string, typeof Home> = { home: Home, car: Car, wallet: Wallet, briefcase: Briefcase, store: Store, user: UserRound };
const TONES: Record<string, { chip: string; ring: string; icon: string }> = {
  emerald: { chip: "bg-emerald-50 text-emerald-800 border-emerald-200", ring: "ring-emerald-300", icon: "bg-emerald-100 text-emerald-700" },
  sky: { chip: "bg-sky-50 text-sky-800 border-sky-200", ring: "ring-sky-300", icon: "bg-sky-100 text-sky-700" },
  amber: { chip: "bg-amber-50 text-amber-800 border-amber-200", ring: "ring-amber-300", icon: "bg-amber-100 text-amber-700" },
  violet: { chip: "bg-violet-50 text-violet-800 border-violet-200", ring: "ring-violet-300", icon: "bg-violet-100 text-violet-700" },
  rose: { chip: "bg-rose-50 text-rose-800 border-rose-200", ring: "ring-rose-300", icon: "bg-rose-100 text-rose-700" },
  slate: { chip: "bg-slate-100 text-slate-800 border-slate-200", ring: "ring-slate-300", icon: "bg-slate-200 text-slate-700" },
};

const faNum = (n: number) => n.toLocaleString("fa-IR");
const norm = (s: string) => s.replace(/[يى]/g, "ی").replace(/ك/g, "ک").toLowerCase();

function toBase64Url(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export default function LibraryBrowser({ items, categories, canWrite }: { items: LibItem[]; categories: LibCategory[]; canWrite: boolean }) {
  const router = useRouter();
  const [cat, setCat] = useState<string>("all");
  const [q, setQ] = useState("");
  const [view, setView] = useState<{ mode: "preview" | "fill"; item: LibItem } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  const counts = useMemo(() => Object.fromEntries(categories.map((c) => [c.id, items.filter((i) => i.category === c.id).length])), [items, categories]);
  const list = useMemo(() => {
    const n = norm(q.trim());
    return items.filter((i) => (cat === "all" || i.category === cat) && (!n || norm(`${i.title} ${i.summary} ${i.tags.join(" ")} ${i.legalBasis}`).includes(n)));
  }, [items, cat, q]);

  const open = (mode: "preview" | "fill", item: LibItem) => {
    setValues({});
    setView({ mode, item });
  };
  const start = () => {
    if (!view) return;
    const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
    const qs = Object.keys(filled).length ? `&p=${toBase64Url(filled)}` : "";
    router.push(`/admin/new?lib=${encodeURIComponent(view.item.key)}${qs}`);
  };

  const mine = view?.item.placeholders.filter((p) => p.key.startsWith("p1_")) ?? [];
  const rest = view?.item.placeholders.filter((p) => !p.key.startsWith("p1_")) ?? [];

  return (
    <div>
      <div className="relative mb-6 overflow-hidden rounded-3xl bg-gradient-to-l from-[#102c31] via-[#14424a] to-[#1b5a63] p-6 text-white sm:p-8">
        <div className="absolute -left-10 -top-10 h-44 w-44 rounded-full bg-white/10 blur-2xl" aria-hidden />
        <div className="relative flex flex-wrap items-center justify-between gap-5">
          <div className="max-w-2xl">
            <span className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-bold"><Sparkles size={13} />قالب‌های حقوقی آماده</span>
            <h1 className="text-2xl font-black sm:text-3xl">کتابخانه‌ی قالب‌های قرارداد</h1>
            <p className="mt-2 text-sm leading-7 text-white/85">{faNum(items.length)} قالب فارسی و رسمی با اصطلاحات حقوقی رایج در ایران؛ با پشتیبانی از چک صیادی، سفته، ضامن، بیعانه و وجه التزام. قالب را انتخاب کنید، چند اطلاعات ساده بنویسید و برای امضاکننده (حتی بدون حساب کاربری) بفرستید.</p>
          </div>
          <div className="relative w-full sm:w-80">
            <Search size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink/50" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجو: اجاره، خودرو، ضامن، NDA…" aria-label="جستجوی قالب" className="input !bg-white !pr-9 text-ink" />
          </div>
        </div>
      </div>

      <div className="mb-5 flex flex-wrap gap-2" role="tablist" aria-label="دسته‌بندی قالب‌ها">
        <button role="tab" aria-selected={cat === "all"} onClick={() => setCat("all")} className={`rounded-full border px-4 py-2 text-xs font-bold transition ${cat === "all" ? "border-ink bg-ink text-white" : "border-ink/15 bg-white hover:bg-stone-50"}`}>
          همه <span className="mr-1 opacity-70">{faNum(items.length)}</span>
        </button>
        {categories.map((c) => {
          const Icon = ICONS[c.icon] ?? Library;
          const on = cat === c.id;
          return (
            <button key={c.id} role="tab" aria-selected={on} onClick={() => setCat(c.id)} className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-xs font-bold transition ${on ? "border-ink bg-ink text-white" : "border-ink/15 bg-white hover:bg-stone-50"}`}>
              <Icon size={14} />{c.label}<span className="opacity-70">{faNum(counts[c.id] ?? 0)}</span>
            </button>
          );
        })}
      </div>

      {list.length === 0 && <div className="card py-12 text-center text-sm text-ink/70">قالبی با این عبارت پیدا نشد. عبارت دیگری مثل «اجاره» یا «چک» را امتحان کنید.</div>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((it) => {
          const c = categories.find((x) => x.id === it.category);
          const tone = TONES[c?.tone ?? "slate"];
          const Icon = ICONS[c?.icon ?? ""] ?? Library;
          return (
            <article key={it.key} className="panel-solid flex flex-col gap-3 p-5 transition hover:-translate-y-0.5 hover:shadow-lg">
              <div className="flex items-start gap-3">
                <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${tone.icon}`}><Icon size={20} /></span>
                <div className="min-w-0 flex-1">
                  <span className={`mb-1 inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone.chip}`}>{c?.label}</span>
                  <h2 className="text-sm font-black leading-6">{it.title}</h2>
                </div>
              </div>
              <p className="text-xs leading-6 text-ink/75">{it.summary}</p>
              <div className="flex flex-wrap gap-1.5">
                {it.tags.map((t) => <span key={t} className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold text-ink/75">{t}</span>)}
                {it.extraSigners.length > 0 && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">+ امضای {it.extraSigners.join("، ")}</span>}
              </div>
              <p className="text-[11px] leading-5 text-ink/60">مبنا: {it.legalBasis}</p>
              <div className="mt-auto flex items-center justify-between border-t border-ink/[.07] pt-3 text-[11px] text-ink/65">
                <span>{faNum(it.articleCount)} ماده · {faNum(it.wordCount)} واژه</span>
                {it.added && <span className="inline-flex items-center gap-1 font-bold text-emerald-700"><BookCheck size={13} />در قالب‌های شما</span>}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => open("preview", it)} className="btn-secondary btn-sm flex-1"><Eye size={14} />مشاهده‌ی متن</button>
                {canWrite && <button type="button" onClick={() => open("fill", it)} className="btn-primary btn-sm flex-1"><FilePlus2 size={14} />استفاده در قرارداد</button>}
              </div>
            </article>
          );
        })}
      </div>

      <p className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-7 text-amber-900">
        این قالب‌ها برای تسهیل تنظیم قراردادهای رایج تهیه شده‌اند و جایگزین مشاوره‌ی حقوقی نیستند. برای معاملات پرمبلغ یا شرایط خاص (مثل انتقال رسمی ملک و خودرو که نیازمند سند رسمی است) پیش از امضا با وکیل پایه‌ی یک دادگستری مشورت کنید. متن همه‌ی قالب‌ها پیش از ارسال، در ویرایشگر قابل تغییر است.
      </p>

      {view && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={view.item.title} onClick={(e) => e.target === e.currentTarget && setView(null)}>
          <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl">
            <div className="flex items-center justify-between gap-3 border-b border-ink/10 px-5 py-4">
              <div>
                <h3 className="font-black">{view.item.title}</h3>
                <p className="text-[11px] text-ink/65">{view.mode === "fill" ? "اطلاعات قرارداد را بنویسید (همه اختیاری است و بعداً در ویرایشگر قابل تغییر است)" : `طرفین: ${view.item.roles[0]} و ${view.item.roles[1]}`}</p>
              </div>
              <button type="button" onClick={() => setView(null)} aria-label="بستن" className="btn-secondary btn-sm"><X size={15} /></button>
            </div>

            {view.mode === "preview" ? (
              <>
                <div className="overflow-y-auto px-5 py-4">
                  <article className="contract-paper contract-body" dangerouslySetInnerHTML={{ __html: view.item.preview }} />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink/10 bg-stone-50 px-5 py-3">
                  <span className="text-[11px] text-ink/65">جاهای خالی و موارد زردرنگ هنگام صدور پر می‌شوند.</span>
                  <div className="flex gap-2">
                    {canWrite && (
                      <form action={addLibraryTemplateAction}>
                        <input type="hidden" name="key" value={view.item.key} />
                        <button className="btn-secondary btn-sm">افزودن به قالب‌های من</button>
                      </form>
                    )}
                    {canWrite && <button type="button" onClick={() => setView({ mode: "fill", item: view.item })} className="btn-primary btn-sm"><FilePlus2 size={14} />استفاده در قرارداد</button>}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-5 overflow-y-auto px-5 py-4">
                  {mine.length > 0 && (
                    <section>
                      <h4 className="mb-2 text-sm font-black">مشخصات شما ({view.item.roles[0]})</h4>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {mine.map((p) => (
                          <div key={p.key}>
                            <label className="label" htmlFor={`lib-${p.key}`}>{p.label}</label>
                            <input id={`lib-${p.key}`} className="input" value={values[p.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))} />
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                  {rest.length > 0 && (
                    <section>
                      <h4 className="mb-2 text-sm font-black">جزئیات قرارداد</h4>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {rest.map((p) => (
                          <div key={p.key}>
                            <label className="label" htmlFor={`lib-${p.key}`}>{p.label}</label>
                            <input id={`lib-${p.key}`} className="input" value={values[p.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))} />
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                  <p className="rounded-xl bg-emerald-50 p-3 text-xs leading-6 text-emerald-900">
                    مشخصات طرف مقابل (نام، کد ملی، نشانی{view.item.extraSigners.length ? ` و ${view.item.extraSigners.join("، ")}` : ""}) را خودش هنگام امضا وارد می‌کند؛ لازم نیست حساب کاربری داشته باشد.
                    {view.item.extraSigners.length > 0 && ` در مرحله‌ی بعد برای «${view.item.extraSigners.join("، ")}» فقط نام و موبایل وارد کنید.`}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-ink/10 bg-stone-50 px-5 py-3">
                  <button type="button" onClick={() => setView({ mode: "preview", item: view.item })} className="btn-secondary btn-sm"><Eye size={14} />مشاهده‌ی متن</button>
                  <button type="button" onClick={start} className="btn-primary"><Check size={16} />ادامه و صدور قرارداد</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
