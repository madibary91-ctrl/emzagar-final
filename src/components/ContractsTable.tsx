"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Archive, BellRing, Ban, MessageCircleWarning, CheckCheck, Download, Eye, FileSearch, FilePlus2, LoaderCircle, Pencil, Send, Trash2, X } from "lucide-react";
import StatusBadge from "@/components/StatusBadge";
import Modal from "@/components/ui/Modal";
import { bulkContractsAction } from "@/modules/contracts/actions";
import type { BulkOp, BulkResult } from "@/modules/contracts/bulk";

export type Row = {
  id: number;
  number: string;
  title: string;
  status: string;
  source: string;
  issuedAt: string;
  signedAt: string | null;
  expiresAt: string | null;
  userName: string;
  userEmail: string;
  templateTitle: string | null;
  tags?: string;
  contractValue?: number | null;
  archivedAt?: string | null;
  openRequests?: number;
};

const OPS: { op: BulkOp; label: string; icon: typeof Send; danger?: boolean; confirm: (n: number) => string; need: "write" | "delete" }[] = [
  { op: "publish", label: "ارسال پیش‌نویس‌ها", icon: Send, need: "write", confirm: (n) => `${n} قرارداد انتخاب‌شده (فقط پیش‌نویس‌ها) منتشر و برای امضاکنندگان ارسال شود؟` },
  { op: "remind", label: "یادآوری", icon: BellRing, need: "write", confirm: (n) => `برای ${n} قرارداد انتخاب‌شده (فقط «ارسال‌شده‌ها») یادآوری ارسال شود؟` },
  { op: "archive", label: "بایگانی", icon: Archive, need: "write", confirm: (n) => `${n} قرارداد انتخاب‌شده (فقط امضاشده، ردشده، منقضی و لغوشده‌ها) به بایگانی منتقل شود؟ چیزی حذف نمی‌شود.` },
  { op: "cancel", label: "لغو", icon: Ban, need: "delete", danger: true, confirm: (n) => `${n} قرارداد انتخاب‌شده (فقط «ارسال‌شده‌ها») لغو شود؟ امضا دیگر ممکن نخواهد بود.` },
  { op: "delete", label: "حذف", icon: Trash2, need: "delete", danger: true, confirm: (n) => `${n} قرارداد برای همیشه حذف شود؟ امضاها و لینک‌ها هم پاک می‌شوند و این کار قابل بازگشت نیست.` },
];

const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium" }).format(new Date(iso)) : "—");

export default function ContractsTable({ rows, canWrite, canDelete }: { rows: Row[]; canWrite: boolean; canDelete: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, start] = useTransition();
  const [ask, setAsk] = useState<(typeof OPS)[number] | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [running, setRunning] = useState<BulkOp | null>(null);

  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const allOn = ids.length > 0 && ids.every((i) => selected.has(i));
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(ids));
  const allowed = OPS.filter((o) => (o.need === "write" ? canWrite : canDelete));
  const selectable = canWrite || canDelete;

  function run(op: BulkOp, target: number[]) {
    setAsk(null);
    setRunning(op);
    setResult(null);
    start(async () => {
      const r = await bulkContractsAction(op, target);
      setResult(r);
      setRunning(null);
      setSelected(new Set());
      router.refresh();
    });
  }

  const label = (r: BulkResult) =>
    r.ok
      ? `${r.done.toLocaleString("fa-IR")} مورد انجام شد` + (r.skipped ? `، ${r.skipped.toLocaleString("fa-IR")} مورد به‌دلیل وضعیت نامناسب رد شد` : "") + (r.failed ? `، ${r.failed.toLocaleString("fa-IR")} مورد ناموفق بود` : "") + "."
      : r.error ?? "عملیات ناموفق بود";

  return (
    <>
      {result && (
        <div role="status" className={`mb-4 flex items-start justify-between gap-3 rounded-2xl border p-4 text-xs ${result.ok && !result.failed ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          <span className="flex items-center gap-2"><CheckCheck size={15} />{label(result)}</span>
          <button onClick={() => setResult(null)} aria-label="بستن" className="opacity-60 hover:opacity-100"><X size={14} /></button>
        </div>
      )}

      <div className="panel-solid table-scroll">
        <table className="w-full min-w-[640px]">
          <caption className="sr-only">فهرست قراردادها</caption>
          <thead className="bg-stone-50/80">
            <tr>
              {selectable && (
                <th className="th w-10">
                  <input type="checkbox" checked={allOn} onChange={toggleAll} aria-label="انتخاب همه‌ی این صفحه" className="h-4 w-4 accent-[var(--ink)]" />
                </th>
              )}
              <th scope="col" className="th">قرارداد</th>
              <th className="th hidden md:table-cell">مشتری</th>
              <th className="th">وضعیت</th>
              <th className="th hidden lg:table-cell">صدور</th>
              <th className="th hidden xl:table-cell">امضا / مهلت</th>
              <th className="th">عملیات</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const on = selected.has(c.id);
              return (
                <tr key={c.id} className={`border-t border-ink/[.07] transition ${on ? "bg-mint/10" : "hover:bg-stone-50/70"}`}>
                  {selectable && (
                    <td className="td">
                      <input type="checkbox" checked={on} onChange={() => toggle(c.id)} aria-label={`انتخاب ${c.number}`} className="h-4 w-4 accent-[var(--ink)]" />
                    </td>
                  )}
                  <td className="td">
                    <div className="font-bold">{c.title}</div>
                    <div className="text-xs text-ink/72">
                      <span dir="ltr" className="font-mono">{c.number}</span> · {c.templateTitle ?? "بدون قالب"}
                      {c.source === "shop" && " · فروشگاه"}
                    </div>
                    {((c.tags && c.tags.length > 0) || c.contractValue || (c.openRequests ?? 0) > 0 || c.archivedAt) && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {(c.openRequests ?? 0) > 0 && <span className="badge border border-rose-200 bg-rose-50 text-rose-700"><MessageCircleWarning size={11} />{(c.openRequests ?? 0).toLocaleString("fa-IR")} درخواست اصلاح</span>}
                        {c.archivedAt && <span className="badge border border-stone-300 bg-stone-100 text-stone-700"><Archive size={11} />بایگانی</span>}
                        {c.tags?.split(",").filter(Boolean).map((t) => (
                          <Link key={t} href={`/admin?tag=${encodeURIComponent(t)}`} className="badge border border-ink/10 bg-white text-ink/75 hover:bg-stone-50">#{t}</Link>
                        ))}
                        {c.contractValue ? <span className="badge border border-emerald-200 bg-emerald-50 text-emerald-800">{c.contractValue.toLocaleString("fa-IR")} تومان</span> : null}
                      </div>
                    )}
                    <div className="mt-0.5 text-xs text-ink/75 md:hidden">{c.userName}</div>
                  </td>
                  <td className="td hidden md:table-cell">
                    <div>{c.userName}</div>
                    <div className="text-xs text-ink/72" dir="ltr">{c.userEmail}</div>
                  </td>
                  <td className="td"><StatusBadge status={c.status} /></td>
                  <td className="td hidden whitespace-nowrap lg:table-cell">{fmt(c.issuedAt)}</td>
                  <td className="td hidden whitespace-nowrap text-xs xl:table-cell">
                    {c.signedAt ? fmt(c.signedAt) : c.status === "sent" && c.expiresAt ? <span className="text-amber-700">تا {fmt(c.expiresAt)}</span> : "—"}
                  </td>
                  <td className="td">
                    <div className="flex gap-2">
                      {c.status === "draft" && canWrite && <Link href={`/admin/contracts/${c.id}/edit`} className="btn-secondary btn-sm" aria-label="ویرایش"><Pencil size={14} /><span className="hidden sm:inline">ویرایش</span></Link>}
                      <Link href={`/contracts/${c.id}`} className="btn-secondary btn-sm" aria-label="مشاهده"><Eye size={14} /><span className="hidden sm:inline">مشاهده</span></Link>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={selectable ? 7 : 6} className="px-6 py-16 text-center">
                  <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-stone-100 text-ink/72"><FileSearch size={24} aria-hidden="true" /></span>
                  <p className="mt-4 text-sm font-bold">قراردادی یافت نشد</p>
                  <p className="mt-1 text-xs text-ink/72">فیلترها را تغییر دهید یا قرارداد تازه‌ای صادر کنید.</p>
                  {canWrite && <Link href="/admin/new" className="btn-primary mt-5 inline-flex"><FilePlus2 size={16} aria-hidden="true" />صدور قرارداد جدید</Link>}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* نوار عملیات گروهی (چسبیده به پایین صفحه) */}
      {selected.size > 0 && selectable && (
        <div className="fixed inset-x-3 bottom-3 z-[60] mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 rounded-2xl bg-ink p-3 text-white shadow-2xl sm:bottom-5 lg:mr-[calc(252px+0.75rem)]">
          <div className="flex items-center gap-3 pr-2 text-xs">
            <b role="status" className="rounded-lg bg-white/10 px-2.5 py-1">{selected.size.toLocaleString("fa-IR")} انتخاب</b>
            <button onClick={() => setSelected(new Set())} className="rounded-lg px-2 py-1 text-white/75 hover:text-white">لغو انتخاب</button>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={`/api/admin/export?ids=${[...selected].join(",")}`} className="btn-secondary btn-sm !border-white/15 !bg-white/10 !text-white hover:!bg-white/20"><Download size={14} />CSV</a>
            {allowed.map((o) => (
              <button
                key={o.op}
                disabled={pending}
                onClick={() => setAsk(o)}
                className={`btn-sm inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold transition disabled:opacity-60 ${o.danger ? "bg-rose-500/90 hover:bg-rose-500" : "bg-white/10 hover:bg-white/20"}`}
              >
                {running === o.op ? <LoaderCircle size={14} className="animate-spin" /> : <o.icon size={14} />}
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <Modal
        open={!!ask}
        onClose={() => setAsk(null)}
        tone={ask?.danger ? "danger" : "default"}
        icon={ask ? <ask.icon size={22} /> : undefined}
        title={ask?.label ?? ""}
        description={ask?.confirm(selected.size)}
        footer={
          ask && (
            <>
              <button type="button" onClick={() => run(ask.op, [...selected])} className={ask.danger ? "btn-danger" : "btn-primary"}>تأیید و اجرا</button>
              <button type="button" data-autofocus onClick={() => setAsk(null)} className="btn-secondary">انصراف</button>
            </>
          )
        }
      />
    </>
  );
}
