"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BookMarked, Brain, CheckCircle2, Eye, FileUp, FileText, LoaderCircle, ScrollText, ShieldCheck, Sparkles, Trash2, Wand2 } from "lucide-react";
import {
  addPasteAction,
  clearProfileAction,
  deleteDocAction,
  importAction,
  learnProfileAction,
  previewDocAction,
  saveSettingsAction,
  setKindAction,
  toggleDocAction,
  type KState,
} from "@/modules/ai/knowledge/actions";
import { KINDS, KIND_HINTS, KIND_LABELS, type KnowledgeKind } from "@/modules/ai/knowledge/constants";
import type { StyleFingerprint } from "@/modules/ai/knowledge/text";

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
const SOURCE_LABEL: Record<string, string> = { upload: "فایل", paste: "متن", contract: "قرارداد سامانه", template: "قالب سامانه" };

export type KDoc = { id: number; title: string; kind: string; source: string; fileName: string; charCount: number; redactions: number; enabled: boolean; createdAt: string };
export type SysItem = { id: number; title: string; sub: string };

type Props = {
  canWrite: boolean;
  aiReady: boolean;
  aiLeft: number;
  docs: KDoc[];
  enabled: boolean;
  instructions: string;
  styleProfile: string;
  profileUpdatedAt: string | null;
  profileStale: boolean;
  fingerprint: StyleFingerprint | null;
  contracts: SysItem[];
  templates: SysItem[];
  maxDocs: number;
};

function Msg({ s }: { s: KState }) {
  if (s.error) return <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{s.error}</p>;
  if (s.ok && s.message) return <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">{s.message}</p>;
  return null;
}

export default function KnowledgePanel(p: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<"upload" | "paste" | "system">("upload");
  const [pending, start] = useTransition();
  const [note, setNote] = useState<KState>({});
  const [preview, setPreview] = useState<{ id: number; title: string; text: string; total: number } | null>(null);

  const [pasteState, pasteAction, pasting] = useActionState<KState, FormData>(addPasteAction, {});
  const [setState, setAction, saving] = useActionState<KState, FormData>(saveSettingsAction, {});
  const [impState, impAction, importing] = useActionState<KState, FormData>(importAction, {});
  const [sysType, setSysType] = useState<"contract" | "template">("contract");

  // آپلود فایل
  const fileRef = useRef<HTMLInputElement>(null);
  const [upKind, setUpKind] = useState<KnowledgeKind>("sample");
  const [redact, setRedact] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [upResults, setUpResults] = useState<{ name: string; ok: boolean; error?: string; redactions?: number; truncated?: boolean }[]>([]);
  const [upError, setUpError] = useState("");
  const [drag, setDrag] = useState(false);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    setUpError("");
    setUpResults([]);
    const fd = new FormData();
    list.slice(0, 5).forEach((f) => fd.append("files", f));
    fd.set("kind", upKind);
    if (!redact) fd.set("redact", "off");
    try {
      const res = await fetch("/api/ai/knowledge", { method: "POST", body: fd });
      const j = await res.json().catch(() => null);
      if (!j) setUpError("پاسخ نامعتبر از سرور");
      else if (j.error) setUpError(j.error);
      setUpResults(j?.results ?? []);
      router.refresh();
    } catch {
      setUpError("ارتباط با سرور برقرار نشد");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const run = (fnc: () => Promise<KState>) =>
    start(async () => {
      setNote(await fnc());
      router.refresh();
    });

  async function openPreview(id: number) {
    const r = await previewDocAction(id);
    if (r.error || !r.text) setNote({ error: r.error || "خطا" });
    else setPreview({ id, title: r.title || "", text: r.text, total: r.total || 0 });
  }

  const active = p.docs.filter((d) => d.enabled).length;
  const policies = p.docs.filter((d) => d.enabled && d.kind === "policy").length;
  const fp = p.fingerprint;
  const ro = !p.canWrite;

  return (
    <div className="space-y-6">
      {/* وضعیت و لایه‌ها */}
      <section className="panel-solid p-5 md:p-6" aria-labelledby="kb-status">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 id="kb-status" className="flex items-center gap-2 text-lg font-black"><Brain size={19} />هوش مصنوعی شخصی‌شده‌ی شما</h2>
            <p className="mt-1 max-w-2xl text-xs leading-7 text-ink/72">
              اسناد و قوانین خودتان را اینجا بگذارید؛ «نوشتن با هوش مصنوعی» در ویرایشگر قالب‌ها و صدور قرارداد از آن‌ها لحن، ساختار، بندهای تأییدشده و خط‌قرمزهای شما را یاد می‌گیرد.
            </p>
          </div>
          <form action={setAction} className="flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-bold">
              <input type="checkbox" name="enabled" defaultChecked={p.enabled} disabled={ro} className="h-5 w-5 accent-[var(--ink)]" data-testid="kb-enabled" />
              شخصی‌سازی فعال باشد
            </label>
            <input type="hidden" name="instructions" value={p.instructions} />
            {!ro && <button className="btn-secondary btn-sm" disabled={saving}>{saving ? "…" : "ذخیره"}</button>}
          </form>
        </div>
        <Msg s={setState} />
        <dl className="mt-5 grid gap-3 text-xs sm:grid-cols-4">
          {[
            ["سند فعال", `${fn(active)} از ${fn(p.docs.length)}`],
            ["قانون الزامی", fn(policies)],
            ["شناسنامه‌ی نگارش", p.styleProfile ? (p.profileStale ? "کهنه شده" : "آماده") : "ساخته نشده"],
            ["وضعیت", p.enabled && (active > 0 || p.instructions || p.styleProfile) ? "در حال اثرگذاری" : "بدون اثر"],
          ].map(([k, v]) => (
            <div key={k} className="rounded-2xl bg-stone-50 p-3"><dt className="text-ink/72">{k}</dt><dd className="mt-1 text-base font-black" data-testid={`kb-stat-${k}`}>{v}</dd></div>
          ))}
        </dl>
        <ul className="mt-4 grid gap-2 text-xs leading-6 text-ink/80 md:grid-cols-3">
          <li className="rounded-xl border border-ink/10 p-3"><b className="mb-1 flex items-center gap-1"><Sparkles size={13} />۱. سبک شما</b>لحن، نام طرفین و قالب مواد به‌صورت رایگان از اسنادتان محاسبه می‌شود.</li>
          <li className="rounded-xl border border-ink/10 p-3"><b className="mb-1 flex items-center gap-1"><ScrollText size={13} />۲. قوانین شما</b>اسناد نوع «قوانین» همیشه و بدون استثنا به هوش مصنوعی داده می‌شوند.</li>
          <li className="rounded-xl border border-ink/10 p-3"><b className="mb-1 flex items-center gap-1"><BookMarked size={13} />۳. بندهای مرتبط</b>برای هر درخواست فقط مرتبط‌ترین بندهای اسناد شما انتخاب می‌شود.</li>
        </ul>
      </section>

      {/* افزودن */}
      {p.canWrite && (
        <section className="panel-solid p-5 md:p-6" aria-labelledby="kb-add">
          <h2 id="kb-add" className="mb-3 font-bold">افزودن به حافظه</h2>
          <div role="tablist" className="mb-4 inline-flex rounded-xl bg-stone-100 p-1 text-xs font-bold">
            {([["upload", "آپلود فایل"], ["paste", "چسباندن متن"], ["system", "از قراردادهای من"]] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)} className={`rounded-lg px-3 py-1.5 transition ${tab === k ? "bg-white shadow" : "text-ink/75"}`}>{l}</button>
            ))}
          </div>

          {tab === "upload" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-xs font-bold" htmlFor="up-kind">نوع سند:</label>
                <select id="up-kind" className="input !h-10 !w-auto" value={upKind} onChange={(e) => setUpKind(e.target.value as KnowledgeKind)}>
                  {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                </select>
                <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={redact} onChange={(e) => setRedact(e.target.checked)} className="accent-[var(--ink)]" />حذف خودکار کد ملی، موبایل، ایمیل، کارت و شبا</label>
              </div>
              <p className="text-xs text-ink/72">{KIND_HINTS[upKind]}</p>
              <div
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files); }}
                className={`grid place-items-center rounded-2xl border-2 border-dashed p-8 text-center transition ${drag ? "border-ink bg-mint/10" : "border-ink/15 bg-stone-50"}`}
              >
                {uploading ? (
                  <span className="flex items-center gap-2 text-sm"><LoaderCircle className="animate-spin" size={18} />در حال خواندن فایل‌ها…</span>
                ) : (
                  <>
                    <FileUp size={26} className="mb-2 text-ink/60" />
                    <p className="text-sm font-bold">فایل‌ها را اینجا رها کنید یا انتخاب کنید</p>
                    <p className="mt-1 text-xs text-ink/72">TXT، MD، HTML، DOCX — تا ۵ فایل، هرکدام حداکثر ۳ مگابایت</p>
                    <label className="btn-primary btn-sm mt-4 cursor-pointer">
                      انتخاب فایل
                      <input ref={fileRef} data-testid="kb-file" type="file" multiple accept=".txt,.md,.markdown,.html,.htm,.docx,text/plain,text/markdown,text/html" className="sr-only" onChange={(e) => e.target.files && void upload(e.target.files)} />
                    </label>
                  </>
                )}
              </div>
              {upError && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{upError}</p>}
              {upResults.length > 0 && (
                <ul className="space-y-1 text-xs" data-testid="kb-upload-results">
                  {upResults.map((r, i) => (
                    <li key={i} className={r.ok ? "text-emerald-700" : "text-rose-700"}>
                      {r.ok ? "✓" : "✗"} {r.name} — {r.ok ? `افزوده شد${r.redactions ? ` (${fn(r.redactions)} اطلاعات حساس حذف شد)` : ""}${r.truncated ? " (متن طولانی کوتاه شد)" : ""}` : r.error}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-ink/72">PDF پشتیبانی نمی‌شود؛ آن را به DOCX تبدیل کنید یا متنش را در «چسباندن متن» بگذارید.</p>
            </div>
          )}

          {tab === "paste" && (
            <form action={pasteAction} className="space-y-3">
              <div className="grid gap-3 md:grid-cols-[1fr_220px]">
                <div><label className="label" htmlFor="p-title">عنوان</label><input id="p-title" name="title" className="input" maxLength={120} placeholder="مثلاً: قرارداد استاندارد طراحی سایت ۱۴۰۴" /></div>
                <div><label className="label" htmlFor="p-kind">نوع سند</label><select id="p-kind" name="kind" className="input">{KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select></div>
              </div>
              <div><label className="label" htmlFor="p-text">متن</label><textarea id="p-text" name="text" rows={8} required minLength={80} className="input !h-auto" placeholder="متن قرارداد، قوانین شرکت یا بندهای آماده را اینجا بچسبانید (حداقل ۸۰ نویسه)" /></div>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="redact" defaultChecked className="accent-[var(--ink)]" />حذف خودکار اطلاعات حساس (کد ملی، موبایل، ایمیل، کارت، شبا)</label>
              <Msg s={pasteState} />
              <button className="btn-primary btn-sm" disabled={pasting}>{pasting ? "…" : "افزودن به حافظه"}</button>
            </form>
          )}

          {tab === "system" && (
            <form action={impAction} className="space-y-3">
              <input type="hidden" name="type" value={sysType} />
              <div className="inline-flex rounded-xl bg-stone-100 p-1 text-xs font-bold">
                {([["contract", "قراردادهای صادرشده"], ["template", "قالب‌ها"]] as const).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setSysType(k)} className={`rounded-lg px-3 py-1.5 ${sysType === k ? "bg-white shadow" : "text-ink/75"}`}>{l}</button>
                ))}
              </div>
              <ul className="thin-scroll max-h-64 space-y-1 overflow-y-auto rounded-2xl border border-ink/10 p-2" key={sysType}>
                {(sysType === "contract" ? p.contracts : p.templates).length === 0 && <li className="p-3 text-xs text-ink/72">موردی وجود ندارد.</li>}
                {(sysType === "contract" ? p.contracts : p.templates).map((c) => (
                  <li key={c.id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-xl p-2 text-sm hover:bg-stone-50">
                      <input type="checkbox" name="ids" value={c.id} className="accent-[var(--ink)]" />
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                      <span className="text-xs text-ink/72">{c.sub}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="text-xs leading-6 text-amber-800">توجه: کد ملی/موبایل/ایمیل خودکار حذف می‌شود اما نام اشخاص حذف نمی‌شود؛ هوش مصنوعی هم دستور دارد نام‌ها را کپی نکند. قالب‌ها بهترین نمونه‌اند، چون اطلاعات شخصی ندارند.</p>
              <Msg s={impState} />
              <button className="btn-primary btn-sm" disabled={importing}>{importing ? "…" : "افزودن موارد انتخاب‌شده"}</button>
            </form>
          )}
        </section>
      )}

      {/* فهرست اسناد */}
      <section className="panel-solid p-5 md:p-6" aria-labelledby="kb-list">
        <h2 id="kb-list" className="mb-3 flex items-center gap-2 font-bold"><FileText size={17} />اسناد حافظه <span className="text-xs font-normal text-ink/72">({fn(p.docs.length)} از {fn(p.maxDocs)})</span></h2>
        {note.error && <p role="alert" className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{note.error}</p>}
        {note.ok && note.message && <p role="status" className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">{note.message}</p>}
        {p.docs.length === 0 ? (
          <p className="rounded-2xl bg-stone-50 p-6 text-center text-sm text-ink/72" data-testid="kb-empty">هنوز سندی اضافه نکرده‌اید. اولین قرارداد یا مجموعه قوانین شرکتتان را اضافه کنید.</p>
        ) : (
          <ul className="divide-y divide-ink/[.07]" data-testid="kb-docs">
            {p.docs.map((d) => (
              <li key={d.id} className={`flex flex-wrap items-center gap-3 py-3 ${d.enabled ? "" : "opacity-55"}`} data-testid="kb-doc">
                <div className="min-w-0 flex-1">
                  <b className="block truncate text-sm">{d.title}</b>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-ink/75">
                    <span className="badge bg-stone-100">{SOURCE_LABEL[d.source] ?? d.source}</span>
                    <span className="badge bg-stone-100">{fn(d.charCount)} نویسه</span>
                    {d.redactions > 0 && <span className="badge bg-amber-50 text-amber-800"><ShieldCheck size={11} />{fn(d.redactions)} اطلاعات حساس حذف شد</span>}
                  </div>
                </div>
                <select aria-label={`نوع سند ${d.title}`} disabled={ro || pending} value={d.kind} className="input !h-9 !w-auto !py-0 text-xs" onChange={(e) => run(() => setKindAction(d.id, e.target.value))}>
                  {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                </select>
                <button type="button" className="btn-ghost btn-sm" onClick={() => openPreview(d.id)} aria-label={`مشاهده ${d.title}`}><Eye size={14} /></button>
                {p.canWrite && (
                  <>
                    <button type="button" role="switch" aria-checked={d.enabled} disabled={pending} onClick={() => run(() => toggleDocAction(d.id, !d.enabled))} className={`btn-secondary btn-sm ${d.enabled ? "!border-emerald-300 !bg-emerald-50" : ""}`}>{d.enabled ? "فعال" : "غیرفعال"}</button>
                    <button type="button" className="btn-danger btn-sm" disabled={pending} aria-label={`حذف ${d.title}`} onClick={() => { if (window.confirm(`«${d.title}» از حافظه حذف شود؟`)) run(() => deleteDocAction(d.id)); }}><Trash2 size={14} /></button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {preview && (
          <div className="mt-4 rounded-2xl border border-ink/10 bg-stone-50 p-4" data-testid="kb-preview">
            <div className="mb-2 flex items-center justify-between"><b className="text-sm">{preview.title}</b><button type="button" className="btn-ghost btn-sm" onClick={() => setPreview(null)}>بستن</button></div>
            <pre className="thin-scroll max-h-72 overflow-auto whitespace-pre-wrap break-words font-[inherit] text-xs leading-7">{preview.text}</pre>
            {preview.total > preview.text.length && <p className="mt-2 text-xs text-ink/72">… (فقط ۴٬۰۰۰ نویسه‌ی اول نمایش داده شد)</p>}
          </div>
        )}
      </section>

      {/* دستورالعمل و شناسنامه */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="panel-solid p-5 md:p-6" aria-labelledby="kb-ins">
          <h2 id="kb-ins" className="mb-1 font-bold">دستورالعمل دائمی</h2>
          <p className="mb-3 text-xs leading-6 text-ink/72">جمله‌هایی که در همه‌ی قراردادها باید رعایت شوند.</p>
          <form action={setAction} className="space-y-3">
            <input type="hidden" name="enabled" value={p.enabled ? "on" : ""} />
            <label className="sr-only" htmlFor="kb-instr">دستورالعمل دائمی</label>
            <textarea id="kb-instr" name="instructions" rows={6} maxLength={2000} defaultValue={p.instructions} disabled={ro} className="input !h-auto" placeholder={"مثلاً:\nطرف اول را همیشه «کارفرما» و طرف دوم را «مجری» بنامید.\nلحن کاملاً رسمی؛ ارقام فارسی.\nسقف جریمه‌ی تأخیر ۱۰٪ مبلغ قرارداد."} />
            {p.canWrite && <button className="btn-primary btn-sm" disabled={saving}>{saving ? "…" : "ذخیره‌ی دستورالعمل"}</button>}
          </form>
        </section>

        <section className="panel-solid p-5 md:p-6" aria-labelledby="kb-prof">
          <h2 id="kb-prof" className="mb-1 flex items-center gap-2 font-bold"><Wand2 size={16} />شناسنامه‌ی نگارش (یادگیری با AI)</h2>
          <p className="mb-3 text-xs leading-6 text-ink/72">یک تماس هوش مصنوعی، سبک و قواعد همه‌ی اسناد فعال را در یک خلاصه‌ی فشرده می‌ریزد تا در هر تولید استفاده شود (۱ واحد از سهمیه).</p>
          {p.styleProfile ? (
            <>
              {p.profileStale && <p className="mb-2 rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">اسناد از آخرین یادگیری تغییر کرده‌اند؛ دوباره یاد بگیرید.</p>}
              <pre className="thin-scroll mb-3 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-stone-50 p-3 font-[inherit] text-xs leading-7" data-testid="kb-profile">{p.styleProfile}</pre>
            </>
          ) : (
            <p className="mb-3 rounded-2xl bg-stone-50 p-4 text-xs text-ink/72">هنوز ساخته نشده است. حتی بدون آن، سبک شما به‌طور رایگان از اسناد محاسبه می‌شود.</p>
          )}
          {!p.aiReady && <p className="mb-2 text-xs text-amber-800">برای این قابلیت ابتدا کلید API را در <a className="font-bold underline" href="/admin/settings#ai">تنظیمات ← هوش مصنوعی</a> وارد کنید.</p>}
          {p.canWrite && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary btn-sm" disabled={pending || !p.aiReady || active === 0} onClick={() => run(learnProfileAction)} data-testid="kb-learn">
                {pending ? <LoaderCircle size={14} className="animate-spin" /> : <Brain size={14} />}{p.styleProfile ? "یادگیری دوباره" : "یادگیری سبک"}
              </button>
              {p.styleProfile && <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => run(clearProfileAction)}>پاک کردن</button>}
              <span className="self-center text-xs text-ink/72">سهمیه‌ی باقی‌مانده: {fn(p.aiLeft)}</span>
            </div>
          )}
          {p.profileUpdatedAt && <p className="mt-2 text-xs text-ink/72">آخرین یادگیری: {p.profileUpdatedAt}</p>}
        </section>
      </div>

      {/* اثر انگشت */}
      {fp && (
        <section className="panel-solid p-5 md:p-6" aria-labelledby="kb-fp" data-testid="kb-fingerprint">
          <h2 id="kb-fp" className="mb-1 flex items-center gap-2 font-bold"><CheckCircle2 size={16} />اثر انگشت سبک شما <span className="badge bg-emerald-50 text-emerald-700">رایگان</span></h2>
          <p className="mb-4 text-xs text-ink/72">آنچه سامانه بدون هوش مصنوعی از {fn(fp.docs)} سند شما فهمیده و به‌صورت خودکار به هر تولید می‌دهد.</p>
          <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl bg-stone-50 p-3"><dt className="text-ink/72">لحن</dt><dd className="mt-1 text-base font-black">{fp.formality}</dd></div>
            <div className="rounded-2xl bg-stone-50 p-3"><dt className="text-ink/72">نام‌گذاری طرفین</dt><dd className="mt-1 font-bold">{fp.parties.length ? fp.parties.join("، ") : "—"}</dd></div>
            <div className="rounded-2xl bg-stone-50 p-3"><dt className="text-ink/72">قالب مواد</dt><dd className="mt-1 font-bold">{fp.articleStyle ?? "—"}</dd></div>
            <div className="rounded-2xl bg-stone-50 p-3"><dt className="text-ink/72">ارقام / طول جمله</dt><dd className="mt-1 font-bold">{fp.usesPersianDigits ? "فارسی" : "لاتین"} · ≈{fn(fp.avgSentenceWords)} کلمه</dd></div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            {fp.clauses.map((c) => <span key={c.key} className={`badge ${c.present ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-ink/60 line-through"}`}>{c.label}</span>)}
          </div>
          {fp.phrases.length > 0 && <p className="mt-3 text-xs text-ink/75">عبارت‌های امضای نگارشی: {fp.phrases.map((x) => `«${x}»`).join("، ")}</p>}
        </section>
      )}
    </div>
  );
}
