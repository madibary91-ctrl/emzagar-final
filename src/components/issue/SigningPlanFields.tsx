"use client";

import { Building2, Eye, Stamp, BadgeCheck, Users, ListOrdered, Layers } from "lucide-react";
import type { SigningMode } from "@/modules/signing/stages";

/** مشخصات اختیاری هر طرف امضا (همه پیش‌فرض «عادی» هستند و هیچ مرحله‌ی اضافه‌ای نمی‌سازند) */
export interface PartyMeta {
  stage: string;
  legal: boolean;
  companyName: string;
  companyNationalId: string;
  signatoryTitle: string;
  sealRequired: boolean;
  initialsRequired: boolean;
}

export const emptyMeta = (): PartyMeta => ({ stage: "", legal: false, companyName: "", companyNationalId: "", signatoryTitle: "", sealRequired: true, initialsRequired: false });

export interface WitnessRow {
  key: number;
  userId: string;
  name: string;
  mobile: string;
  label: string;
  initials: boolean;
}

interface UserOpt {
  id: number;
  name: string;
  isGuest?: boolean;
}

export const MODE_OPTIONS: { value: SigningMode; title: string; hint: string; icon: typeof Users }[] = [
  { value: "sequential", title: "ترتیبی", hint: "یکی پس از دیگری", icon: ListOrdered },
  { value: "parallel", title: "هم‌زمان", hint: "همه با هم، بدون ترتیب", icon: Users },
  { value: "staged", title: "مرحله‌ای", hint: "گروه‌های هم‌زمان به‌ترتیب", icon: Layers },
];

export function ModePicker({ mode, onChange }: { mode: SigningMode; onChange: (m: SigningMode) => void }) {
  return (
    <div role="radiogroup" aria-label="شیوه‌ی امضا" className="grid grid-cols-3 gap-2">
      {MODE_OPTIONS.map((o) => {
        const Icon = o.icon;
        const on = mode === o.value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)} className={`rounded-xl border p-2 text-center transition ${on ? "border-ink bg-ink text-mint" : "border-stone-200 bg-white hover:bg-stone-50"}`}>
            <Icon size={16} className="mx-auto" />
            <span className="mt-1 block text-xs font-black">{o.title}</span>
            <span className={`block text-[10px] ${on ? "text-mint/80" : "text-stone-500"}`}>{o.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

/** گزینه‌های هر طرف: مرحله (فقط مرحله‌ای)، شرکت/مهر، پاراف */
export function PartyOptions({ meta, onChange, showStage, allowLegal = true, legalHint }: { meta: PartyMeta; onChange: (m: PartyMeta) => void; showStage: boolean; allowLegal?: boolean; legalHint?: string }) {
  const set = (patch: Partial<PartyMeta>) => onChange({ ...meta, ...patch });
  const active = meta.legal || meta.initialsRequired || (showStage && meta.stage);
  return (
    <details className="rounded-lg border border-stone-200 bg-stone-50/60 text-xs" open={!!active}>
      <summary className="cursor-pointer select-none px-2 py-1.5 font-bold text-stone-700">
        گزینه‌های حقوقی: شرکت · مهر · پاراف{showStage ? " · مرحله" : ""}
        {active ? <span className="mr-1 text-emerald-700">●</span> : null}
      </summary>
      <div className="space-y-2 p-2">
        {showStage && (
          <label className="flex items-center gap-2">
            <span className="shrink-0 font-semibold">شماره‌ی مرحله</span>
            <input type="number" min={1} max={20} value={meta.stage} onChange={(e) => set({ stage: e.target.value })} placeholder="خودکار" className="input !h-8 !w-24" aria-label="شماره‌ی مرحله‌ی امضا" />
            <span className="text-stone-500">هم‌شماره‌ها هم‌زمان امضا می‌کنند</span>
          </label>
        )}
        {allowLegal ? (
          <label className="flex cursor-pointer items-center gap-2 font-semibold">
            <input type="checkbox" checked={meta.legal} onChange={(e) => set({ legal: e.target.checked })} className="accent-[#102c31]" />
            <Building2 size={14} /> امضاکننده «حقوقی» است (نماینده‌ی شرکت)
          </label>
        ) : (
          <p className="text-stone-500">{legalHint}</p>
        )}
        {meta.legal && allowLegal && (
          <div className="space-y-2 rounded-lg bg-blue-50/60 p-2">
            <input value={meta.companyName} onChange={(e) => set({ companyName: e.target.value })} placeholder="نام شرکت" aria-label="نام شرکت" className="input" maxLength={120} />
            <div className="grid grid-cols-2 gap-2">
              <input value={meta.companyNationalId} onChange={(e) => set({ companyNationalId: e.target.value })} placeholder="شناسه ملی (۱۱ رقم)" aria-label="شناسه ملی شرکت" dir="ltr" inputMode="numeric" className="input" maxLength={11} />
              <input value={meta.signatoryTitle} onChange={(e) => set({ signatoryTitle: e.target.value })} placeholder="سمت (مدیرعامل…)" aria-label="سمت امضاکننده" className="input" maxLength={60} />
            </div>
            <label className="flex cursor-pointer items-center gap-2 font-semibold">
              <input type="checkbox" checked={meta.sealRequired} onChange={(e) => set({ sealRequired: e.target.checked })} className="accent-[#102c31]" />
              <Stamp size={14} /> درج «مهر شرکتی» الزامی باشد
            </label>
          </div>
        )}
        <label className="flex cursor-pointer items-center gap-2 font-semibold">
          <input type="checkbox" checked={meta.initialsRequired} onChange={(e) => set({ initialsRequired: e.target.checked })} className="accent-[#102c31]" />
          <BadgeCheck size={14} /> «پاراف» همه‌ی صفحات الزامی باشد
        </label>
      </div>
    </details>
  );
}

/** ویرایشگر شاهدها */
export function WitnessEditor({ rows, onChange, users, timing, onTiming }: { rows: WitnessRow[]; onChange: (r: WitnessRow[]) => void; users: UserOpt[]; timing: "after" | "together"; onTiming: (t: "after" | "together") => void }) {
  const upd = (key: number, patch: Partial<WitnessRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      <p className="text-xs leading-6 text-stone-600">شاهد فقط گواهی می‌دهد (طرف قرارداد نیست). شهادت او شرط نهایی‌شدن سند است و در شناسنامه‌ی دیجیتال با برچسب «شاهد» می‌آید.</p>
      {rows.map((w, i) => (
        <div key={w.key} className="space-y-2 rounded-lg border border-violet-200 bg-violet-50/40 p-2">
          <div className="flex items-center gap-2">
            <Eye size={14} className="shrink-0 text-violet-700" />
            <input value={w.label} onChange={(e) => upd(w.key, { label: e.target.value })} placeholder={`عنوان (شاهد ${i + 1})`} aria-label="عنوان شاهد" className="input" maxLength={40} />
            <button type="button" aria-label="حذف شاهد" onClick={() => onChange(rows.filter((r) => r.key !== w.key))} className="btn btn-secondary btn-sm text-red-700">×</button>
          </div>
          <select value={w.userId} onChange={(e) => upd(w.key, { userId: e.target.value })} className="input" aria-label="انتخاب شاهد">
            <option value="guest">＋ شاهد مهمان (نام و موبایل)</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}{u.isGuest ? " (مهمان)" : ""}</option>
            ))}
          </select>
          {w.userId === "guest" && (
            <div className="grid grid-cols-2 gap-2">
              <input value={w.name} onChange={(e) => upd(w.key, { name: e.target.value })} placeholder="نام و نام خانوادگی" aria-label="نام شاهد" className="input" autoComplete="off" />
              <input value={w.mobile} onChange={(e) => upd(w.key, { mobile: e.target.value })} placeholder="09123456789" dir="ltr" inputMode="tel" aria-label="موبایل شاهد" className="input" autoComplete="off" />
            </div>
          )}
          <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold">
            <input type="checkbox" checked={w.initials} onChange={(e) => upd(w.key, { initials: e.target.checked })} className="accent-[#102c31]" />
            شاهد هم صفحات را پاراف کند
          </label>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, { key: Date.now() + rows.length, userId: "guest", name: "", mobile: "", label: "", initials: false }])} className="btn btn-secondary w-full">+ افزودن شاهد</button>
      {rows.length > 0 && (
        <div className="rounded-lg bg-white p-2 text-xs">
          <span className="font-bold">زمان شهادت:</span>
          <label className="mr-3 inline-flex cursor-pointer items-center gap-1"><input type="radio" name="__wt" checked={timing === "after"} onChange={() => onTiming("after")} className="accent-[#102c31]" />پس از امضای همه‌ی طرف‌ها</label>
          <label className="mr-3 inline-flex cursor-pointer items-center gap-1"><input type="radio" name="__wt" checked={timing === "together"} onChange={() => onTiming("together")} className="accent-[#102c31]" />هم‌زمان با آخرین مرحله</label>
        </div>
      )}
    </div>
  );
}

/** JSON «برنامه‌ی امضا» که به‌صورت یک فیلد مخفی همراه فرم ارسال می‌شود */
export function buildPlanJson(args: {
  mode: SigningMode;
  parties: PartyMeta[];
  customer: PartyMeta;
  witnesses: WitnessRow[];
  witnessTiming: "after" | "together";
}): string {
  const wire = (m: PartyMeta) => ({
    stage: Number(m.stage) || undefined,
    legal: m.legal,
    companyName: m.companyName,
    companyNationalId: m.companyNationalId,
    signatoryTitle: m.signatoryTitle,
    sealRequired: m.legal && m.sealRequired,
    initialsRequired: m.initialsRequired,
  });
  return JSON.stringify({
    mode: args.mode,
    witnessTiming: args.witnessTiming,
    parties: args.parties.map(wire),
    customer: wire(args.customer),
    witnesses: args.witnesses.map((w) => ({ label: w.label, userId: w.userId, name: w.name, mobile: w.mobile, initials: w.initials })),
  });
}
