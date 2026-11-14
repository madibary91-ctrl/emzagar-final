"use client";

import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, Database, Eye, EyeOff, KeyRound, Loader2, PartyPopper, Rocket, ShieldCheck, Sparkles, UserRound, Wand2, XCircle } from "lucide-react";
import { installAccountAction, installDatabaseAction, installFinishAction, testDatabaseAction, type StepResult } from "@/modules/install/actions";
import type { DbInput, InstallStatus } from "@/modules/install/service";

type Step = "welcome" | "database" | "account" | "running" | "done";
const FLOW: { id: Step; label: string }[] = [
  { id: "welcome", label: "شروع" },
  { id: "database", label: "دیتابیس" },
  { id: "account", label: "حساب مدیر" },
  { id: "running", label: "نصب" },
  { id: "done", label: "پایان" },
];

function strength(p: string): { score: number; label: string } {
  let score = 0;
  if (p.length >= 8) score++;
  if (p.length >= 12) score++;
  if (/[A-Za-z]/.test(p) && /\d/.test(p)) score++;
  if (/[^A-Za-z0-9]/.test(p) || (/[a-z]/.test(p) && /[A-Z]/.test(p))) score++;
  return { score, label: ["خیلی ضعیف", "ضعیف", "متوسط", "خوب", "عالی"][score] };
}

function generatePassword(): string {
  const letters = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const all = letters + digits + "!@#$%^&*";
  const rnd = (n: number) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  const chars = [letters[rnd(letters.length)], digits[rnd(digits.length)]];
  while (chars.length < 14) chars.push(all[rnd(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = rnd(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}

function Check1({ ok, warn, children, hint }: { ok: boolean; warn?: boolean; children: ReactNode; hint?: string }) {
  return (
    <li className="flex items-start gap-3 rounded-2xl border border-ink/10 bg-white p-3.5">
      {ok ? <CheckCircle2 size={20} className="mt-0.5 flex-none text-emerald-700" /> : warn ? <AlertTriangle size={20} className="mt-0.5 flex-none text-amber-600" /> : <XCircle size={20} className="mt-0.5 flex-none text-rose-600" />}
      <div><b className="block text-sm">{children}</b>{hint && !ok && <span className="mt-1 block text-[13px] leading-6 text-ink/75">{hint}</span>}</div>
    </li>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <div><label className="label">{label}</label>{children}{hint && <p className="mt-1.5 text-xs leading-5 text-ink/72">{hint}</p>}</div>;
}

export default function InstallWizard({ status }: { status: InstallStatus }) {
  // فقط مقدار اولیه: پس از ساخت حساب، سرور صفحه را دوباره رندر می‌کند و status.installed می‌شود true؛ نباید وسط نصب پیام «قبلاً نصب شده» بدهیم
  const [already] = useState(status.installed);
  const [step, setStep] = useState<Step>(status.installed ? "done" : "welcome");
  const [installKey, setInstallKey] = useState("");

  // دیتابیس
  const [advanced, setAdvanced] = useState(false);
  const [db, setDb] = useState({ host: "localhost", port: "5432", name: "", user: "", password: "", ssl: false, url: "" });
  const [showDbPass, setShowDbPass] = useState(false);
  const [dbTest, setDbTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // حساب
  const [acc, setAcc] = useState({ siteName: "", name: "", email: "", mobile: "", password: "", confirm: "" });
  const [showPass, setShowPass] = useState(false);
  const [accError, setAccError] = useState("");

  // اجرا
  const [progress, setProgress] = useState<{ id: string; label: string; state: "wait" | "run" | "ok" | "fail" }[]>([]);
  const [runError, setRunError] = useState("");

  const needDb = !(status.databaseFromEnv && status.databaseConnected);
  const dbInput: DbInput = advanced
    ? { mode: "url", url: db.url }
    : { mode: "simple", host: db.host, port: db.port, name: db.name, user: db.user, password: db.password, ssl: db.ssl };
  const pw = useMemo(() => strength(acc.password), [acc.password]);
  const blocked = !status.nodeOk || !status.storageOk || status.stateUnknown || (status.databaseFromEnv && !status.databaseConnected);

  const testDb = async () => {
    setTesting(true);
    setDbTest(null);
    const r = await testDatabaseAction(dbInput, installKey).catch((): StepResult => ({ ok: false, error: "ارتباط با سرور برقرار نشد" }));
    setTesting(false);
    setDbTest({ ok: r.ok, text: r.ok ? r.note || "اتصال موفق بود." : r.error || "اتصال ناموفق بود." });
  };

  const accProblem = (): string => {
    if (!acc.siteName.trim()) return "نام سایت یا کسب‌وکار را وارد کنید.";
    if (!acc.name.trim()) return "نام و نام‌خانوادگی را وارد کنید.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(acc.email.trim())) return "ایمیل معتبر نیست.";
    if (!/^09\d{9}$/.test(acc.mobile.trim())) return "موبایل باید به‌صورت 09123456789 باشد (با ارقام انگلیسی).";
    if (acc.password.length < 8) return "رمز عبور باید حداقل ۸ نویسه باشد.";
    if (!/[A-Za-z\u0600-\u06FF]/.test(acc.password) || !/\d/.test(acc.password)) return "رمز عبور باید ترکیبی از حروف و عدد باشد.";
    if (acc.password !== acc.confirm) return "تکرار رمز عبور یکسان نیست.";
    return "";
  };

  const run = async () => {
    setRunError("");
    setStep("running");
    const items = [
      { id: "db", label: "اتصال به دیتابیس، ذخیره‌ی تنظیمات و ساخت جدول‌ها", state: "wait" as const },
      { id: "acc", label: "ساخت حساب مدیر، قالب‌های نمونه و صفحه‌ی اصلی", state: "wait" as const },
      { id: "fin", label: "نهایی‌سازی و ورود خودکار", state: "wait" as const },
    ];
    setProgress(items);
    const mark = (i: number, state: "run" | "ok" | "fail") => setProgress((p) => p.map((x, k) => (k === i ? { ...x, state } : x)));
    const calls: (() => Promise<StepResult>)[] = [
      () => installDatabaseAction(dbInput, installKey),
      () => installAccountAction({ siteName: acc.siteName, name: acc.name, email: acc.email, mobile: acc.mobile, password: acc.password }, installKey),
      () => installFinishAction(),
    ];
    for (let i = 0; i < calls.length; i++) {
      mark(i, "run");
      await new Promise((r) => setTimeout(r, 450));
      const res = await calls[i]().catch((): StepResult => ({ ok: false, error: "ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی و دوباره تلاش کنید." }));
      if (!res.ok) {
        mark(i, "fail");
        setRunError(res.error || "خطای ناشناخته");
        return;
      }
      mark(i, "ok");
    }
    await new Promise((r) => setTimeout(r, 500));
    setStep("done");
  };

  const idx = FLOW.findIndex((f) => f.id === step);

  return (
    <main className="relative min-h-screen overflow-hidden bg-ink px-4 py-8 text-white sm:py-12">
      <div className="hero-grid pointer-events-none absolute inset-0 opacity-50" />
      <div className="soft-pulse pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-mint/15 blur-[90px]" />
      <div className="relative mx-auto w-full max-w-2xl">
        <div className="mb-7 flex items-center justify-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-mint text-ink"><Sparkles size={24} /></span>
          <div><b className="block text-xl font-black">نصب امضاگیر</b><span className="text-xs text-white/65">فقط چند دقیقه؛ بدون نیاز به دانش فنی</span></div>
        </div>

        {step !== "done" && (
          <ol className="mb-6 flex items-center justify-center gap-1.5 sm:gap-3" aria-label="مراحل نصب">
            {FLOW.slice(0, 4).map((f, i) => (
              <li key={f.id} className="flex items-center gap-1.5 sm:gap-3" aria-current={i === idx ? "step" : undefined}>
                <span className={`grid h-8 w-8 place-items-center rounded-full text-xs font-black transition ${i < idx ? "bg-mint text-ink" : i === idx ? "bg-white text-ink" : "bg-white/10 text-white/65"}`}>{i < idx ? <Check size={15} /> : (i + 1).toLocaleString("fa-IR")}</span>
                <span className={`hidden text-xs font-bold sm:block ${i === idx ? "text-white" : "text-white/65"}`}>{f.label}</span>
                {i < 3 && <span className="h-px w-5 bg-white/15 sm:w-9" />}
              </li>
            ))}
          </ol>
        )}

        <div className="rounded-[28px] bg-[#fafbf7] p-6 text-ink shadow-[0_40px_90px_rgba(0,0,0,.35)] sm:p-9">
          {/* ───── خوش‌آمدید و بررسی سیستم ───── */}
          {step === "welcome" && (
            <div>
              <h1 className="text-2xl font-black">خوش آمدید 👋</h1>
              <p className="mt-3 text-sm leading-8 text-ink/75">نصب در سه قدم ساده انجام می‌شود: اطلاعات دیتابیس، ساخت حساب مدیر، و تمام. همه‌چیز خودکار است؛ لازم نیست فایلی ویرایش کنید یا دستوری تایپ کنید.</p>
              <p className="mb-2 mt-6 text-xs font-black text-ink/72">بررسی خودکار سرور شما</p>
              <ul className="space-y-2">
                <Check1 ok={status.nodeOk} hint="نسخه‌ی Node.js سرور باید ۲۰ یا بالاتر باشد. در پنل هاست (Setup Node.js App) نسخه را ارتقا دهید.">نسخه‌ی Node.js: {status.nodeVersion}</Check1>
                <Check1 ok={status.storageOk} hint="روی پوشه‌ی «storage» اجازه‌ی نوشتن (Write / سطح دسترسی 755 یا 775) بدهید؛ از «مدیریت فایل» پنل هاست.">پوشه‌ی ذخیره‌سازی قابل نوشتن است</Check1>
                {status.databaseFromEnv
                  ? <Check1 ok={status.databaseConnected} hint="سرور دیتابیس تنظیم‌شده پاسخ نمی‌دهد. از مدیر سرور بخواهید DATABASE_URL را بررسی کند.">اتصال دیتابیس توسط سرور فراهم شده است</Check1>
                  : <Check1 ok warn>اطلاعات دیتابیس را در قدم بعد وارد می‌کنید</Check1>}
                <Check1 ok={status.https} warn hint="سایت با http باز شده است. برای امنیت بهتر، گواهی SSL را در پنل هاست فعال کنید (رایگان است).">اتصال امن (HTTPS)</Check1>
              </ul>
              {status.keyRequired && (
                <div className="mt-5"><Field label="کلید نصب" hint={status.keySource === "env" ? "همان مقداری که در تنظیمات سرور به‌عنوان INSTALL_KEY گذاشته‌اید." : "برای اثبات اینکه شما مالک سرور هستید: کلید را در فایل storage/install-key.txt (مدیریت فایل هاست) یا در لاگ سرور (docker compose logs app) پیدا کنید."}><input className="input ltr text-left" dir="ltr" type="password" autoComplete="off" value={installKey} onChange={(e) => setInstallKey(e.target.value)} /></Field></div>
              )}
              <button className="btn-primary mt-7 w-full !min-h-12" disabled={blocked || (status.keyRequired && !installKey)} onClick={() => setStep(needDb ? "database" : "account")}>
                شروع نصب<ArrowLeft size={16} />
              </button>
              {status.stateUnknown && <p className="mt-3 text-center text-xs font-bold text-rose-700">اتصال به دیتابیس پیکربندی‌شده برقرار نیست؛ برای امنیت نصب‌کننده تا اتصال دیتابیس بسته است.</p>}
              {blocked && <p className="mt-3 text-center text-xs text-rose-700">ابتدا موارد قرمز بالا را برطرف کنید و صفحه را دوباره باز کنید.</p>}
            </div>
          )}

          {/* ───── دیتابیس ───── */}
          {step === "database" && (
            <div>
              <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-ink text-mint"><Database size={20} /></span><h2 className="text-xl font-black">اطلاعات دیتابیس</h2></div>
              <p className="mt-3 text-sm leading-8 text-ink/75">دیتابیس جایی است که قراردادها ذخیره می‌شوند. اطلاعات آن را از پنل هاست (بخش «PostgreSQL» یا «Databases») بردارید. اگر دیتابیس هنوز ساخته نشده، خودکار ساخته می‌شود.</p>
              <details className="mt-3 rounded-2xl bg-stone-100 p-3.5 text-[13px] leading-7 text-ink/72">
                <summary className="cursor-pointer font-bold">این اطلاعات را از کجا بیاورم؟</summary>
                <ol className="mr-4 mt-2 list-decimal space-y-1">
                  <li>وارد پنل هاست (cPanel یا DirectAdmin) شوید.</li>
                  <li>بخش «PostgreSQL Databases» را باز کنید.</li>
                  <li>یک دیتابیس و یک کاربر بسازید و کاربر را به دیتابیس متصل کنید (همه‌ی دسترسی‌ها).</li>
                  <li>نام دیتابیس، نام کاربری و رمز را همین‌جا وارد کنید. «آدرس سرور» معمولاً همان localhost است.</li>
                </ol>
                <p className="mt-2">راه ساده‌تر: از پشتیبانی هاست بخواهید «اطلاعات اتصال PostgreSQL» را بدهد.</p>
              </details>

              <div className="mt-5 space-y-4">
                {!advanced ? (
                  <>
                    <div className="grid gap-4 sm:grid-cols-[1fr_110px]">
                      <Field label="آدرس سرور (Host)"><input className="input ltr text-left" dir="ltr" value={db.host} onChange={(e) => setDb({ ...db, host: e.target.value })} /></Field>
                      <Field label="پورت"><input className="input ltr text-left" dir="ltr" inputMode="numeric" value={db.port} onChange={(e) => setDb({ ...db, port: e.target.value.replace(/\D/g, "") })} /></Field>
                    </div>
                    <Field label="نام دیتابیس"><input className="input ltr text-left" dir="ltr" autoComplete="off" value={db.name} onChange={(e) => setDb({ ...db, name: e.target.value })} /></Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="نام کاربری"><input className="input ltr text-left" dir="ltr" autoComplete="off" value={db.user} onChange={(e) => setDb({ ...db, user: e.target.value })} /></Field>
                      <Field label="رمز عبور">
                        <div className="relative">
                          <input className="input ltr pl-11 text-left" dir="ltr" type={showDbPass ? "text" : "password"} autoComplete="new-password" value={db.password} onChange={(e) => setDb({ ...db, password: e.target.value })} />
                          <button type="button" className="absolute left-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-lg text-ink/72 hover:bg-ink/5" aria-label={showDbPass ? "پنهان کردن رمز" : "نمایش رمز"} onClick={() => setShowDbPass((v) => !v)}>{showDbPass ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                        </div>
                      </Field>
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 text-sm font-bold"><input type="checkbox" className="h-4 w-4" checked={db.ssl} onChange={(e) => setDb({ ...db, ssl: e.target.checked })} />اتصال امن SSL (فقط اگر هاست خواسته است)</label>
                  </>
                ) : (
                  <Field label="آدرس کامل اتصال" hint="مثال: postgresql://user:password@host:5432/dbname"><input className="input ltr text-left" dir="ltr" autoComplete="off" value={db.url} onChange={(e) => setDb({ ...db, url: e.target.value })} /></Field>
                )}
                <button type="button" className="text-xs font-bold text-ink/75 underline underline-offset-4" onClick={() => { setAdvanced((v) => !v); setDbTest(null); }}>{advanced ? "برگشت به فرم ساده" : "من آدرس کامل اتصال را دارم (پیشرفته)"}</button>
              </div>

              {dbTest && <p role="status" className={`mt-5 flex items-start gap-2 rounded-2xl p-3.5 text-sm leading-7 ${dbTest.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>{dbTest.ok ? <CheckCircle2 size={18} className="mt-1 flex-none" /> : <XCircle size={18} className="mt-1 flex-none" />}{dbTest.text}</p>}

              <div className="mt-6 flex flex-col gap-2 sm:flex-row">
                <button className="btn-secondary" onClick={() => setStep("welcome")}><ArrowRight size={15} />قبلی</button>
                <button className="btn-secondary flex-1" disabled={testing} onClick={testDb}>{testing ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}آزمایش اتصال</button>
                <button className="btn-primary flex-1" disabled={!dbTest?.ok} onClick={() => setStep("account")}>ادامه<ArrowLeft size={15} /></button>
              </div>
              {!dbTest?.ok && <p className="mt-3 text-center text-xs text-ink/72">برای ادامه، ابتدا «آزمایش اتصال» را بزنید.</p>}
            </div>
          )}

          {/* ───── حساب مدیر ───── */}
          {step === "account" && (
            <form onSubmit={(e) => { e.preventDefault(); const p = accProblem(); setAccError(p); if (!p) void run(); }} noValidate>
              <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-ink text-mint"><UserRound size={20} /></span><h2 className="text-xl font-black">سایت و حساب مدیر</h2></div>
              <p className="mt-3 text-sm leading-8 text-ink/75">با این اطلاعات وارد پنل مدیریت می‌شوید. ایمیل و رمز را جایی امن یادداشت کنید.</p>
              <div className="mt-5 space-y-4">
                <Field label="نام سایت یا کسب‌وکار"><input className="input" value={acc.siteName} maxLength={40} onChange={(e) => setAcc({ ...acc, siteName: e.target.value })} placeholder="مثلاً: امضاگیر" /></Field>
                <Field label="نام و نام‌خانوادگی شما"><input className="input" value={acc.name} maxLength={100} autoComplete="name" onChange={(e) => setAcc({ ...acc, name: e.target.value })} /></Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="ایمیل"><input className="input ltr text-left" dir="ltr" type="email" autoComplete="email" value={acc.email} onChange={(e) => setAcc({ ...acc, email: e.target.value })} /></Field>
                  <Field label="موبایل"><input className="input ltr text-left" dir="ltr" inputMode="numeric" autoComplete="tel" placeholder="09123456789" value={acc.mobile} onChange={(e) => setAcc({ ...acc, mobile: e.target.value.replace(/\D/g, "").slice(0, 11) })} /></Field>
                </div>
                <Field label="رمز عبور">
                  <div className="relative">
                    <input className="input ltr pl-24 text-left" dir="ltr" type={showPass ? "text" : "password"} autoComplete="new-password" value={acc.password} onChange={(e) => setAcc({ ...acc, password: e.target.value, confirm: acc.confirm })} />
                    <div className="absolute left-1.5 top-1/2 flex -translate-y-1/2 gap-0.5">
                      <button type="button" className="grid h-9 w-9 place-items-center rounded-lg text-ink/72 hover:bg-ink/5" aria-label="ساخت رمز قوی" title="ساخت رمز قوی" onClick={() => { const g = generatePassword(); setAcc({ ...acc, password: g, confirm: g }); setShowPass(true); }}><Wand2 size={16} /></button>
                      <button type="button" className="grid h-9 w-9 place-items-center rounded-lg text-ink/72 hover:bg-ink/5" aria-label={showPass ? "پنهان کردن رمز" : "نمایش رمز"} onClick={() => setShowPass((v) => !v)}>{showPass ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                    </div>
                  </div>
                  {acc.password && (
                    <div className="mt-2 flex items-center gap-2" aria-live="polite">
                      <div className="flex h-1.5 flex-1 gap-1">{[0, 1, 2, 3].map((i) => <span key={i} className={`flex-1 rounded-full ${i < pw.score ? (pw.score < 2 ? "bg-rose-500" : pw.score < 3 ? "bg-amber-500" : "bg-emerald-500") : "bg-stone-200"}`} />)}</div>
                      <span className="text-xs font-bold text-ink/75">{pw.label}</span>
                    </div>
                  )}
                </Field>
                <Field label="تکرار رمز عبور"><input className="input ltr text-left" dir="ltr" type={showPass ? "text" : "password"} autoComplete="new-password" value={acc.confirm} onChange={(e) => setAcc({ ...acc, confirm: e.target.value })} /></Field>
              </div>
              {accError && <p role="alert" className="mt-5 flex items-start gap-2 rounded-2xl bg-rose-50 p-3.5 text-sm leading-7 text-rose-800"><XCircle size={18} className="mt-1 flex-none" />{accError}</p>}
              <div className="mt-6 flex gap-2">
                {needDb && <button type="button" className="btn-secondary" onClick={() => setStep("database")}><ArrowRight size={15} />قبلی</button>}
                <button className="btn-primary flex-1 !min-h-12"><Rocket size={16} />نصب را شروع کن</button>
              </div>
            </form>
          )}

          {/* ───── در حال نصب ───── */}
          {step === "running" && (
            <div>
              <h2 className="text-xl font-black">در حال نصب…</h2>
              <p className="mt-2 text-sm text-ink/75">لطفاً صفحه را نبندید؛ معمولاً کمتر از یک دقیقه طول می‌کشد.</p>
              <ul className="mt-6 space-y-3" aria-live="polite">
                {progress.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 rounded-2xl border border-ink/10 bg-white p-4">
                    {p.state === "ok" ? <CheckCircle2 size={22} className="flex-none text-emerald-700" /> : p.state === "run" ? <Loader2 size={22} className="flex-none animate-spin text-ink" /> : p.state === "fail" ? <XCircle size={22} className="flex-none text-rose-600" /> : <span className="h-[22px] w-[22px] flex-none rounded-full border-2 border-ink/15" />}
                    <span className={`text-sm font-bold ${p.state === "wait" ? "text-ink/72" : ""}`}>{p.label}</span>
                  </li>
                ))}
              </ul>
              {runError && (
                <div className="mt-5">
                  <p role="alert" className="flex items-start gap-2 rounded-2xl bg-rose-50 p-3.5 text-sm leading-7 text-rose-800"><XCircle size={18} className="mt-1 flex-none" />{runError}</p>
                  <div className="mt-4 flex gap-2">
                    <button className="btn-secondary" onClick={() => setStep("account")}><ArrowRight size={15} />ویرایش اطلاعات</button>
                    <button className="btn-primary flex-1" onClick={() => void run()}>تلاش دوباره</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ───── پایان ───── */}
          {step === "done" && (
            <div className="text-center">
              <span className="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-mint text-ink"><PartyPopper size={30} /></span>
              <h2 className="mt-5 text-2xl font-black">{already ? "سامانه قبلاً نصب شده است" : "نصب با موفقیت انجام شد! 🎉"}</h2>
              <p className="mt-3 text-sm leading-8 text-ink/75">{already ? "برای ورود به بخش مدیریت از دکمه‌ی زیر استفاده کنید." : "شما به‌صورت خودکار وارد شده‌اید. چند کار پیشنهادی برای شروع:"}</p>
              {!already && (
                <ul className="mt-5 space-y-2 text-right text-sm">
                  {[[Sparkles, "صفحه‌ی اصلی سایت را شخصی‌سازی کنید", "/admin/landing"], [KeyRound, "پیامک و ایمیل را تنظیم کنید (برای کد تأیید امضا)", "/admin/settings"], [ShieldCheck, "قالب‌های قرارداد نمونه را ببینید", "/admin/templates"]].map(([I, t, href]) => {
                    const Ic = I as typeof Sparkles;
                    return <li key={href as string}><a href={href as string} className="flex items-center gap-3 rounded-2xl border border-ink/10 bg-white p-3.5 font-bold transition hover:border-ink/30"><span className="grid h-9 w-9 place-items-center rounded-xl bg-stone-100"><Ic size={17} /></span>{t as string}<ArrowLeft size={15} className="mr-auto text-ink/72" /></a></li>;
                  })}
                </ul>
              )}
              <a href={already ? "/login" : "/admin"} className="btn-primary mt-7 w-full !min-h-12">{already ? "ورود به سامانه" : "ورود به پنل مدیریت"}<ArrowLeft size={16} /></a>
            </div>
          )}
        </div>
        <p className="mt-6 text-center text-xs text-white/65">اطلاعات شما فقط روی سرور خودتان ذخیره می‌شود.</p>
      </div>
    </main>
  );
}
