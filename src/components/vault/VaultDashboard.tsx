"use client";

import PdfDownloadButton from "@/components/PdfDownloadButton";
import { safeCall } from "@/lib/safe-call";
import { useMemo, useState, useTransition } from "react";
import { Archive, ArchiveRestore, CalendarClock, CheckCircle2, Clock, Download, FileText, FolderArchive, NotebookPen, PenLine, Pin, PinOff, Search, ShieldAlert, Users, X } from "lucide-react";
import { fa, faNum } from "@/lib/jalali";
import { matchesSearch } from "@/lib/search-text";
import { VAULT_ZIP_PART_SIZE, vaultZipParts } from "@/modules/vault/limits";
import { vaultPrefAction } from "@/modules/vault/actions";
import type { VaultBucket, VaultDoc, VaultStats } from "@/modules/vault/service";

type Tab = "all" | VaultBucket | "archived";

const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "همه" },
  { key: "action", label: "منتظر امضای من" },
  { key: "waiting", label: "منتظر دیگران" },
  { key: "done", label: "نهایی‌شده" },
  { key: "closed", label: "بسته‌شده" },
  { key: "archived", label: "بایگانی" },
];

const BADGE: Record<VaultBucket, { label: string; cls: string; icon: typeof Clock }> = {
  action: { label: "منتظر امضای شما", cls: "bg-amber-50 text-amber-800", icon: PenLine },
  waiting: { label: "منتظر دیگر طرف‌ها", cls: "bg-sky-50 text-sky-800", icon: Clock },
  done: { label: "نهایی و امضاشده", cls: "bg-emerald-50 text-emerald-800", icon: CheckCircle2 },
  closed: { label: "بسته‌شده", cls: "bg-stone-100 text-stone-600", icon: ShieldAlert },
};

const CLOSED_LABEL: Record<string, string> = { rejected: "رد شد", cancelled: "لغو شد", expired: "مهلت تمام شد" };

type Sort = "smart" | "newest" | "oldest" | "title";
const SORTS: { key: Sort; label: string }[] = [
  { key: "smart", label: "پیش‌فرض (سنجاق‌شده‌ها و منتظر امضا اول)" },
  { key: "newest", label: "جدیدترین صدور" },
  { key: "oldest", label: "قدیمی‌ترین صدور" },
  { key: "title", label: "عنوان (الفبایی)" },
];

/** سندی که منتظر امضای خود کاربر است هرگز «بایگانی‌شده» حساب نمی‌شود (بایگانی کار ناتمام را پنهان می‌کرد) */
const isArchived = (d: VaultDoc) => d.archived && d.bucket !== "action";

const searchText = (d: VaultDoc) =>
  [d.title, d.number, d.sender, d.note, d.myLabel, BADGE[d.bucket].label, d.bucket === "closed" ? CLOSED_LABEL[d.status] : "", fa(d.issuedAt), d.mySignedAt ? fa(d.mySignedAt) : "", ...d.parties.map((p) => `${p.name} ${p.label}`)].join(" ");

function Stat({ label, value, tone, onClick }: { label: string; value: number; tone?: string; onClick?: () => void }) {
  const inner = (
    <>
      <b className={`block text-2xl font-black tabular ${tone ?? ""}`}>{faNum(value)}</b>
      <span className="mt-1 block text-xs text-ink/72">{label}</span>
    </>
  );
  return onClick && value > 0 ? (
    <button type="button" onClick={onClick} className="card !p-4 text-center transition hover:-translate-y-0.5">{inner}</button>
  ) : (
    <div className="card !p-4 text-center">{inner}</div>
  );
}

export default function VaultDashboard({ docs: initial, stats }: { docs: VaultDoc[]; stats: VaultStats }) {
  const [docs, setDocs] = useState(initial);
  const [tab, setTab] = useState<Tab>(stats.action > 0 ? "action" : "all");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [, start] = useTransition();

  const [sort, setSort] = useState<Sort>("smart");

  // هر سند یک‌بار برای عبارت جستجو سنجیده می‌شود؛ شمارنده‌ی تب‌ها هم «با جستجو» محاسبه می‌شود تا کاربر ببیند نتیجه در کدام دسته است
  const matched = useMemo(() => docs.filter((d) => matchesSearch(searchText(d), q)), [docs, q]);
  const counts = useMemo(() => {
    const live = matched.filter((d) => !isArchived(d));
    return {
      all: live.length,
      action: live.filter((d) => d.bucket === "action").length,
      waiting: live.filter((d) => d.bucket === "waiting").length,
      done: live.filter((d) => d.bucket === "done").length,
      closed: live.filter((d) => d.bucket === "closed").length,
      archived: matched.filter(isArchived).length,
    } satisfies Record<Tab, number>;
  }, [matched]);

  const shown = useMemo(() => {
    const list = matched.filter((d) => {
      if (tab === "archived") return isArchived(d);
      if (isArchived(d)) return false;
      return tab === "all" || d.bucket === tab;
    });
    if (sort === "smart") return list;
    const by: Record<Exclude<Sort, "smart">, (a: VaultDoc, b: VaultDoc) => number> = {
      newest: (a, b) => b.issuedAt.localeCompare(a.issuedAt),
      oldest: (a, b) => a.issuedAt.localeCompare(b.issuedAt),
      title: (a, b) => a.title.localeCompare(b.title, "fa"),
    };
    return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || by[sort](a, b));
  }, [matched, tab, sort]);

  // اگر در این تب نتیجه‌ای نیست ولی در دسته‌ی دیگری هست، مسیر پرش را نشان می‌دهیم (به‌جای بن‌بست «چیزی پیدا نشد»)
  const elsewhere = useMemo(() => TABS.find((t) => t.key !== tab && counts[t.key] > 0 && (t.key !== "all" || tab === "archived")), [counts, tab]);

  const patch = (id: number, p: Partial<Pick<VaultDoc, "pinned" | "archived" | "note">>) => {
    const before = docs;
    setError("");
    setDocs((cur) => cur.map((d) => (d.id === id ? { ...d, ...p } : d)));
    start(async () => {
      const r = await safeCall(() => vaultPrefAction(id, p));
      if (!r.ok) {
        setDocs(before);
        setError(r.error || "ذخیره نشد");
      }
    });
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="سند در کیف" value={stats.total} />
        <Stat label="امضاشده و نهایی" value={stats.signed} tone="text-emerald-700" onClick={() => { setTab("done"); setQ(""); }} />
        <Stat label="منتظر امضای شما" value={stats.action} tone={stats.action ? "text-amber-700" : ""} onClick={() => { setTab("action"); setQ(""); }} />
        <Stat label="فرستنده‌ی آشنا" value={stats.senders} />
      </div>

      {stats.expiringSoon > 0 && (
        <p role="status" className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-900">
          <CalendarClock size={16} className="mt-0.5 shrink-0" />
          <span>{faNum(stats.expiringSoon)} قرارداد شما تا ۶۰ روز آینده به پایان مدت می‌رسد؛ تاریخ پایان را در کارت هر سند ببینید.</span>
        </p>
      )}

      <div className="card !p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-52 flex-1">
            <Search size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink/50" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجو در عنوان، شماره، فرستنده، طرف‌ها، تاریخ، یادداشت…" aria-label="جستجو در اسناد" className="input w-full !px-10" />
            {q && (
              <button type="button" onClick={() => setQ("")} aria-label="پاک‌کردن جستجو" className="absolute left-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-lg text-ink/60 hover:bg-stone-100"><X size={15} /></button>
            )}
          </div>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="مرتب‌سازی اسناد" className="input !w-auto">
            {SORTS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </div>
        {stats.signed > 0 && (
          <div className="flex flex-wrap items-center gap-2" aria-label="دانلود همه‌ی اسناد">
            {Array.from({ length: vaultZipParts(stats.signed) }, (_, i) => i + 1).map((part, _i, arr) => (
              <a key={part} href={arr.length > 1 ? `/api/vault/export?part=${part}` : "/api/vault/export"} className="btn-secondary btn-sm">
                <FolderArchive size={15} />
                {arr.length > 1
                  ? `ZIP بخش ${faNum(part)} (اسناد ${faNum((part - 1) * VAULT_ZIP_PART_SIZE + 1)} تا ${faNum(Math.min(part * VAULT_ZIP_PART_SIZE, stats.signed))})`
                  : "دانلود همه‌ی اسناد (ZIP)"}
              </a>
            ))}
          </div>
        )}
        <div role="tablist" aria-label="دسته‌بندی اسناد" className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${tab === t.key ? "bg-ink text-white" : "bg-stone-100 text-ink/75 hover:bg-stone-200"}`}
            >
              {t.label}
              <span className="mr-1.5 tabular opacity-70">{faNum(counts[t.key])}</span>
            </button>
          ))}
        </div>
      </div>

      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}

      {shown.length === 0 ? (
        <div className="card !p-8 text-center text-sm text-ink/72" role="status">
          {docs.length === 0 ? (
            "هنوز سندی در کیف شما نیست. هر قراردادی که با این شماره امضا کنید، خودکار اینجا جمع می‌شود."
          ) : q.trim() ? (
            <>
              <p>برای «{q.trim()}» در این دسته سندی پیدا نشد.</p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {elsewhere && <button type="button" className="btn-primary btn-sm" onClick={() => setTab(elsewhere.key)}>{faNum(counts[elsewhere.key])} نتیجه در «{elsewhere.label}» ببینید</button>}
                <button type="button" className="btn-secondary btn-sm" onClick={() => setQ("")}>پاک‌کردن جستجو</button>
              </div>
            </>
          ) : tab === "action" ? (
            "هیچ سندی منتظر امضای شما نیست."
          ) : tab === "archived" ? (
            "بایگانی شما خالی است. اسنادی که دیگر لازم‌شان ندارید را با «بایگانی» از فهرست اصلی کنار بگذارید."
          ) : (
            <>
              <p>در این دسته سندی نیست.</p>
              <button type="button" className="btn-secondary btn-sm mt-4" onClick={() => setTab("all")}>نمایش همه‌ی اسناد</button>
            </>
          )}
        </div>
      ) : (
        <ul className="space-y-3">
          {shown.map((d) => {
            const b = BADGE[d.bucket];
            const Icon = b.icon;
            const label = d.bucket === "closed" ? CLOSED_LABEL[d.status] ?? b.label : b.label;
            return (
              <li key={d.id} className={`card !p-5 ${d.pinned ? "ring-2 ring-mint/70" : ""}`}>
                <div className="flex items-start gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-ink text-mint"><FileText size={20} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-black leading-7">{d.title}</h3>
                      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${b.cls}`}><Icon size={12} />{label}</span>
                      {d.pinned && <Pin size={13} className="text-emerald-700" aria-label="سنجاق‌شده" />}
                    </div>
                    <p className="mt-1 text-xs leading-6 text-ink/70">
                      <span dir="ltr" className="font-mono">{d.number}</span>
                      {d.sender ? <> • فرستنده: {d.sender}</> : d.quick ? <> • ارسال سریع</> : null}
                      {" • "}صدور: {fa(d.issuedAt)}
                      {d.mySignedAt && <> • امضای شما: {fa(d.mySignedAt)}</>}
                    </p>
                    {d.parties.length > 0 && (
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink/70">
                        <Users size={13} />
                        {d.parties.map((p) => (
                          <span key={`${p.position}-${p.label}`} className={`rounded-md px-1.5 py-0.5 ${p.status === "signed" ? "bg-emerald-50 text-emerald-800" : "bg-stone-100 text-ink/70"}`}>
                            {p.name} ({p.label}){p.status === "signed" ? " ✓" : ""}
                          </span>
                        ))}
                      </p>
                    )}
                    {d.termEndsAt && d.bucket === "done" && (
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-ink/70"><CalendarClock size={13} />پایان مدت قرارداد: {fa(d.termEndsAt)}</p>
                    )}
                    {d.bucket === "waiting" && !d.myTurn && d.status === "sent" && d.mySignedAt === null && <p className="mt-1 text-xs text-ink/70">نوبت امضای شما بعد از طرف‌های قبلی است.</p>}
                  </div>
                </div>

                {editing === d.id ? (
                  <div className="mt-3 space-y-2">
                    <label className="label" htmlFor={`note-${d.id}`}>یادداشت خصوصی (فقط شما می‌بینید)</label>
                    <textarea id={`note-${d.id}`} value={draft} onChange={(e) => setDraft(e.target.value.slice(0, 500))} rows={2} className="input w-full" autoFocus />
                    <div className="flex gap-2">
                      <button type="button" className="btn-primary btn-sm" onClick={() => { patch(d.id, { note: draft }); setEditing(null); }}>ذخیره</button>
                      <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(null)}>انصراف</button>
                    </div>
                  </div>
                ) : (
                  d.note && <p className="mt-3 rounded-xl bg-stone-50 p-3 text-xs leading-6 text-ink/80">📝 {d.note}</p>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {d.bucket === "action" && (
                    <a href={`/api/vault/contracts/${d.id}/sign`} className="btn-primary btn-mint btn-sm"><PenLine size={15} />مشاهده و امضا</a>
                  )}
                  {d.bucket === "done" && (
                    <PdfDownloadButton href={`/api/vault/contracts/${d.id}/pdf`} filename={`contract-${d.id}.pdf`} className="btn-primary btn-sm"><Download size={15} />دانلود PDF رسمی</PdfDownloadButton>
                  )}
                  <button type="button" className="btn-ghost btn-sm" onClick={() => patch(d.id, { pinned: !d.pinned })}>
                    {d.pinned ? <PinOff size={15} /> : <Pin size={15} />}{d.pinned ? "برداشتن سنجاق" : "سنجاق"}
                  </button>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => { setEditing(d.id); setDraft(d.note); }}>
                    <NotebookPen size={15} />{d.note ? "ویرایش یادداشت" : "یادداشت"}
                  </button>
                  {d.bucket !== "action" && (
                    <button type="button" className="btn-ghost btn-sm" onClick={() => patch(d.id, { archived: !d.archived })}>
                      {d.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{d.archived ? "خروج از بایگانی" : "بایگانی"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
