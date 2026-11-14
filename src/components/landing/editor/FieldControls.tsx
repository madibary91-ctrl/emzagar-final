"use client";

import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ImagePlus, Loader2, Plus, Trash2, X } from "lucide-react";
import { ICON_LABELS, ICON_NAMES, PAGE_LINKS, emptyValue, type FieldDef, type Props, type Value } from "@/modules/landing/schema";
import { Icon } from "../icons";

type Anchor = { value: string; label: string };
type Change = (next: Props, fieldKey: string) => void;

/* ───────── آپلود تصویر ───────── */
async function uploadImage(file: File): Promise<{ ok: boolean; url?: string; error?: string }> {
  const fd = new FormData();
  fd.set("file", file);
  try {
    const res = await fetch("/api/landing/upload", { method: "POST", body: fd });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; url?: string; error?: string } | null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error || "بارگذاری ناموفق بود" };
    return { ok: true, url: json.url };
  } catch {
    return { ok: false, error: "ارتباط با سرور برقرار نشد" };
  }
}

function ImageField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pick = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError("");
    const r = await uploadImage(file);
    setBusy(false);
    if (r.ok && r.url) onChange(r.url);
    else setError(r.error || "خطا");
    if (input.current) input.current.value = "";
  };
  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="grid h-16 w-24 flex-none place-items-center overflow-hidden rounded-xl border border-ink/10 bg-stone-100">
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="" className="h-full w-full object-cover" />
          ) : <ImagePlus size={20} className="text-ink/72" />}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
            {value ? "تغییر تصویر" : "انتخاب تصویر"}
          </button>
          {value && <button type="button" className="btn-ghost btn-sm" onClick={() => onChange("")}><X size={14} />حذف</button>}
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      </div>
      {error && <p className="mt-2 text-xs text-rose-700" role="alert">{error}</p>}
    </div>
  );
}

function LinkField({ value, onChange, anchors }: { value: string; onChange: (v: string) => void; anchors: Anchor[] }) {
  const known = [...PAGE_LINKS, ...anchors];
  const matched = value === "" ? "" : known.find((k) => k.value === value)?.value ?? "__custom";
  const [custom, setCustom] = useState(matched === "__custom");
  const mode = custom ? "__custom" : matched;
  return (
    <div className="space-y-2">
      <select
        className="input"
        value={mode}
        onChange={(e) => {
          if (e.target.value === "__custom") { setCustom(true); if (known.some((k) => k.value === value)) onChange(""); return; }
          setCustom(false);
          onChange(e.target.value);
        }}
      >
        <option value="">— بدون لینک —</option>
        <optgroup label="صفحه‌های سایت">{PAGE_LINKS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>
        {anchors.length > 0 && <optgroup label="بخش‌های همین صفحه">{anchors.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>}
        <option value="__custom">آدرس دلخواه…</option>
      </select>
      {mode === "__custom" && (
        <input className="input ltr text-left" dir="ltr" placeholder="https://example.com یا /مسیر یا tel:+98…" value={value} maxLength={300} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function IconField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="btn-secondary btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name={value} size={16} />{ICON_LABELS[value as keyof typeof ICON_LABELS] ?? "انتخاب آیکون"}<ChevronDown size={14} />
      </button>
      {open && (
        <div className="mt-2 grid grid-cols-7 gap-1.5 rounded-2xl border border-ink/10 bg-stone-50 p-2.5">
          {ICON_NAMES.map((n) => (
            <button key={n} type="button" title={ICON_LABELS[n]} aria-label={ICON_LABELS[n]} aria-pressed={n === value} onClick={() => { onChange(n); setOpen(false); }}
              className={`grid h-9 w-full place-items-center rounded-lg transition ${n === value ? "bg-ink text-white" : "bg-white text-ink/70 hover:bg-ink/10"}`}>
              <Icon name={n} size={16} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ListField({ def, value, onChange, anchors }: { def: Extract<FieldDef, { kind: "list" }>; value: Props[]; onChange: (v: Props[]) => void; anchors: Anchor[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const blank = (): Props => Object.fromEntries(def.fields.map((f) => [f.key, emptyValue(f)]));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    setOpen((o) => (o === i ? j : o === j ? i : o));
  };
  return (
    <div className="space-y-2">
      {value.map((item, i) => {
        const raw = item[def.titleKey];
        const title = (typeof raw === "string" && raw) || `${def.itemLabel} ${(i + 1).toLocaleString("fa-IR")}`;
        const isOpen = open === i;
        return (
          <div key={i} className="overflow-hidden rounded-2xl border border-ink/10 bg-white">
            <div className="flex items-center gap-1 px-3 py-2">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1 text-right" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : i)}>
                <ChevronDown size={15} className={`flex-none text-ink/72 transition ${isOpen ? "rotate-180" : ""}`} />
                <span className="truncate text-sm font-bold">{title}</span>
              </button>
              <button type="button" className="grid h-8 w-8 place-items-center rounded-lg text-ink/75 hover:bg-ink/5 disabled:opacity-30" aria-label="بالا" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
              <button type="button" className="grid h-8 w-8 place-items-center rounded-lg text-ink/75 hover:bg-ink/5 disabled:opacity-30" aria-label="پایین" disabled={i === value.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
              <button type="button" className="grid h-8 w-8 place-items-center rounded-lg text-rose-600 hover:bg-rose-50" aria-label="حذف" onClick={() => { onChange(value.filter((_, k) => k !== i)); setOpen(null); }}><Trash2 size={14} /></button>
            </div>
            {isOpen && (
              <div className="border-t border-ink/10 bg-stone-50/60 p-3">
                <FieldsForm fields={def.fields} value={item} anchors={anchors} onChange={(next) => onChange(value.map((x, k) => (k === i ? next : x)))} />
              </div>
            )}
          </div>
        );
      })}
      <button type="button" className="btn-secondary btn-sm w-full" disabled={value.length >= def.max} onClick={() => { onChange([...value, blank()]); setOpen(value.length); }}>
        <Plus size={14} />افزودن {def.itemLabel}{value.length >= def.max ? ` (حداکثر ${def.max.toLocaleString("fa-IR")})` : ""}
      </button>
    </div>
  );
}

function Segmented({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-1 rounded-xl bg-stone-100 p-1" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={`min-h-9 flex-1 rounded-lg px-2 text-[13px] font-bold transition ${value === o.value ? "bg-white text-ink shadow" : "text-ink/75 hover:text-ink"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function FieldsForm({ fields, value, onChange, anchors }: { fields: FieldDef[]; value: Props; onChange: Change; anchors: Anchor[] }) {
  const set = (key: string, v: Value) => onChange({ ...value, [key]: v }, key);
  return (
    <div className="space-y-5">
      {fields.map((f) => {
        const v = value[f.key];
        const str = typeof v === "string" ? v : "";
        const id = `f-${f.key}`;
        return (
          <div key={f.key}>
            {f.kind === "toggle" ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-bold">{f.label}</span>
                <button type="button" role="switch" aria-checked={v === true} aria-label={f.label} onClick={() => set(f.key, v !== true)}
                  className={`relative h-7 w-12 flex-none rounded-full transition ${v === true ? "bg-emerald-500" : "bg-stone-300"}`}>
                  <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${v === true ? "right-1" : "right-6"}`} />
                </button>
              </div>
            ) : (
              <label htmlFor={id} className="label">{f.label}</label>
            )}
            {f.kind === "text" && <input id={id} className="input" value={str} maxLength={f.max} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} />}
            {f.kind === "textarea" && <textarea id={id} className="input" rows={f.rows ?? 3} value={str} maxLength={f.max} onChange={(e) => set(f.key, e.target.value)} />}
            {f.kind === "select" && (f.options.length <= 3
              ? <Segmented options={f.options} value={str} onChange={(x) => set(f.key, x)} />
              : <select id={id} className="input" value={str} onChange={(e) => set(f.key, e.target.value)}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>)}
            {f.kind === "image" && <ImageField value={str} onChange={(x) => set(f.key, x)} />}
            {f.kind === "link" && <LinkField value={str} anchors={anchors} onChange={(x) => set(f.key, x)} />}
            {f.kind === "icon" && <IconField value={str} onChange={(x) => set(f.key, x)} />}
            {f.kind === "color" && (
              <div className="flex items-center gap-3">
                <input id={id} type="color" className="h-11 w-14 flex-none cursor-pointer rounded-xl border border-ink/10 bg-white p-1" value={/^#[0-9a-f]{6}$/i.test(str) ? str : "#000000"} onChange={(e) => set(f.key, e.target.value)} />
                <input className="input ltr text-left" dir="ltr" value={str} maxLength={7} onChange={(e) => set(f.key, e.target.value)} aria-label={`${f.label} (کد رنگ)`} />
              </div>
            )}
            {f.kind === "list" && <ListField def={f} value={Array.isArray(v) ? v : []} anchors={anchors} onChange={(x) => set(f.key, x)} />}
            {"hint" in f && f.hint && <p className="mt-1.5 text-xs leading-5 text-ink/72">{f.hint}</p>}
          </div>
        );
      })}
    </div>
  );
}
