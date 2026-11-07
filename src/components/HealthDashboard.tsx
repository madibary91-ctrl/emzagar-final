"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, ChevronDown, ClipboardCopy, Download, FlaskConical, Loader2, Mail, MessageSquare, MinusCircle, RefreshCw, Rocket, Search, ShieldAlert, Wrench, XCircle, Zap } from "lucide-react";
import { GROUPS, type CheckResult, type HealthSnapshot, type HealthStatus, type HistoryInfo } from "@/modules/health/types";

const fa = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

const META: Record<HealthStatus, { label: string; chip: string; dot: string; text: string; Icon: typeof CheckCircle2 }> = {
  ok: { label: "سالم", chip: "bg-emerald-50 text-emerald-800 border-emerald-200", dot: "bg-emerald-500", text: "text-emerald-700", Icon: CheckCircle2 },
  warn: { label: "هشدار", chip: "bg-amber-50 text-amber-800 border-amber-200", dot: "bg-amber-500", text: "text-amber-700", Icon: AlertTriangle },
  fail: { label: "خطا", chip: "bg-red-50 text-red-700 border-red-200", dot: "bg-red-500", text: "text-red-700", Icon: XCircle },
  unconfigured: { label: "تنظیم نشده", chip: "bg-slate-100 text-slate-700 border-slate-200", dot: "bg-slate-400", text: "text-slate-600", Icon: MinusCircle },
};
const TONE: Record<string, string> = { ok: "text-emerald-700", warn: "text-amber-700", fail: "text-red-700" };

function rel(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 8) return "هم‌اکنون";
  if (s < 60) return `${fa(s)} ثانیه پیش`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${fa(m)} دقیقه پیش`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${fa(h)} ساعت پیش`;
  return `${fa(Math.floor(h / 24))} روز پیش`;
}
const dur = (a: string, b: string | null, now: number) => {
  const ms = (b ? new Date(b).getTime() : now) - new Date(a).getTime();
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${fa(m)} دقیقه` : m < 2880 ? `${fa(Math.round(m / 60))} ساعت` : `${fa(Math.round(m / 1440))} روز`;
};

function Spark({ h }: { h?: HistoryInfo }) {
  const s = h?.samples ?? [];
  if (s.length < 2) return <div className="flex h-7 items-center text-[11px] text-ink/60">تاریخچه در حال جمع‌آوری است…</div>;
  const max = Math.max(200, ...s.map((x) => x.ms ?? 0));
  return (
    <div className="flex h-7 items-end gap-[2px]" role="img" aria-label={`نمودار تأخیر ${fa(s.length)} نمونه‌ی اخیر`}>
      {s.map((x, i) => (
        <span key={i} title={`${new Date(x.t).toLocaleTimeString("fa-IR")} · ${META[x.s].label}${x.ms != null ? ` · ${fa(x.ms)}ms` : ""}`} className={`w-[5px] rounded-sm ${META[x.s].dot} ${x.s === "ok" ? "opacity-60" : ""}`} style={{ height: `${Math.max(14, Math.min(100, ((x.ms ?? 0) / max) * 100))}%` }} />
      ))}
    </div>
  );
}

function Ring({ score, verdict }: { score: number; verdict: string }) {
  const r = 52, c = 2 * Math.PI * r;
  const color = verdict === "ready" ? "#10b981" : verdict === "almost" ? "#f59e0b" : "#ef4444";
  return (
    <div className="relative h-36 w-36 shrink-0" role="img" aria-label={`امتیاز آمادگی ${fa(score)} از ۱۰۰`}>
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(16,44,49,.09)" strokeWidth="10" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} style={{ transition: "stroke-dashoffset .8s ease" }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <b className="text-3xl font-black tabular">{fa(score)}</b>
        <span className="text-[11px] font-semibold text-ink/70">از ۱۰۰</span>
      </div>
    </div>
  );
}

type Toast = { kind: "ok" | "err"; text: string } | null;

export default function HealthDashboard() {
  const [snap, setSnap] = useState<HealthSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, "run" | "deep">>({});
  const [bulk, setBulk] = useState<"" | "refresh" | "deep">("");
  const [auto, setAuto] = useState(60);
  const [filter, setFilter] = useState<"all" | "attention" | "unconfigured">("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<Toast>(null);
  const [now, setNow] = useState(() => Date.now());
  const [mailTo, setMailTo] = useState("");
  const [smsTo, setSmsTo] = useState("");
  const [tool, setTool] = useState<"" | "email" | "sms">("");
  const [origin, setOrigin] = useState("");
  const inflight = useRef(false);

  const say = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 7000);
  }, []);

  const load = useCallback(async (force: boolean, quiet = false) => {
    if (inflight.current) return;
    inflight.current = true;
    if (!quiet) setBulk(force ? "refresh" : "");
    try {
      const res = await fetch(`/api/platform/health${force ? "?force=1" : ""}`, { cache: "no-store" });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.snapshot) throw new Error(j?.error || `خطای سرور (${res.status})`);
      setSnap(j.snapshot as HealthSnapshot);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "دریافت وضعیت ناموفق بود");
    } finally {
      inflight.current = false;
      setLoading(false);
      setBulk("");
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    void load(false);
  }, [load]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (!auto) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true, true);
    }, auto * 1000);
    return () => window.clearInterval(t);
  }, [auto, load]);

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/platform/health", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => null);
    if (!j) throw new Error(`پاسخ نامعتبر (${res.status})`);
    return { res, j };
  }

  async function runOne(id: string, deep: boolean) {
    setBusy((b) => ({ ...b, [id]: deep ? "deep" : "run" }));
    try {
      const { j } = await post({ action: "run", id, deep });
      if (!j.ok) throw new Error(j.error || "ناموفق");
      const r = j.result as CheckResult;
      setSnap((s) => (s ? { ...s, results: s.results.map((x) => (x.id === r.id ? r : x)) } : s));
      setOpen((o) => new Set(o).add(id));
      say(r.status === "fail" ? "err" : "ok", `${r.label}: ${r.summary}`);
      void load(false, true);
    } catch (e) {
      say("err", e instanceof Error ? e.message : "اجرای تست ناموفق بود");
    } finally {
      setBusy((b) => {
        const n = { ...b };
        delete n[id];
        return n;
      });
    }
  }

  async function deepAll() {
    if (!window.confirm("تست عمیق همه‌ی سرویس‌ها اجرا شود؟\n\nدرخواست آزمایشی به درگاه‌ها (بدون پرداخت)، یک پیام کوتاه به سرویس هوش مصنوعی و بررسی امضاشده‌ی لایسنس انجام می‌شود. حدود نیم دقیقه طول می‌کشد.")) return;
    setBulk("deep");
    try {
      const { j } = await post({ action: "deep-all" });
      if (!j.ok) throw new Error(j.error || "ناموفق");
      setSnap(j.snapshot as HealthSnapshot);
      say("ok", "تست عمیق همه‌ی سرویس‌ها انجام شد.");
    } catch (e) {
      say("err", e instanceof Error ? e.message : "تست عمیق ناموفق بود");
    } finally {
      setBulk("");
    }
  }

  async function sendTest(kind: "email" | "sms") {
    setTool(kind);
    try {
      const { j } = await post({ action: kind, to: kind === "email" ? mailTo : smsTo });
      say(j.ok ? "ok" : "err", j.ok ? j.message : j.error || "ناموفق");
    } catch (e) {
      say("err", e instanceof Error ? e.message : "ارسال ناموفق بود");
    } finally {
      setTool("");
    }
  }

  async function copyReport() {
    if (!snap) return;
    const lines = [
      `گزارش سلامت امضاگیر — ${new Date(snap.generatedAt).toLocaleString("fa-IR")}`,
      `امتیاز آمادگی: ${snap.readiness.score}/100 (${snap.readiness.verdictLabel})`,
      ...snap.results.map((r) => `[${META[r.status].label}] ${r.label}: ${r.summary}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      say("ok", "خلاصه‌ی گزارش کپی شد.");
    } catch {
      say("err", "کپی ممکن نشد؛ از «دریافت گزارش» استفاده کنید.");
    }
  }

  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const visible = useMemo(() => {
    if (!snap) return [];
    const term = q.trim().toLowerCase();
    return snap.results.filter((r) => {
      if (filter === "attention" && r.status !== "fail" && r.status !== "warn") return false;
      if (filter === "unconfigured" && r.status !== "unconfigured") return false;
      return !term || `${r.label} ${r.summary} ${r.id}`.toLowerCase().includes(term);
    });
  }, [snap, filter, q]);

  if (loading && !snap) {
    return (
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <div className="panel-solid flex items-center gap-3 p-6 text-sm font-semibold"><Loader2 className="animate-spin" size={18} />در حال سنجش اتصال همه‌ی سرویس‌ها (دیتابیس، ایمیل، پیامک، درگاه‌ها، هوش مصنوعی، لایسنس)…</div>
        <div className="grid gap-3 lg:grid-cols-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="panel-solid h-36 animate-pulse" />)}</div>
      </div>
    );
  }
  if (!snap) {
    return (
      <div role="alert" className="panel-solid p-6">
        <p className="mb-3 flex items-center gap-2 font-bold text-red-700"><XCircle size={18} />{error || "دریافت وضعیت ناموفق بود"}</p>
        <button className="btn btn-primary btn-sm" onClick={() => { setLoading(true); void load(true); }}>تلاش دوباره</button>
      </div>
    );
  }

  const { readiness: rd, environment: env } = snap;
  const prod = env.nodeEnv === "production";

  return (
    <div className="space-y-6">
      {/* نوار وضعیت محیط */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`badge border ${prod ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>{prod ? "محیط Production" : `محیط ${env.nodeEnv === "development" ? "توسعه" : env.nodeEnv}`}</span>
        {env.simulator && <span className="badge border border-red-200 bg-red-50 text-red-700"><ShieldAlert size={13} />شبیه‌ساز فعال: {env.simulator}</span>}
        <span className="badge border border-line bg-white text-ink/80">نسخه {env.version}</span>
        <span className="badge border border-line bg-white text-ink/80">Node {env.nodeVersion}</span>
        <span className="badge border border-line bg-white text-ink/80">فضای کاری مؤثر: {env.workspaceName || (env.workspaceId ? `#${env.workspaceId}` : "پلتفرم")}</span>
        <span className="mr-auto text-ink/70" aria-live="polite">آخرین به‌روزرسانی: {rel(snap.generatedAt, now)}</span>
      </div>

      {/* نوار ابزار */}
      <div className="panel-solid flex flex-wrap items-center gap-2 p-3">
        <button className="btn btn-primary btn-sm" disabled={!!bulk} onClick={() => void load(true)}>{bulk === "refresh" ? <Loader2 className="animate-spin" size={15} /> : <RefreshCw size={15} />}بررسی مجدد همه</button>
        <button className="btn btn-secondary btn-sm" disabled={!!bulk} onClick={() => void deepAll()}>{bulk === "deep" ? <Loader2 className="animate-spin" size={15} /> : <FlaskConical size={15} />}تست عمیق همه</button>
        <a className="btn btn-secondary btn-sm" href="/api/platform/health/export"><Download size={15} />دریافت گزارش (JSON)</a>
        <button className="btn btn-ghost btn-sm" onClick={() => void copyReport()}><ClipboardCopy size={15} />کپی خلاصه</button>
        <label className="mr-auto flex items-center gap-2 text-xs font-semibold text-ink/80">
          <Activity size={14} />به‌روزرسانی خودکار
          <select className="input !h-8 !w-auto !py-0 text-xs" value={auto} onChange={(e) => setAuto(Number(e.target.value))} aria-label="فاصله‌ی به‌روزرسانی خودکار">
            <option value={0}>خاموش</option><option value={30}>هر ۳۰ ثانیه</option><option value={60}>هر ۱ دقیقه</option><option value={300}>هر ۵ دقیقه</option>
          </select>
        </label>
      </div>

      {error && <p role="alert" className="rounded-2xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}

      {/* آمادگی لانچ */}
      <section className="panel-solid grid gap-6 p-6 lg:grid-cols-[auto_1fr_1fr]" aria-labelledby="readiness-title">
        <div className="flex items-center gap-5">
          <Ring score={rd.score} verdict={rd.verdict} />
          <div>
            <h2 id="readiness-title" className="flex items-center gap-2 text-lg font-black"><Rocket size={18} />آمادگی لانچ</h2>
            <p className={`mt-1 text-xl font-black ${rd.verdict === "ready" ? "text-emerald-700" : rd.verdict === "almost" ? "text-amber-700" : "text-red-700"}`}>{rd.verdictLabel}</p>
            <p className="mt-1 max-w-[16rem] text-xs leading-6 text-ink/70">بر پایه‌ی وزن سرویس‌های حیاتی (دیتابیس، ایمیل، پرداخت، پیکربندی) سنجیده می‌شود{!prod ? " — در محیط توسعه با معیار production ارزیابی شده است." : "."}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 self-center">
          {(["ok", "warn", "fail", "unconfigured"] as HealthStatus[]).map((s) => {
            const M = META[s];
            return (
              <button key={s} onClick={() => setFilter(s === "unconfigured" ? "unconfigured" : s === "ok" ? "all" : "attention")} className={`flex items-center gap-3 rounded-2xl border p-3 text-right ${M.chip}`} aria-label={`${M.label}: ${rd.counts[s]} سرویس`}>
                <M.Icon size={20} />
                <span><b className="block text-xl font-black tabular">{fa(rd.counts[s])}</b><span className="text-xs font-semibold">{M.label}</span></span>
              </button>
            );
          })}
        </div>
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-black"><ShieldAlert size={15} />موانع لانچ ({fa(rd.blockers.length)})</h3>
          {rd.blockers.length === 0 ? (
            <p className="rounded-2xl bg-emerald-50 p-3 text-sm font-bold text-emerald-800">هیچ مانع حیاتی‌ای وجود ندارد.</p>
          ) : (
            <ul className="space-y-2">
              {rd.blockers.map((b) => (
                <li key={b.id} className="rounded-2xl border border-red-100 bg-red-50/60 p-3 text-xs">
                  <b className="text-red-800">{b.label}</b>
                  <p className="mt-0.5 leading-6 text-ink/80">{b.summary}</p>
                  {b.fixHref && <Link href={b.fixHref} className="mt-1 inline-flex items-center gap-1 font-bold underline"><Wrench size={12} />رفع مشکل</Link>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ابزارهای تست زنده */}
      <section className="grid gap-3 lg:grid-cols-3" aria-label="ابزارهای تست زنده">
        <form className="panel-solid p-4" onSubmit={(e) => { e.preventDefault(); void sendTest("email"); }}>
          <h3 className="mb-1 flex items-center gap-2 text-sm font-black"><Mail size={15} />ارسال ایمیل آزمایشی</h3>
          <p className="mb-3 text-xs leading-6 text-ink/70">یک ایمیل واقعی با تنظیمات مؤثر ارسال می‌کند تا رسیدن به صندوق ورودی را تأیید کنید.</p>
          <div className="flex gap-2">
            <input className="input" dir="ltr" type="email" required placeholder="you@example.com" value={mailTo} onChange={(e) => setMailTo(e.target.value)} aria-label="ایمیل گیرنده" />
            <button className="btn btn-primary btn-sm shrink-0" disabled={tool === "email"}>{tool === "email" ? <Loader2 className="animate-spin" size={15} /> : "ارسال"}</button>
          </div>
        </form>
        <form className="panel-solid p-4" onSubmit={(e) => { e.preventDefault(); void sendTest("sms"); }}>
          <h3 className="mb-1 flex items-center gap-2 text-sm font-black"><MessageSquare size={15} />ارسال پیامک آزمایشی</h3>
          <p className="mb-3 text-xs leading-6 text-ink/70">یک پیامک واقعی از طریق پنل مؤثر می‌فرستد (حداکثر ۳ بار در ۱۰ دقیقه).</p>
          <div className="flex gap-2">
            <input className="input" dir="ltr" inputMode="numeric" pattern="09\d{9}" required placeholder="09123456789" value={smsTo} onChange={(e) => setSmsTo(e.target.value)} aria-label="شماره‌ی موبایل گیرنده" />
            <button className="btn btn-primary btn-sm shrink-0" disabled={tool === "sms"}>{tool === "sms" ? <Loader2 className="animate-spin" size={15} /> : "ارسال"}</button>
          </div>
        </form>
        <div className="panel-solid p-4">
          <h3 className="mb-1 flex items-center gap-2 text-sm font-black"><Zap size={15} />پایش بیرونی (UptimeRobot و …)</h3>
          <p className="mb-2 text-xs leading-6 text-ink/70">وضعیت تجمیعی با کلید کرون؛ پاسخ ۲۰۰ = سالم، ۵۰۳ = قطع سرویس حیاتی.</p>
          <code dir="ltr" className="block overflow-x-auto whitespace-pre rounded-xl bg-ink px-3 py-2 text-left text-[11px] leading-5 text-mint">{`curl -H "Authorization: Bearer $CRON_SECRET" \\\n  ${origin || "https://your-domain"}/api/health/status`}</code>
        </div>
      </section>

      {/* فیلتر */}
      <div className="flex flex-wrap items-center gap-2">
        {([["all", "همه"], ["attention", "نیازمند توجه"], ["unconfigured", "تنظیم‌نشده"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k} className={`rounded-full border px-4 py-1.5 text-xs font-bold ${filter === k ? "border-ink bg-ink text-white" : "border-line bg-white text-ink/80 hover:border-ink/40"}`}>{l}</button>
        ))}
        <label className="relative mr-auto">
          <Search size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink/50" />
          <input className="input !h-9 !w-56 !pr-9 text-xs" placeholder="جستجوی سرویس…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="جستجوی سرویس" />
        </label>
      </div>

      {/* گروه‌ها */}
      {GROUPS.map((grp) => {
        const items = visible.filter((r) => r.group === grp.id);
        if (items.length === 0) return null;
        const worst = items.some((r) => r.status === "fail") ? "fail" : items.some((r) => r.status === "warn") ? "warn" : items.every((r) => r.status === "unconfigured") ? "unconfigured" : "ok";
        return (
          <section key={grp.id} aria-labelledby={`g-${grp.id}`}>
            <div className="mb-2 flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${META[worst].dot}`} aria-hidden />
              <h2 id={`g-${grp.id}`} className="text-base font-black">{grp.label}</h2>
              <span className="text-xs text-ink/65">{grp.blurb}</span>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {items.map((r) => {
                const M = META[r.status];
                const expanded = open.has(r.id);
                const h = snap.history[r.id];
                const b = busy[r.id];
                return (
                  <article key={r.id} className={`panel-solid p-4 ${r.status === "fail" ? "!border-red-200" : ""}`} aria-label={r.label}>
                    <div className="flex items-start gap-3">
                      <span className={`mt-1.5 h-3 w-3 shrink-0 rounded-full ${M.dot} ${r.status === "ok" ? "" : r.status === "fail" ? "animate-pulse" : ""}`} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-black">{r.label}</h3>
                          <span className={`badge border !py-0.5 text-[11px] ${M.chip}`}><M.Icon size={12} />{M.label}</span>
                          {r.deep && <span className="badge border border-violet-200 bg-violet-50 !py-0.5 text-[11px] text-violet-800"><FlaskConical size={12} />تست عمیق</span>}
                          {r.source && <span className="badge border border-line bg-paper !py-0.5 text-[11px] text-ink/75">{r.source}</span>}
                        </div>
                        <p className={`mt-1 text-[13px] leading-6 ${r.status === "fail" ? "font-semibold text-red-800" : "text-ink/85"}`}>{r.summary}</p>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-ink/75">
                      <span>تأخیر: <b className="tabular text-ink">{r.latencyMs != null ? `${fa(r.latencyMs)} ms` : "—"}</b></span>
                      <span>دسترسی ۲۴ ساعت: <b className={`tabular ${h?.uptime24h != null && h.uptime24h < 99 ? "text-amber-700" : "text-ink"}`}>{h?.uptime24h != null ? `${fa(h.uptime24h)}٪` : "—"}</b></span>
                      <span>۷ روز: <b className="tabular text-ink">{h?.uptime7d != null ? `${fa(h.uptime7d)}٪` : "—"}</b></span>
                      <span className="mr-auto">{rel(r.checkedAt, now)}{r.cached ? " (حافظه)" : ""}</span>
                    </div>
                    <div className="mt-2"><Spark h={h} /></div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button className="btn btn-secondary btn-sm" disabled={!!b} onClick={() => void runOne(r.id, false)}>{b === "run" ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}تست مجدد</button>
                      {r.deepAvailable && <button className="btn btn-secondary btn-sm" disabled={!!b} onClick={() => void runOne(r.id, true)} title={r.deepLabel}>{b === "deep" ? <Loader2 className="animate-spin" size={14} /> : <FlaskConical size={14} />}{r.deepLabel || "تست عمیق"}</button>}
                      {r.fixHref && r.status !== "ok" && <Link href={r.fixHref} className="btn btn-ghost btn-sm"><Wrench size={14} />{r.fixLabel || "رفع مشکل"}</Link>}
                      <button className="btn btn-ghost btn-sm mr-auto" aria-expanded={expanded} onClick={() => toggle(r.id)}>جزئیات<ChevronDown size={14} className={expanded ? "rotate-180" : ""} /></button>
                    </div>

                    {expanded && (
                      <div className="mt-3 space-y-3 border-t border-line pt-3">
                        {r.steps.length > 0 && (
                          <div>
                            <h4 className="mb-1.5 text-xs font-black">مراحل عیب‌یابی</h4>
                            <ol className="space-y-1">
                              {r.steps.map((s, i) => (
                                <li key={i} className="flex items-start gap-2 text-xs">
                                  {s.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" /> : <XCircle size={14} className="mt-0.5 shrink-0 text-red-600" />}
                                  <span className="min-w-0 flex-1"><b>{s.name}</b>{s.detail && <span className="text-ink/75"> — <span dir="auto" className="break-words">{s.detail}</span></span>}</span>
                                  {s.ms != null && <span className="tabular shrink-0 text-ink/60">{fa(s.ms)} ms</span>}
                                </li>
                              ))}
                            </ol>
                          </div>
                        )}
                        {r.metrics.length > 0 && (
                          <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
                            {r.metrics.map((m, i) => (
                              <div key={i} className="flex flex-col rounded-xl bg-paper/70 px-3 py-1.5"><dt className="text-ink/65">{m.label}</dt><dd dir="auto" className={`break-words font-bold ${m.tone ? TONE[m.tone] : "text-ink"}`}>{m.value}</dd></div>
                            ))}
                          </dl>
                        )}
                        {r.hints.length > 0 && (
                          <ul className="space-y-1 rounded-xl bg-amber-50/70 p-3 text-xs leading-6 text-amber-900">
                            {r.hints.map((t, i) => <li key={i}>💡 {t}</li>)}
                          </ul>
                        )}
                        {r.lastDeep && <p className="text-[11px] text-ink/65">آخرین تست عمیق: {rel(r.lastDeep.at, now)} — <span className={META[r.lastDeep.status].text}>{META[r.lastDeep.status].label}</span>: {r.lastDeep.summary}</p>}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
      {visible.length === 0 && <p className="panel-solid p-6 text-center text-sm text-ink/70">سرویسی با این فیلتر پیدا نشد.</p>}

      {/* رخدادها */}
      <section className="panel-solid p-5" aria-labelledby="inc-title">
        <h2 id="inc-title" className="mb-3 flex items-center gap-2 text-base font-black"><AlertTriangle size={16} />تاریخچه‌ی رخدادها</h2>
        {snap.incidents.length === 0 ? (
          <p className="text-sm text-ink/70">تاکنون قطعی یا خطای پایداری ثبت نشده است. (بررسی خودکار هر ۱۰ دقیقه انجام و در صورت قطعی پایدار به مدیران کل ایمیل می‌شود.)</p>
        ) : (
          <ol className="space-y-2">
            {snap.incidents.map((i) => (
              <li key={i.id} className="flex flex-wrap items-start gap-3 rounded-2xl border border-line p-3 text-xs">
                <span className={`badge border !py-0.5 ${i.resolvedAt ? META.ok.chip : META.fail.chip}`}>{i.resolvedAt ? "بازیابی‌شده" : "باز"}</span>
                <div className="min-w-0 flex-1"><b>{i.label}</b><p dir="auto" className="mt-0.5 break-words leading-6 text-ink/80">{i.message}</p></div>
                <div className="text-left text-ink/65"><div>شروع: {rel(i.startedAt, now)}</div><div>مدت: {dur(i.startedAt, i.resolvedAt, now)}</div></div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* ممیزی محیط */}
      <details className="panel-solid p-5">
        <summary className="cursor-pointer text-base font-black">ممیزی متغیرهای محیطی ({fa(snap.envAudit.filter((e) => e.set).length)} از {fa(snap.envAudit.length)} تنظیم‌شده)</summary>
        <p className="mb-3 mt-2 text-xs text-ink/70">فقط وضعیت «تنظیم‌شده/نشده» نمایش داده می‌شود؛ مقدار هیچ متغیری (کلید، رمز) هرگز نشان داده نمی‌شود.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line"><th className="th">متغیر</th><th className="th">اهمیت</th><th className="th">وضعیت</th><th className="th">توضیح</th></tr></thead>
            <tbody>
              {snap.envAudit.map((e) => {
                const bad = e.level === "danger" ? e.risky : e.level === "required" && !e.set;
                return (
                  <tr key={e.name} className="border-b border-line/60">
                    <td className="td font-mono text-xs" dir="ltr">{e.name}</td>
                    <td className="td text-xs">{{ required: "ضروری", recommended: "توصیه‌شده", optional: "اختیاری", danger: "خطرناک (فقط توسعه)" }[e.level]}</td>
                    <td className="td"><span className={`badge border !py-0.5 text-[11px] ${bad ? META.fail.chip : e.set ? META.ok.chip : e.level === "recommended" ? META.warn.chip : META.unconfigured.chip}`}>{e.level === "danger" ? (e.risky ? "روشن!" : "خاموش") : e.set ? "تنظیم‌شده" : "تنظیم نشده"}</span></td>
                    <td className="td text-xs text-ink/75">{e.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>

      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
        {toast && <p role="status" className={`pointer-events-auto max-w-xl rounded-2xl px-4 py-3 text-sm font-bold shadow-xl ${toast.kind === "ok" ? "bg-emerald-600 text-white" : "bg-red-600 text-white"}`}>{toast.text}</p>}
      </div>
    </div>
  );
}
