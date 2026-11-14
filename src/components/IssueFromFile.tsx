"use client";

import { useState, useTransition } from "react";
import { LoaderCircle, Plus, Send, Trash2 } from "lucide-react";
import DocUploader, { DocWarnings, type UploadedDoc } from "@/components/DocUploader";
import { DocPlacer } from "@/components/DocViews";
import type { Placement } from "@/modules/docs/placement";
import { issueFromFileAction, type FileParty } from "@/modules/docs/actions";

type U = { id: number; name: string; email: string; mobile: string; isGuest: boolean };
type Row = FileParty & { key: number };

export default function IssueFromFile({ users }: { users: U[] }) {
  const [doc, setDoc] = useState<UploadedDoc | null>(null);
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<Row[]>([
    { key: 1, label: "طرف اول", userId: null, guestName: "", guestMobile: "" },
    { key: 2, label: "مشتری", userId: null, guestName: "", guestMobile: "" },
  ]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [expiry, setExpiry] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  const setRow = (i: number, patch: Partial<Row>) => setRows((r) => r.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const signers = rows.map((r, i) => ({ pos: i + 1, label: r.label || `امضاکننده ${i + 1}` }));

  const submit = () => {
    setError("");
    if (!doc) return setError("ابتدا فایل را بارگذاری کنید");
    start(async () => {
      const r = await issueFromFileAction({
        title,
        draftCode: doc.code,
        placements,
        parties: rows.map(({ label, userId, guestName, guestMobile }) => ({ label, userId, guestName, guestMobile })),
        expiryDays: expiry.trim() === "" ? null : Number(expiry),
      });
      if (r?.error) setError(r.error);
    });
  };

  return (
    <div className="space-y-6">
      <section className="card space-y-4">
        <h2 className="text-sm font-black">۱) فایل</h2>
        {doc ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-stone-50 p-4 text-sm">
            <span><b>{doc.name}</b> — {doc.pageCount} صفحه ({doc.kind === "docx" ? "Word ← تبدیل به PDF" : "PDF"})</span>
            <button type="button" className="btn-secondary btn-sm" onClick={() => { setDoc(null); setPlacements([]); }}>تعویض فایل</button>
          </div>
        ) : (
          <DocUploader mode="team" onUploaded={(d) => { setDoc(d); setTitle(d.name.replace(/\.(pdf|docx)$/i, "")); }} />
        )}
        {doc && <DocWarnings warnings={doc.warnings} />}
        <div>
          <label className="label" htmlFor="f-title">عنوان قرارداد</label>
          <input id="f-title" className="input" value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} />
        </div>
      </section>

      <section className="card space-y-4">
        <h2 className="text-sm font-black">۲) امضاکنندگان (به ترتیب امضا)</h2>
        {rows.map((r, i) => (
          <div key={r.key} className="grid gap-2 rounded-2xl bg-stone-50 p-3 sm:grid-cols-[150px_1fr_auto] sm:items-start">
            <input aria-label={`نقش امضاکننده ${i + 1}`} className="input" value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} placeholder="نقش (مثلاً کارفرما)" />
            <div className="space-y-2">
              <select aria-label={`امضاکننده ${i + 1}`} className="input" value={r.userId ?? ""} onChange={(e) => setRow(i, { userId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">+ مهمان جدید (فقط نام و موبایل)</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}{u.mobile ? ` — ${u.mobile}` : ""}</option>)}
              </select>
              {r.userId === null && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <input aria-label="نام مهمان" className="input" placeholder="نام و نام خانوادگی" value={r.guestName ?? ""} onChange={(e) => setRow(i, { guestName: e.target.value })} />
                  <input aria-label="موبایل مهمان" dir="ltr" className="input text-left" placeholder="09123456789" inputMode="tel" value={r.guestMobile ?? ""} onChange={(e) => setRow(i, { guestMobile: e.target.value })} />
                </div>
              )}
            </div>
            <button type="button" disabled={rows.length <= 1} onClick={() => { setRows((x) => x.filter((_, k) => k !== i)); setPlacements((p) => p.filter((f) => f.signerPosition !== i + 1).map((f) => (f.signerPosition > i + 1 ? { ...f, signerPosition: f.signerPosition - 1 } : f))); }} className="btn-ghost btn-sm" aria-label="حذف امضاکننده"><Trash2 size={15} /></button>
          </div>
        ))}
        {rows.length < 6 && (
          <button type="button" className="btn-secondary btn-sm" onClick={() => setRows((r) => [...r.slice(0, -1), { key: Date.now(), label: `امضاکننده ${r.length}`, userId: null, guestName: "", guestMobile: "" }, r[r.length - 1]])}><Plus size={14} />افزودن امضاکننده‌ی میانی</button>
        )}
        <div className="max-w-xs">
          <label className="label" htmlFor="f-exp">مهلت امضا (روز؛ خالی = پیش‌فرض تنظیمات)</label>
          <input id="f-exp" className="input" inputMode="numeric" value={expiry} onChange={(e) => setExpiry(e.target.value.replace(/\D/g, "").slice(0, 4))} />
        </div>
      </section>

      {doc && (
        <section className="space-y-3">
          <h2 className="text-sm font-black">۳) جای امضا و فیلدها روی خود فایل</h2>
          <DocPlacer url={`/api/docs/draft/${doc.code}`} pages={doc.pages} signers={signers} value={placements} onChange={setPlacements} />
        </section>
      )}

      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
      <div className="flex justify-end">
        <button type="button" disabled={pending || !doc} onClick={submit} className="btn-primary btn-mint !min-h-[50px] sm:!px-8">
          {pending ? <LoaderCircle size={17} className="animate-spin" /> : <Send size={17} />}صدور و ارسال برای امضا
        </button>
      </div>
    </div>
  );
}
