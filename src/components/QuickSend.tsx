"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, FileText, FlaskConical, LoaderCircle, PenLine, Send, Smartphone, Upload, Zap } from "lucide-react";
import { SignatureCapture, type SignatureMethod } from "@/components/SignatureCapture";
import DocUploader, { DocWarnings, type UploadedDoc } from "@/components/DocUploader";
import { DocPlacer } from "@/components/DocViews";
import { QUICK_TEMPLATES } from "@/modules/quick/templates";
import { FIELD_KINDS, type Placement } from "@/modules/docs/placement";
import { quickCreateAction, quickSendCodeAction, quickVerifyCodeAction } from "@/modules/quick/actions";

const FA = "۰۱۲۳۴۵۶۷۸۹";
const fd = (n: number | string) => String(n).replace(/\d/g, (d) => FA[Number(d)]);
const todayFa = () => new Date().toLocaleDateString("fa-IR-u-ca-persian", { year: "numeric", month: "long", day: "numeric" });

type Mode = "text" | "file";
const STEPS_TEXT = ["سند", "طرفین", "تأیید و امضا"];
const STEPS_FILE = ["فایل", "جای امضا", "طرفین", "تأیید و امضا"];

export default function QuickSend() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [step, setStep] = useState(0);
  // محتوا
  const [tplId, setTplId] = useState(QUICK_TEMPLATES[0].id);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [askNid, setAskNid] = useState(false);
  const [doc, setDoc] = useState<UploadedDoc | null>(null);
  const [placements, setPlacements] = useState<Placement[]>([]);
  // طرفین
  const [title, setTitle] = useState("");
  const [sName, setSName] = useState("");
  const [sMobile, setSMobile] = useState("");
  const [rName, setRName] = useState("");
  const [rMobile, setRMobile] = useState("");
  // تأیید
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [devCode, setDevCode] = useState<string | undefined>();
  const [proof, setProof] = useState("");
  const [verifiedFor, setVerifiedFor] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [method, setMethod] = useState<SignatureMethod>("draw");
  const [agree, setAgree] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"send" | "verify" | "create" | null>(null);
  const [error, setError] = useState("");

  const steps = mode === "file" ? STEPS_FILE : STEPS_TEXT;
  const tpl = useMemo(() => QUICK_TEMPLATES.find((t) => t.id === tplId) ?? QUICK_TEMPLATES[0], [tplId]);
  const kindStep = mode === "file" ? ["upload", "place", "parties", "sign"][step] : ["text", "parties", "sign"][step];

  useEffect(() => {
    if (seconds <= 0) return;
    const t = setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [seconds]);

  const senderFields = placements.filter((p) => p.signerPosition === 1 && ["text", "checkbox"].includes(p.kind));
  const fieldKeyFor = (p: Placement) => `q${placements.indexOf(p)}`;

  const buildBody = () => {
    let html = tpl.build(vals, { sender: sName.trim(), recipient: rName.trim(), today: todayFa() });
    if (askNid) html += `<p>کد ملی ${rName.trim() ? "طرف دوم" : ""}: {{field:national_id|کد ملی طرف دوم|nid|req|2}}</p><p>نشانی: {{field:address|نشانی طرف دوم|address|req|2}}</p>`;
    return html;
  };

  const next = () => {
    setError("");
    if (kindStep === "text") {
      const missing = tpl.fields.some((f) => f.key !== "text" && !(vals[f.key] ?? "").trim());
      if (missing) return setError("همه‌ی جای‌خالی‌ها را پر کنید (یا «متن دلخواه» را انتخاب کنید)");
      if (tpl.id === "free" && (vals.text ?? "").trim().length < 10) return setError("متن سند را بنویسید");
      if (!title) setTitle(tpl.title);
    }
    if (kindStep === "place") {
      for (const pos of [1, 2]) if (!placements.some((p) => p.signerPosition === pos && p.kind === "signature")) return setError(pos === 1 ? "برای خودتان حداقل یک «جای امضا» روی فایل بگذارید" : "برای طرف مقابل حداقل یک «جای امضا» روی فایل بگذارید");
    }
    if (kindStep === "parties") {
      if (title.trim().length < 3) return setError("عنوان سند را وارد کنید");
      if (sName.trim().length < 3 || rName.trim().length < 3) return setError("نام و نام خانوادگی هر دو طرف را کامل وارد کنید");
      if (!/^(\+98|0098|98|0)?9\d{9}$/.test(sMobile.replace(/[\s-]/g, "").replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)))) || !/^(\+98|0098|98|0)?9\d{9}$/.test(rMobile.replace(/[\s-]/g, "").replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))))) return setError("شماره‌ی موبایل هر دو طرف را درست وارد کنید (مثل 09123456789)");
    }
    setStep((s) => s + 1);
  };

  const sendCode = async () => {
    setError("");
    setBusy("send");
    const r = await quickSendCodeAction(sMobile);
    setBusy(null);
    if (r.seconds) setSeconds(r.seconds);
    if (!r.ok) return setError(r.error || "ارسال کد ناموفق بود");
    setSent(true);
    setDevCode(r.devCode);
    setCode("");
  };
  const verify = async () => {
    setError("");
    if (!/^\d{5,8}$/.test(code.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))))) return setError("کد تأیید را وارد کنید");
    setBusy("verify");
    const r = await quickVerifyCodeAction(sMobile, code);
    setBusy(null);
    if (!r.ok || !r.proof) return setError(r.error || "کد نادرست است");
    setProof(r.proof);
    setVerifiedFor(sMobile);
  };
  const verified = !!proof && verifiedFor === sMobile;

  const submit = async () => {
    setError("");
    if (!verified) return setError("ابتدا شماره‌ی موبایل خود را تأیید کنید");
    if (!signature) return setError("امضای خود را ثبت کنید");
    if (!agree) return setError("تأیید مطالعه‌ی سند الزامی است");
    const fv: Record<string, string> = {};
    senderFields.forEach((p) => {
      fv[`df_${placements.indexOf(p) + 1}`] = fields[fieldKeyFor(p)] ?? "";
    });
    setBusy("create");
    const r = await quickCreateAction({
      title,
      bodyHtml: mode === "text" ? buildBody() : undefined,
      draftCode: mode === "file" ? doc?.code : undefined,
      placements: mode === "file" ? placements : undefined,
      sender: { name: sName, mobile: sMobile },
      recipient: { name: rName, mobile: rMobile },
      proof,
      signature,
      method,
      agree,
      fields: mode === "file" ? fv : undefined,
    });
    setBusy(null);
    if (!r.ok || !r.manageToken) {
      if (r.error?.includes("تأیید شماره")) setProof("");
      return setError(r.error || "ارسال انجام نشد");
    }
    router.push(`/q/${r.manageToken}?new=1`);
  };

  /* ───────── انتخاب نوع ───────── */
  if (!mode) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <button type="button" onClick={() => { setMode("text"); setStep(0); }} className="card group text-right transition hover:-translate-y-0.5 hover:shadow-lg">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-ink text-mint"><FileText size={22} /></span>
          <h2 className="mt-4 text-lg font-black">قرارداد آماده می‌خواهم</h2>
          <p className="mt-1 text-xs leading-7 text-ink/70">رسید، قرض، اجاره، NDA، قرارداد کار… یک قالب انتخاب کنید و فقط جای‌خالی‌ها را پر کنید.</p>
        </button>
        <button type="button" onClick={() => { setMode("file"); setStep(0); }} className="card group text-right transition hover:-translate-y-0.5 hover:shadow-lg">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-mint text-ink"><Upload size={22} /></span>
          <h2 className="mt-4 text-lg font-black">فایل خودم را دارم (PDF / Word)</h2>
          <p className="mt-1 text-xs leading-7 text-ink/70">فایل را بارگذاری کنید، جای امضا را روی همان فایل نشان دهید؛ نسخه‌ی نهایی همان فایل شما با امضاها است.</p>
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ol className="flex items-center justify-center gap-2 text-[11px] font-bold" aria-label="مراحل">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span className={`grid h-6 w-6 place-items-center rounded-full ${i < step ? "bg-emerald-500 text-white" : i === step ? "bg-ink text-white" : "bg-ink/10 text-ink/60"}`}>{i < step ? <Check size={13} /> : fd(i + 1)}</span>
            <span className={i === step ? "text-ink" : "text-ink/55"}>{s}</span>
            {i < steps.length - 1 && <span className="h-px w-5 bg-ink/15" />}
          </li>
        ))}
      </ol>

      {kindStep === "text" && (
        <section className="card space-y-5">
          <div className="grid gap-2 sm:grid-cols-2">
            {QUICK_TEMPLATES.map((t) => (
              <button key={t.id} type="button" onClick={() => { setTplId(t.id); setVals({}); setTitle(""); }} className={`rounded-2xl border p-3 text-right transition ${t.id === tplId ? "border-ink bg-ink/5 ring-2 ring-ink/10" : "border-ink/10 bg-white hover:border-ink/30"}`}>
                <span className="text-lg">{t.emoji}</span> <b className="text-sm">{t.title}</b>
                <span className="mt-0.5 block text-[11px] leading-5 text-ink/65">{t.hint}</span>
              </button>
            ))}
          </div>
          <div className="space-y-3">
            {tpl.fields.map((f) => (
              <div key={f.key}>
                <label className="label" htmlFor={`qf-${f.key}`}>{f.label}</label>
                {f.kind === "textarea" ? (
                  <textarea id={`qf-${f.key}`} rows={4} value={vals[f.key] ?? ""} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value.slice(0, 3000) })} placeholder={f.placeholder} className="input" />
                ) : (
                  <input id={`qf-${f.key}`} value={vals[f.key] ?? ""} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value.slice(0, 200) })} placeholder={f.placeholder} className="input" />
                )}
              </div>
            ))}
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={askNid} onChange={(e) => setAskNid(e.target.checked)} className="h-4 w-4 accent-[#102c31]" />از طرف مقابل کد ملی و نشانی هم بگیر (هنگام امضا پر می‌کند)</label>
          </div>
          <details className="rounded-2xl bg-stone-50 p-3 text-xs">
            <summary className="cursor-pointer font-bold">پیش‌نمایش متن سند</summary>
            <article className="contract-paper contract-body mt-3" dangerouslySetInnerHTML={{ __html: tpl.build(vals, { sender: sName.trim() || "ارسال‌کننده", recipient: rName.trim() || "طرف مقابل", today: todayFa() }) }} />
          </details>
        </section>
      )}

      {kindStep === "upload" && (
        <section className="card space-y-4">
          <DocUploader mode="quick" onUploaded={(d) => { setDoc(d); setPlacements([]); setTitle(d.name.replace(/\.(pdf|docx)$/i, "")); setStep(1); }} />
        </section>
      )}

      {kindStep === "place" && doc && (
        <section className="space-y-3">
          <DocWarnings warnings={doc.warnings} />
          <p className="text-xs leading-7 text-ink/75">برای هر دو نفر «امضا» را روی جای دلخواه فایل قرار دهید. می‌توانید تاریخ، نام، متن (مثل کد ملی) یا تیک هم اضافه کنید. فیلدها را بکشید تا جابه‌جا شوند.</p>
          <DocPlacer url={`/api/docs/draft/${doc.code}`} pages={doc.pages} signers={[{ pos: 1, label: "من (ارسال‌کننده)" }, { pos: 2, label: "طرف مقابل" }]} value={placements} onChange={setPlacements} />
        </section>
      )}

      {kindStep === "parties" && (
        <section className="card space-y-4">
          <div>
            <label className="label" htmlFor="q-title">عنوان سند</label>
            <input id="q-title" value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} className="input" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <fieldset className="space-y-3 rounded-2xl bg-stone-50 p-4">
              <legend className="px-2 text-xs font-black">من (ارسال‌کننده)</legend>
              <input value={sName} onChange={(e) => setSName(e.target.value)} placeholder="نام و نام خانوادگی" aria-label="نام شما" className="input" autoComplete="name" />
              <input value={sMobile} onChange={(e) => setSMobile(e.target.value)} placeholder="موبایل شما: 09123456789" aria-label="موبایل شما" inputMode="tel" dir="ltr" className="input text-left" autoComplete="tel" />
            </fieldset>
            <fieldset className="space-y-3 rounded-2xl bg-stone-50 p-4">
              <legend className="px-2 text-xs font-black">طرف مقابل</legend>
              <input value={rName} onChange={(e) => setRName(e.target.value)} placeholder="نام و نام خانوادگی" aria-label="نام طرف مقابل" className="input" />
              <input value={rMobile} onChange={(e) => setRMobile(e.target.value)} placeholder="موبایل او: 09123456789" aria-label="موبایل طرف مقابل" inputMode="tel" dir="ltr" className="input text-left" />
            </fieldset>
          </div>
          <p className="text-[11px] leading-6 text-ink/65">لینک امضا برای طرف مقابل پیامک می‌شود و خودش هم با کد پیامکی هویتش را تأیید می‌کند. هیچ‌کدام از شما حساب کاربری لازم ندارید.</p>
        </section>
      )}

      {kindStep === "sign" && (
        <section className="card space-y-5">
          <div className="space-y-3 rounded-2xl bg-stone-50 p-4">
            <div className="flex items-center gap-2 text-xs font-black"><Smartphone size={16} />۱) تأیید شماره‌ی شما: <span dir="ltr" className="font-mono">{fd(sMobile)}</span></div>
            {verified ? (
              <p className="flex items-center gap-2 text-xs font-bold text-emerald-700"><Check size={15} />شماره‌ی شما تأیید شد</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={sendCode} disabled={busy !== null || seconds > 0} className="btn-secondary">
                    {busy === "send" ? <LoaderCircle size={16} className="animate-spin" /> : <Send size={16} />}{sent ? "ارسال مجدد کد" : "دریافت کد پیامکی"}
                  </button>
                  {seconds > 0 && <span className="text-xs text-ink/70">ارسال مجدد تا {fd(seconds)} ثانیه دیگر</span>}
                </div>
                {devCode && <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-800"><FlaskConical size={15} className="mt-1 shrink-0" />حالت آزمایشی (پنل پیامک متصل نیست): کد شما <b className="font-mono text-base">{fd(devCode)}</b> است.</p>}
                {sent && (
                  <div className="flex gap-2">
                    <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={8} dir="ltr" placeholder="کد تأیید" aria-label="کد تأیید" className="input !w-40 text-center font-mono tracking-widest" />
                    <button type="button" onClick={verify} disabled={busy !== null} className="btn-primary">{busy === "verify" ? <LoaderCircle size={16} className="animate-spin" /> : <Check size={16} />}تأیید</button>
                  </div>
                )}
              </>
            )}
          </div>

          {mode === "file" && senderFields.length > 0 && (
            <div className="space-y-3 rounded-2xl bg-stone-50 p-4">
              <p className="text-xs font-black">فیلدهای مربوط به شما روی فایل</p>
              {senderFields.map((p) => (
                <div key={fieldKeyFor(p)}>
                  {p.kind === "checkbox" ? (
                    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={fields[fieldKeyFor(p)] === "1"} onChange={(e) => setFields({ ...fields, [fieldKeyFor(p)]: e.target.checked ? "1" : "" })} />{p.label || "تأیید می‌کنم"}</label>
                  ) : (
                    <input value={fields[fieldKeyFor(p)] ?? ""} onChange={(e) => setFields({ ...fields, [fieldKeyFor(p)]: e.target.value })} placeholder={p.label || "متن"} aria-label={p.label || "متن"} className="input" />
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="rounded-2xl border border-ink/10 bg-white p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-black"><PenLine size={16} />۲) امضای شما</div>
            <SignatureCapture onChange={(data, m) => { setSignature(data); setMethod(m); }} />
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-stone-50 p-4 text-xs leading-7">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-1.5 h-4 w-4 accent-[#102c31]" />
            سند را مطالعه کرده‌ام و با مفاد آن موافقم؛ با این امضا برای «{rName || "طرف مقابل"}» ارسال شود.
          </label>
        </section>
      )}

      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}

      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => { setError(""); if (step === 0) setMode(null); else setStep((s) => s - 1); }} className="btn-ghost"><ArrowRight size={16} />قبلی</button>
        {kindStep === "sign" ? (
          <button type="button" onClick={submit} disabled={busy !== null} className="btn-primary btn-mint !min-h-[50px] sm:!px-8">
            {busy === "create" ? <LoaderCircle size={17} className="animate-spin" /> : <Zap size={17} />}امضا و ارسال
          </button>
        ) : kindStep === "upload" ? null : (
          <button type="button" onClick={next} className="btn-primary">بعدی<ArrowLeft size={16} /></button>
        )}
      </div>
    </div>
  );
}

export { FIELD_KINDS };
