"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, Banknote, Plus, Trash2, Wand2 } from "lucide-react";
import { cancelInstallmentAction, markPaidAction, savePlanAction } from "@/modules/contract-pay/actions";
import { buildSchedule, parseAmount, validatePlan, type PlanItem } from "@/modules/contract-pay/schedule";

export type SavedRow = { id: number; title: string; kindLabel: string; amount: number; dueText: string; status: string; method: string | null; paidText: string; gate: boolean; payUrlPath: string; stateLabel: string };
type Row = { title: string; kind: PlanItem["kind"]; amount: string; dueAt: string; gate: boolean };

const fmt = (n: number) => n.toLocaleString("fa-IR");
const toRow = (i: PlanItem): Row => ({ title: i.title, kind: i.kind, amount: String(i.amount), dueAt: i.dueAt ?? "", gate: i.gate === "before_sign" });

/** سازنده و ویرایشگر «برنامه‌ی پرداخت» قرارداد + مدیریت وضعیت ردیف‌ها (ثبت دستی/لغو) */
export default function PayPlanEditor({ contractId, initial, editable, saved, payers, canDelete, contractValue }: { contractId: number; initial: PlanItem[]; editable: boolean; saved: SavedRow[]; payers: { position: number; label: string }[]; canDelete: boolean; contractValue: number | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rows, setRows] = useState<Row[]>(initial.map(toRow));
  const [payer, setPayer] = useState(0);
  const [g, setG] = useState({ total: contractValue ? String(contractValue) : "", percent: "30", count: "3", interval: "30", gate: true });

  const sum = useMemo(() => rows.reduce((s, r) => s + (parseAmount(r.amount) ?? 0), 0), [rows]);

  const generate = () => {
    const total = parseAmount(g.total);
    if (total === null) return setMsg({ ok: false, text: "مبلغ کل را وارد کنید" });
    const r = buildSchedule({ total, depositPercent: Number(g.percent) || 0, count: Number(g.count) || 0, intervalDays: Number(g.interval) || 30, gateDeposit: g.gate, payerPosition: payer });
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setRows(r.items.map(toRow));
    setMsg({ ok: true, text: "برنامه ساخته شد؛ می‌توانید ردیف‌ها را ویرایش و سپس ذخیره کنید." });
  };

  const toItems = () => rows.map((r) => ({ title: r.title, kind: r.kind, amount: parseAmount(r.amount) ?? 0, dueAt: r.dueAt || null, gate: r.gate ? "before_sign" : "none", payerPosition: payer }));

  const save = (clear = false) => {
    const items = clear ? [] : toItems();
    if (!clear) {
      const v = validatePlan(items);
      if (!v.ok) return setMsg({ ok: false, text: v.error });
    }
    start(async () => {
      const r = await savePlanAction(contractId, items);
      setMsg(r.ok ? { ok: true, text: clear ? "برنامه‌ی پرداخت حذف شد" : "برنامه‌ی پرداخت ذخیره و در متن قرارداد درج شد" } : { ok: false, text: r.error || "ذخیره نشد" });
      if (r.ok) {
        if (clear) setRows([]);
        router.refresh();
      }
    });
  };

  const upd = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-4">
      {editable ? (
        <>
          <div className="grid gap-3 rounded-2xl border border-ink/10 bg-stone-50 p-4 sm:grid-cols-2 lg:grid-cols-5">
            <div><label htmlFor="pp-total" className="label">مبلغ کل (تومان)</label><input id="pp-total" className="input" inputMode="numeric" dir="ltr" value={g.total} onChange={(e) => setG({ ...g, total: e.target.value })} placeholder="مثلاً 12000000" /></div>
            <div><label htmlFor="pp-pct" className="label">بیعانه (٪)</label><input id="pp-pct" className="input" inputMode="numeric" dir="ltr" value={g.percent} onChange={(e) => setG({ ...g, percent: e.target.value })} /></div>
            <div><label htmlFor="pp-count" className="label">تعداد اقساط</label><input id="pp-count" className="input" inputMode="numeric" dir="ltr" value={g.count} onChange={(e) => setG({ ...g, count: e.target.value })} /></div>
            <div><label htmlFor="pp-int" className="label">فاصله (روز)</label><input id="pp-int" className="input" inputMode="numeric" dir="ltr" value={g.interval} onChange={(e) => setG({ ...g, interval: e.target.value })} /></div>
            <div className="flex items-end"><button type="button" className="btn-secondary w-full" onClick={generate}><Wand2 size={15} />ساخت خودکار</button></div>
            <label className="flex items-center gap-2 text-xs font-semibold sm:col-span-2"><input type="checkbox" checked={g.gate} onChange={(e) => setG({ ...g, gate: e.target.checked })} />بیعانه (یا پرداخت اول) پیش‌شرط امضا باشد</label>
            {payers.length > 1 && (
              <div className="sm:col-span-2">
                <label htmlFor="pp-payer" className="label">پرداخت‌کننده</label>
                <select id="pp-payer" className="input" value={payer} onChange={(e) => setPayer(Number(e.target.value))}>
                  <option value={0}>آخرین امضاکننده (مشتری)</option>
                  {payers.map((p) => <option key={p.position} value={p.position}>{p.label}</option>)}
                </select>
              </div>
            )}
          </div>

          <div className="overflow-x-auto rounded-2xl border border-ink/10">
            <table className="w-full min-w-[640px]">
              <thead className="bg-stone-50"><tr><th className="th">عنوان</th><th className="th">نوع</th><th className="th">مبلغ (تومان)</th><th className="th">سررسید</th><th className="th">شرط امضا</th><th className="th" /></tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={6} className="td py-6 text-center text-ink/70">ردیفی نیست. «ساخت خودکار» را بزنید یا ردیف دستی اضافه کنید.</td></tr>}
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-ink/[.06]">
                    <td className="td"><input aria-label={`عنوان ردیف ${i + 1}`} className="input !min-h-10" value={r.title} onChange={(e) => upd(i, { title: e.target.value })} /></td>
                    <td className="td"><select aria-label="نوع" className="input !min-h-10" value={r.kind} onChange={(e) => upd(i, { kind: e.target.value as Row["kind"] })}><option value="deposit">بیعانه</option><option value="installment">قسط</option><option value="milestone">مرحله‌ای</option></select></td>
                    <td className="td"><input aria-label="مبلغ" className="input !min-h-10" dir="ltr" inputMode="numeric" value={r.amount} onChange={(e) => upd(i, { amount: e.target.value })} /></td>
                    <td className="td"><input aria-label="سررسید" type="date" className="input !min-h-10" dir="ltr" value={r.dueAt} onChange={(e) => upd(i, { dueAt: e.target.value })} /></td>
                    <td className="td text-center"><input aria-label="پیش‌شرط امضا" type="checkbox" checked={r.gate} onChange={(e) => upd(i, { gate: e.target.checked })} /></td>
                    <td className="td"><button type="button" className="btn-ghost btn-sm" aria-label="حذف ردیف" onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}><Trash2 size={15} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button type="button" className="btn-secondary btn-sm" onClick={() => setRows((rs) => [...rs, { title: "", kind: "installment", amount: "", dueAt: "", gate: false }])}><Plus size={14} />افزودن ردیف</button>
            <b className="text-sm">مجموع: {fmt(sum)} تومان</b>
            <div className="flex gap-2">
              {saved.length > 0 && <button type="button" className="btn-danger btn-sm" disabled={pending} onClick={() => save(true)}>حذف برنامه</button>}
              <button type="button" className="btn-primary btn-mint" disabled={pending || rows.length === 0} onClick={() => save()}>{pending ? "در حال ذخیره…" : "ذخیره‌ی برنامه‌ی پرداخت"}</button>
            </div>
          </div>
        </>
      ) : (
        <p className="rounded-xl bg-stone-50 p-3 text-xs leading-7 text-ink/75">پس از شروع امضا یا دریافت اولین پرداخت، برنامه قابل ویرایش نیست (بخشی از متن امضاشده است). وضعیت هر ردیف را در زیر مدیریت کنید.</p>
      )}
      {msg && <p role="status" className={`text-xs font-bold ${msg.ok ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</p>}

      {saved.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-ink/10">
          <table className="w-full min-w-[600px]">
            <thead className="bg-stone-50"><tr><th className="th">ردیف</th><th className="th">مبلغ</th><th className="th">سررسید</th><th className="th">وضعیت</th><th className="th">لینک پرداخت</th><th className="th" /></tr></thead>
            <tbody>
              {saved.map((s) => (
                <tr key={s.id} className="border-t border-ink/[.06]">
                  <td className="td font-bold">{s.title}<span className="block text-xs font-normal text-ink/65">{s.kindLabel}{s.gate ? " • پیش‌شرط امضا" : ""}</span></td>
                  <td className="td whitespace-nowrap">{fmt(s.amount)}</td>
                  <td className="td whitespace-nowrap text-xs">{s.dueText}</td>
                  <td className="td"><span className={`badge border ${s.status === "paid" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : s.status === "cancelled" ? "border-ink/10 bg-stone-50 text-ink/60" : "border-amber-200 bg-amber-50 text-amber-800"}`}>{s.status === "paid" ? <BadgeCheck size={13} /> : null}{s.status === "paid" ? `پرداخت شد (${s.method === "manual" ? "دستی" : "آنلاین"}) ${s.paidText}` : s.stateLabel}</span></td>
                  <td className="td"><input readOnly aria-label="لینک پرداخت" className="input !min-h-9 !text-xs" dir="ltr" value={s.status === "pending" ? `${typeof window !== "undefined" ? window.location.origin : ""}${s.payUrlPath}` : "—"} onFocus={(e) => e.currentTarget.select()} /></td>
                  <td className="td">
                    {s.status === "pending" && (
                      <div className="flex gap-1">
                        <button type="button" className="btn-secondary btn-sm" disabled={pending} title="ثبت پرداخت دستی (کارت‌به‌کارت/نقد)" onClick={() => {
                          const note = window.prompt("توضیح یا شماره‌ی پیگیری پرداخت دستی (اختیاری):", "");
                          if (note === null) return;
                          start(async () => { const r = await markPaidAction(s.id, note); setMsg(r.ok ? { ok: true, text: "پرداخت دستی ثبت شد" } : { ok: false, text: r.error || "ثبت نشد" }); if (r.ok) router.refresh(); });
                        }}><Banknote size={14} />دستی</button>
                        {canDelete && <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => {
                          if (!window.confirm("این ردیف لغو شود؟")) return;
                          start(async () => { const r = await cancelInstallmentAction(s.id); setMsg(r.ok ? { ok: true, text: "ردیف لغو شد" } : { ok: false, text: r.error || "لغو نشد" }); if (r.ok) router.refresh(); });
                        }}>لغو</button>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
