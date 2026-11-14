"use client";

import { useActionState, useMemo, useState } from "react";
import RichEditor from "@/components/RichEditor";
import { issueContractsAction, type IssueState } from "@/modules/contracts/actions";
import IdentityLevelPicker from "@/components/identity/IdentityLevelPicker";
import { suggestIdentity, toLatinDigits, type IdentityReq } from "@/modules/identity/rules";
import type { SigningMode } from "@/modules/signing/stages";
import { buildPlanJson, emptyMeta, ModePicker, PartyOptions, WitnessEditor, type PartyMeta, type WitnessRow } from "@/components/issue/SigningPlanFields";

interface Tpl { id: number; title: string; body: string }
interface U { id: number; name: string; email: string; mobile?: string; isGuest?: boolean }
interface Step { key: number; label: string; userId: string; gName: string; gMobile: string }
interface Guest { key: number; name: string; mobile: string }
/** پیش‌پر شده از کتابخانه‌ی قالب‌های آماده */
export interface IssueInitial { title: string; body: string; signerLabels?: string[] }

export default function IssueForm({ templates, users, initialCustomer, kyc, initial, identityAvailable = false }: { templates: Tpl[]; users: U[]; initialCustomer?: number; kyc?: { threshold: number; approved: boolean }; initial?: IssueInitial; identityAvailable?: boolean }) {
  // احراز هویت اختیاری امضاکننده: پیش‌فرض «عادی» (بدون هیچ مرحله‌ی اضافه)
  const [identityReq, setIdentityReq] = useState<IdentityReq>("none");
  const [expectedNc, setExpectedNc] = useState("");
  const [valueText, setValueText] = useState("");
  const valueNum = Number(valueText.replace(/[,٬\s]/g, "").replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))) || 0;
  const needKyc = !!kyc && kyc.threshold > 0 && !kyc.approved && valueNum >= kyc.threshold;
  const [state, action, pending] = useActionState<IssueState, FormData>(issueContractsAction, {});
  const [templateId, setTemplateId] = useState("");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [editorKey, setEditorKey] = useState(0);
  const [selected, setSelected] = useState<number[]>(initialCustomer && users.some((u) => u.id === initialCustomer) ? [initialCustomer] : []);
  const [search, setSearch] = useState("");
  const [steps, setSteps] = useState<Step[]>(() =>
    (initial?.signerLabels ?? []).map((label, i) => ({ key: Date.now() + i, label, userId: "guest", gName: "", gMobile: "" })),
  );
  // امضاکننده‌ی مهمان: بدون حساب کاربری، فقط نام + موبایل (کد تأیید پیامکی به همین شماره می‌رود)
  const [guests, setGuests] = useState<Guest[]>(() => (selected.length === 0 ? [{ key: 1, name: "", mobile: "" }] : []));

  // شیوه‌ی امضا، مشخصات حقوقی/مهر/پاراف هر طرف و شاهدها (همه اختیاری؛ پیش‌فرض = همان مسیر ترتیبیِ ساده)
  const [mode, setMode] = useState<SigningMode>("sequential");
  const [metas, setMetas] = useState<Record<number, PartyMeta>>({});
  const [customerMeta, setCustomerMeta] = useState<PartyMeta>(emptyMeta());
  const [witnesses, setWitnesses] = useState<WitnessRow[]>([]);
  const [witnessTiming, setWitnessTiming] = useState<"after" | "together">("after");
  const metaOf = (key: number) => metas[key] ?? emptyMeta();
  const recipientCount = selected.length + guests.filter((g) => g.name.trim() || g.mobile.trim()).length;
  const planJson = buildPlanJson({ mode, parties: steps.map((s) => metaOf(s.key)), customer: customerMeta, witnesses, witnessTiming });

  const filtered = useMemo(
    () => users.filter((u) => (u.name + u.email).toLowerCase().includes(search.toLowerCase())),
    [users, search],
  );

  const pickTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.find((x) => String(x.id) === id);
    if (t) {
      setBody(t.body);
      if (!title) setTitle(t.title);
      setEditorKey((k) => k + 1);
    }
  };
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const move = (i: number, d: -1 | 1) =>
    setSteps((s) => {
      const j = i + d;
      if (j < 0 || j >= s.length) return s;
      const c = [...s];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });

  return (
    <form action={action} className="grid gap-5 lg:grid-cols-3">
      <input type="hidden" name="signingPlan" value={planJson} />
      <div className="space-y-4 lg:col-span-2">
        <div className="card space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="issue-form-templateId" className="label">قالب</label>
              <select id="issue-form-templateId" name="templateId" value={templateId} onChange={(e) => pickTemplate(e.target.value)} className="input">
                <option value="">— بدون قالب (متن آزاد) —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="issue-form-title" className="label">عنوان قرارداد</label>
              <input id="issue-form-title" name="title" value={title} onChange={(e) => setTitle(e.target.value)} className="input" required />
            </div>
          </div>
          <div>
            <label className="label">متن قرارداد</label>
            <RichEditor key={editorKey} name="body" initialHtml={body} />
            <p className="mt-1 text-xs text-stone-600">متغیرها هنگام صدور برای هر کاربر به‌صورت خودکار جایگزین می‌شوند.</p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="card space-y-3">
          <h2 className="font-bold">۱. گیرندگان (مشتری)</h2>
          <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-black text-emerald-900">امضاکننده‌ی مهمان — بدون ثبت‌نام</div>
                <p className="mt-0.5 text-xs leading-6 text-emerald-900/80">فقط نام و موبایل کافی است. لینک امضا ارسال می‌شود و او با کد تأیید پیامکی، قرارداد را می‌بیند و امضا می‌کند.</p>
              </div>
            </div>
            {guests.map((g) => (
              <div key={g.key} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                <input name="guestName" value={g.name} onChange={(e) => setGuests((l) => l.map((x) => (x.key === g.key ? { ...x, name: e.target.value } : x)))} placeholder="نام و نام خانوادگی" aria-label="نام امضاکننده مهمان" className="input" autoComplete="off" />
                <input name="guestMobile" value={g.mobile} onChange={(e) => setGuests((l) => l.map((x) => (x.key === g.key ? { ...x, mobile: e.target.value } : x)))} placeholder="09123456789" dir="ltr" inputMode="tel" aria-label="موبایل امضاکننده مهمان" className="input" autoComplete="off" />
                <button type="button" aria-label="حذف این امضاکننده" onClick={() => setGuests((l) => l.filter((x) => x.key !== g.key))} className="btn btn-secondary btn-sm text-red-700">×</button>
              </div>
            ))}
            <button type="button" onClick={() => setGuests((l) => [...l, { key: Date.now(), name: "", mobile: "" }])} className="btn btn-secondary btn-sm w-full">+ افزودن امضاکننده‌ی مهمان</button>
          </div>

          {users.length > 0 && (
            <>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="یا جستجو در مشتریان ثبت‌شده…" className="input" />
              <div className="max-h-52 space-y-1 overflow-y-auto">
                {filtered.map((u) => (
                  <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-stone-50">
                    <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} className="accent-[#102c31]" />
                    <span>{u.name}</span>
                    {u.isGuest ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">مهمان</span>
                    ) : null}
                    <span className="text-xs text-stone-600" dir="ltr">{u.isGuest ? u.mobile : u.email}</span>
                  </label>
                ))}
              </div>
            </>
          )}
          {selected.map((id) => (
            <input key={id} type="hidden" name="customerId" value={id} />
          ))}
          <div className="flex items-center justify-between text-xs text-stone-600">
            <span>{selected.length + guests.filter((g) => g.name.trim() || g.mobile.trim()).length} گیرنده {selected.length + guests.length > 1 && "(صدور گروهی)"}</span>
            {users.length > 0 && <button type="button" className="underline" onClick={() => setSelected(filtered.map((u) => u.id))}>انتخاب همه</button>}
          </div>
        </div>

        <div className="card space-y-3">
          <h2 className="font-bold">۲. شیوه و ترتیب امضا</h2>
          <ModePicker mode={mode} onChange={setMode} />
          <p className="text-xs text-stone-600">
            {mode === "sequential" && "امضاکنندگان داخلی به‌ترتیب زیر امضا می‌کنند و در پایان نوبت مشتری است."}
            {mode === "parallel" && "همه‌ی طرف‌ها (امضاکنندگان زیر و مشتری) هم‌زمان لینک امضا می‌گیرند و ترتیب مهم نیست؛ سند وقتی نهایی می‌شود که همه امضا کرده باشند."}
            {mode === "staged" && "برای هر نفر «شماره‌ی مرحله» بدهید: هم‌شماره‌ها هم‌زمان امضا می‌کنند و مرحله‌ی بعد پس از تکمیل مرحله‌ی قبل شروع می‌شود."}
          </p>
          {steps.map((s, i) => (
            <div key={s.key} className="space-y-2 rounded-lg border border-stone-200 p-2">
              <div className="flex items-center gap-2">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-stone-200 text-xs">{i + 1}</span>
                <input
                  name="signerLabel"
                  value={s.label}
                  onChange={(e) => setSteps((st) => st.map((x) => (x.key === s.key ? { ...x, label: e.target.value } : x)))}
                  placeholder="عنوان (مثلاً بخش مالی)"
                  className="input"
                />
              </div>
              <select
                name="signerUser"
                value={s.userId}
                onChange={(e) => setSteps((st) => st.map((x) => (x.key === s.key ? { ...x, userId: e.target.value } : x)))}
                className="input"
              >
                <option value="">— انتخاب کاربر —</option>
                <option value="guest">＋ مهمان (فقط نام و موبایل)</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}{u.isGuest ? " (مهمان)" : ""}</option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-2" hidden={s.userId !== "guest"}>
                <input name="signerGuestName" value={s.gName} onChange={(e) => setSteps((st) => st.map((x) => (x.key === s.key ? { ...x, gName: e.target.value } : x)))} placeholder="نام و نام خانوادگی" aria-label="نام امضاکننده مهمان" className="input" autoComplete="off" />
                <input name="signerGuestMobile" value={s.gMobile} onChange={(e) => setSteps((st) => st.map((x) => (x.key === s.key ? { ...x, gMobile: e.target.value } : x)))} placeholder="09123456789" dir="ltr" inputMode="tel" aria-label="موبایل امضاکننده مهمان" className="input" autoComplete="off" />
              </div>
              <PartyOptions meta={metaOf(s.key)} onChange={(m) => setMetas((all) => ({ ...all, [s.key]: m }))} showStage={mode === "staged"} />
              <div className="flex gap-1">
                <button type="button" onClick={() => move(i, -1)} className="btn btn-secondary btn-sm">↑</button>
                <button type="button" onClick={() => move(i, 1)} className="btn btn-secondary btn-sm">↓</button>
                <button type="button" onClick={() => setSteps((st) => st.filter((x) => x.key !== s.key))} className="btn btn-secondary btn-sm text-red-700">حذف</button>
              </div>
            </div>
          ))}
          <button type="button" onClick={() => setSteps((s) => [...s, { key: Date.now(), label: "", userId: "", gName: "", gMobile: "" }])} className="btn btn-secondary w-full">
            + افزودن امضاکننده
          </button>
          <div className="rounded-lg bg-emerald-50 p-2 text-center text-sm text-emerald-800">{mode === "parallel" ? "مشتری: هم‌زمان با بقیه" : mode === "staged" ? "مشتری (مرحله را مشخص کنید)" : "آخرین امضاکننده: مشتری"}</div>
          <PartyOptions meta={customerMeta} onChange={setCustomerMeta} showStage={mode === "staged"} allowLegal={recipientCount <= 1} legalHint="در صدور گروهی، مشخصات شرکتِ مشتری برای هر قرارداد جدا لازم است؛ برای هر شرکت یک قرارداد جدا صادر کنید. پاراف همچنان فعال است." />
        </div>

        <div className="card space-y-3">
          <h2 className="font-bold">۳. شاهدها <span className="text-xs font-semibold text-ink/60">(اختیاری)</span></h2>
          <WitnessEditor rows={witnesses} onChange={setWitnesses} users={users} timing={witnessTiming} onTiming={setWitnessTiming} />
        </div>

        <div className="card space-y-3">
          <h2 className="font-bold">۴. امنیت هویت امضاکننده <span className="text-xs font-semibold text-ink/60">(اختیاری)</span></h2>
          <p className="text-xs leading-6 text-stone-600">برای معاملات حساس، مطمئن شوید شماره‌ی موبایلِ امضاکننده واقعاً به نام خودش است. اسناد روزمره را «عادی» بگذارید تا سریع بماند.</p>
          <IdentityLevelPicker
            value={identityReq}
            onChange={setIdentityReq}
            expectedNc={expectedNc}
            onExpectedChange={(v) => setExpectedNc(toLatinDigits(v).replace(/\D/g, "").slice(0, 10))}
            shahkarAvailable={identityAvailable}
            allowExpected={selected.length + guests.filter((g) => g.name.trim() || g.mobile.trim()).length <= 1}
            suggestion={suggestIdentity({ title, bodyHtml: body, value: valueNum })}
            compact
          />
        </div>

        {state.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{state.error}</p>}
        <div>
          <label htmlFor="issue-form-expiryDays" className="label">مهلت امضا (روز) — خالی = پیش‌فرض تنظیمات، ۰ = بدون انقضا</label>
          <input id="issue-form-expiryDays" name="expiryDays" type="number" min={0} max={3650} className="input" placeholder="پیش‌فرض" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <div>
            <label htmlFor="issue-form-tags" className="label">برچسب‌ها (با ویرگول جدا کنید)</label>
            <input id="issue-form-tags" name="tags" maxLength={200} className="input" placeholder="مثلاً: مشتری ویژه، سالانه" />
          </div>
          <div>
            <label htmlFor="issue-form-value" className="label">ارزش قرارداد (تومان) — اختیاری</label>
            <input id="issue-form-value" name="contractValue" inputMode="numeric" dir="ltr" value={valueText} onChange={(e) => setValueText(e.target.value)} className="input" placeholder="مثلاً 50000000" />
            {kyc && kyc.threshold > 0 && !kyc.approved && (
              <p role={needKyc ? "alert" : undefined} className={`mt-1 text-xs font-semibold ${needKyc ? "text-red-700" : "text-ink/70"}`}>
                {needKyc ? "این ارزش نیازمند احراز هویت تاییدشده است؛ می‌توانید پیش‌نویس ذخیره کنید یا " : `قراردادهای ${kyc.threshold.toLocaleString("fa-IR")} تومان و بیشتر نیازمند احراز هویت‌اند. `}
                <a href="/admin/kyc" className="underline">احراز هویت</a>
              </p>
            )}
          </div>
        </div>
        <button disabled={pending} name="intent" value="issue" className="btn btn-primary w-full !py-3">
          {pending ? "در حال پردازش…" : selected.length + guests.length > 1 ? `صدور ${selected.length + guests.length} قرارداد` : "صدور و ارسال قرارداد"}
        </button>
        <button disabled={pending} name="intent" value="draft" formNoValidate className="btn btn-secondary w-full !py-3">
          ذخیره به‌عنوان پیش‌نویس (بدون ارسال)
        </button>
      </div>
    </form>
  );
}
