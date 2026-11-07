"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  ArrowDown, ArrowRight, ArrowUp, Check, CheckCircle2, Copy, Eye, EyeOff, ExternalLink, GripVertical, History, Layers, Loader2, Megaphone, Menu as MenuIcon,
  Monitor, PanelBottom, Palette, Plus, Redo2, RotateCcw, Search, Settings2, Smartphone, Tablet, Trash2, Undo2, UploadCloud, X, AlertTriangle,
} from "lucide-react";
import {
  GLOBAL_DEFS, PALETTES, SECTION_DEFS, SECTION_ORDER, anchorOptions, contrastRatio, newId, newSection, MAX_SECTIONS,
  type GlobalGroup, type LandingDoc, type Props, type Section, type SectionType,
} from "@/modules/landing/schema";
import { listVersionsAction, publishAction, resetToDefaultAction, restoreVersionAction, saveDraftAction, type VersionRow } from "@/modules/landing/actions";
import { FieldsForm } from "./FieldControls";
import { Icon } from "../icons";

type Device = "desktop" | "tablet" | "mobile";
type SaveState = "saved" | "dirty" | "saving" | "error";
const DEVICE_W: Record<Device, string> = { desktop: "100%", tablet: "820px", mobile: "390px" };

const GROUPS: { id: GlobalGroup; label: string; caption: string; icon: typeof Palette }[] = [
  { id: "theme", label: "برند و رنگ‌ها", caption: "نام، لوگو، رنگ، حالت روشن/تیره", icon: Palette },
  { id: "nav", label: "منوی بالای صفحه", caption: "لینک‌ها و دکمه‌ی منو", icon: MenuIcon },
  { id: "announcement", label: "نوار اطلاع‌رسانی", caption: "پیام کوتاه بالای سایت", icon: Megaphone },
  { id: "footer", label: "پایین صفحه (فوتر)", caption: "معرفی، لینک‌ها، کپی‌رایت", icon: PanelBottom },
  { id: "seo", label: "سئو و پیش‌نمایش گوگل", caption: "عنوان، توضیح، تصویر اشتراک", icon: Search },
];

const sectionTitle = (s: Section) => {
  const p = s.props;
  for (const k of ["heading", "title", "badge", "body"]) if (typeof p[k] === "string" && p[k]) return String(p[k]).slice(0, 48);
  return SECTION_DEFS[s.type].description;
};

function Confirm({ text, onYes, onNo }: { text: string; onYes: () => void; onNo: () => void }) {
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
        <p className="text-sm font-bold leading-7">{text}</p>
        <div className="mt-5 flex gap-2"><button className="btn-danger flex-1" onClick={onYes}>بله، انجام شود</button><button className="btn-secondary flex-1" onClick={onNo}>انصراف</button></div>
      </div>
    </div>
  );
}

export default function LandingEditor({ initialDoc, unpublished: initialUnpublished, versions: initialVersions, brandName }: { initialDoc: LandingDoc; unpublished: boolean; versions: VersionRow[]; brandName: string }) {
  const [doc, setDoc] = useState<LandingDoc>(initialDoc);
  const [selection, setSelection] = useState<string | null>(null);
  const [tab, setTab] = useState<"sections" | "site" | "history">("sections");
  const [device, setDevice] = useState<Device>("desktop");
  const [mobilePane, setMobilePane] = useState<"edit" | "preview">("edit");
  const [save, setSave] = useState<SaveState>("saved");
  const [unpublished, setUnpublished] = useState(initialUnpublished);
  const [versions, setVersions] = useState(initialVersions);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<{ text: string; run: () => void } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const past = useRef<LandingDoc[]>([]);
  const future = useRef<LandingDoc[]>([]);
  const lastKey = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const bump = useCallback(() => setHist({ undo: past.current.length, redo: future.current.length }), []);
  const iframe = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const first = useRef(true);
  const seq = useRef(0);
  const anchors = useMemo(() => anchorOptions(doc), [doc]);

  const flash = useCallback((text: string, bad = false) => {
    setToast({ text, bad });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 3200);
  }, []);

  /* ───── تاریخچه‌ی تغییرات (واگرد / بازگرد) با ادغام تایپ‌های پیاپی ───── */
  const docRef = useRef<LandingDoc>(initialDoc);
  const apply = useCallback((next: LandingDoc) => {
    docRef.current = next;
    setDoc(next);
    setSave("dirty");
    bump();
  }, [bump]);

  const commit = useCallback((next: LandingDoc, key = "") => {
    const now = Date.now();
    const merge = key !== "" && lastKey.current.key === key && now - lastKey.current.at < 1200;
    if (!merge) {
      past.current.push(docRef.current);
      if (past.current.length > 80) past.current.shift();
    }
    lastKey.current = { key, at: now };
    future.current = [];
    apply(next);
  }, [apply]);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(docRef.current);
    lastKey.current = { key: "", at: 0 };
    apply(prev);
  }, [apply]);
  const redo = useCallback(() => {
    const nxt = future.current.pop();
    if (!nxt) return;
    past.current.push(docRef.current);
    lastKey.current = { key: "", at: 0 };
    apply(nxt);
  }, [apply]);

  /* ───── ذخیره‌ی خودکار پیش‌نویس ───── */
  const persist = useCallback(async (d: LandingDoc): Promise<boolean> => {
    const mine = ++seq.current;
    setSave("saving");
    const res = await saveDraftAction(d).catch(() => ({ ok: false, error: "ارتباط با سرور برقرار نشد" }));
    if (mine !== seq.current) return res.ok;
    if (res.ok) { setSave("saved"); setUnpublished(true); } else { setSave("error"); flash(res.error || "ذخیره نشد", true); }
    return res.ok;
  }, [flash]);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = window.setTimeout(() => void persist(doc), 1200);
    return () => window.clearTimeout(t);
  }, [doc, persist]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (save === "dirty" || save === "saving") { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [save]);

  /* ───── همگام‌سازی با پیش‌نمایش (iframe هم‌مبدأ) ───── */
  const post = useCallback((msg: Record<string, unknown>) => {
    iframe.current?.contentWindow?.postMessage(msg, window.location.origin);
  }, []);
  useEffect(() => { if (ready.current) post({ type: "doc", doc }); }, [doc, post]);
  useEffect(() => { if (ready.current) post({ type: "select", sel: selection }); }, [selection, post]);
  useEffect(() => {
    const h = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== iframe.current?.contentWindow) return;
      const d = e.data as { type?: string; sel?: string } | null;
      if (d?.type === "ready") { ready.current = true; post({ type: "doc", doc }); post({ type: "select", sel: selection }); }
      if (d?.type === "select" && typeof d.sel === "string") { setSelection(d.sel); setMobilePane("edit"); }
    };
    window.addEventListener("message", h);
    return () => window.removeEventListener("message", h);
  }, [doc, selection, post]);

  const choose = (sel: string | null, scroll = true) => {
    setSelection(sel);
    if (sel && scroll) post({ type: "scroll", sel });
  };

  /* ───── عملیات روی بخش‌ها ───── */
  const sections = doc.sections;
  const selSection = selection?.startsWith("sec:") ? sections.find((s) => s.id === selection.slice(4)) : undefined;
  const selGroup = selection?.startsWith("g:") ? (selection.slice(2) as GlobalGroup) : undefined;

  const setSections = (next: Section[], key = "") => commit({ ...doc, sections: next }, key);
  const updateSection = (id: string, props: Props, key: string) => setSections(sections.map((s) => (s.id === id ? { ...s, props } : s)), `${id}:${key}`);
  const updateGroup = (g: GlobalGroup, props: Props, key: string) => commit({ ...doc, [g]: props } as LandingDoc, `${g}:${key}`);
  const move = (id: string, d: -1 | 1) => {
    const i = sections.findIndex((s) => s.id === id);
    const j = i + d;
    if (i < 0 || j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    setSections(next);
  };
  const toggle = (id: string) => setSections(sections.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  const duplicate = (id: string) => {
    const i = sections.findIndex((s) => s.id === id);
    if (i < 0 || sections.length >= MAX_SECTIONS) return;
    const copy: Section = { ...structuredClone(sections[i]), id: newId() };
    const next = [...sections];
    next.splice(i + 1, 0, copy);
    setSections(next);
    choose(`sec:${copy.id}`);
  };
  const remove = (id: string) => {
    setSections(sections.filter((s) => s.id !== id));
    if (selection === `sec:${id}`) setSelection(null);
  };
  const add = (type: SectionType) => {
    if (sections.length >= MAX_SECTIONS) return flash("به سقف تعداد بخش‌ها رسیده‌اید", true);
    const sec = newSection(type);
    const at = selSection ? sections.findIndex((s) => s.id === selSection.id) + 1 : sections.length;
    const next = [...sections];
    next.splice(at, 0, sec);
    setSections(next);
    setAdding(false);
    setSelection(`sec:${sec.id}`);
    window.setTimeout(() => post({ type: "scroll", sel: `sec:${sec.id}` }), 250);
  };
  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const from = sections.findIndex((s) => s.id === dragId);
    const to = sections.findIndex((s) => s.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...sections];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    setSections(next);
  };

  /* ───── انتشار و تاریخچه ───── */
  const publish = () => {
    start(async () => {
      const res = await publishAction(doc, note).catch(() => ({ ok: false, error: "ارتباط با سرور برقرار نشد" }));
      if (res.ok) {
        setSave("saved"); setUnpublished(false); setPublishing(false); setNote("");
        flash("صفحه‌ی اصلی منتشر شد 🎉");
        setVersions(await listVersionsAction().catch(() => versions));
      } else flash(res.error || "انتشار ناموفق بود", true);
    });
  };
  const restore = (id: number) => {
    start(async () => {
      const res = await restoreVersionAction(id);
      if (res.ok && res.doc) { commit(res.doc); flash("نسخه به‌عنوان پیش‌نویس بازگردانی شد؛ برای اعمال روی سایت منتشر کنید."); setTab("sections"); } else flash(res.error || "بازگردانی نشد", true);
    });
  };
  const reset = () => {
    start(async () => {
      const res = await resetToDefaultAction(String(doc.theme.brandName || brandName));
      if (res.ok && res.doc) { commit(res.doc); setSelection(null); flash("محتوای پیش‌فرض بازگردانی شد."); }
    });
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const tag = (e.target as HTMLElement).tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key.toLowerCase() === "s") { e.preventDefault(); void persist(doc).then((ok) => ok && flash("پیش‌نویس ذخیره شد")); }
      else if (!typing && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (!typing && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [doc, persist, undo, redo, flash]);

  const primary = String(doc.theme.primary || "");
  const accent = String(doc.theme.accent || "");
  const lowContrast = /^#[0-9a-f]{6}$/i.test(primary) && /^#[0-9a-f]{6}$/i.test(accent) && contrastRatio(primary, accent) < 3;

  const status = save === "saving" ? { t: "در حال ذخیره…", c: "text-ink/75" } : save === "dirty" ? { t: "تغییرات ذخیره‌نشده", c: "text-amber-700" } : save === "error" ? { t: "خطا در ذخیره", c: "text-rose-700" } : unpublished ? { t: "پیش‌نویس ذخیره شد · منتشر نشده", c: "text-amber-700" } : { t: "منتشرشده و به‌روز", c: "text-emerald-700" };

  /* ───── پنل کناری ───── */
  const detailTitle = selSection ? SECTION_DEFS[selSection.type].label : selGroup ? GROUPS.find((g) => g.id === selGroup)?.label : "";
  const detail = selSection || selGroup;

  const panel = (
    <div className="flex h-full min-h-0 flex-col">
      {detail ? (
        <>
          <div className="flex items-center gap-2 border-b border-ink/10 px-4 py-3">
            <button className="btn-ghost btn-sm" onClick={() => setSelection(null)}><ArrowRight size={15} />بازگشت</button>
            <b className="min-w-0 flex-1 truncate text-sm">{detailTitle}</b>
            {selSection && (
              <>
                <button className="grid h-9 w-9 place-items-center rounded-xl hover:bg-ink/5" title="کپی بخش" aria-label="کپی بخش" onClick={() => duplicate(selSection.id)}><Copy size={16} /></button>
                <button className="grid h-9 w-9 place-items-center rounded-xl text-rose-600 hover:bg-rose-50" title="حذف بخش" aria-label="حذف بخش" onClick={() => setConfirm({ text: "این بخش حذف شود؟ (با واگرد می‌توانید برگردانید)", run: () => remove(selSection.id) })}><Trash2 size={16} /></button>
              </>
            )}
          </div>
          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-4">
            {selSection && (
              <>
                {selSection.type === "pricing" && <p className="mb-5 rounded-2xl bg-sky-50 p-3 text-xs leading-6 text-sky-700">قیمت و ویژگی طرح‌ها خودکار از بخش «اشتراک و پرداخت» خوانده می‌شود؛ اینجا فقط متن‌های اطراف آن را ویرایش می‌کنید.</p>}
                <FieldsForm fields={SECTION_DEFS[selSection.type].fields} value={selSection.props} anchors={anchors} onChange={(p, k) => updateSection(selSection.id, p, k)} />
              </>
            )}
            {selGroup && (
              <>
                {selGroup === "theme" && (
                  <div className="mb-6">
                    <p className="label">رنگ‌بندی آماده</p>
                    <div className="grid grid-cols-2 gap-2">
                      {PALETTES.map((p) => (
                        <button key={p.id} type="button" onClick={() => commit({ ...doc, theme: { ...doc.theme, primary: p.primary, accent: p.accent, mode: p.mode } }, "palette")}
                          className={`flex items-center gap-2 rounded-xl border p-2 text-right text-[13px] font-bold transition hover:border-ink/30 ${primary === p.primary && accent === p.accent ? "border-ink bg-ink/5" : "border-ink/10"}`}>
                          <span className="flex flex-none overflow-hidden rounded-lg"><span className="h-7 w-5" style={{ background: p.primary }} /><span className="h-7 w-5" style={{ background: p.accent }} /></span>
                          <span className="truncate">{p.name}</span>
                        </button>
                      ))}
                    </div>
                    {lowContrast && <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs leading-6 text-amber-800"><AlertTriangle size={15} className="mt-0.5 flex-none" />تضاد دو رنگ کم است و متن‌ها سخت خوانده می‌شوند؛ رنگ‌ها را از هم دورتر انتخاب کنید.</p>}
                  </div>
                )}
                <FieldsForm fields={GLOBAL_DEFS[selGroup]} value={doc[selGroup]} anchors={anchors} onChange={(p, k) => updateGroup(selGroup, p, k)} />
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-1 border-b border-ink/10 p-2" role="tablist">
            {([["sections", "بخش‌ها", Layers], ["site", "تنظیمات سایت", Settings2], ["history", "نسخه‌ها", History]] as const).map(([id, label, I]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`flex min-h-10 items-center justify-center gap-1.5 rounded-xl text-[13px] font-bold transition ${tab === id ? "bg-ink text-white" : "text-ink/75 hover:bg-ink/5"}`}><I size={14} />{label}</button>
            ))}
          </div>
          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-3">
            {tab === "sections" && (
              <div className="space-y-2">
                <p className="px-1 pb-1 text-xs leading-6 text-ink/72">روی هر بخش بزنید تا ویرایش شود. برای جابه‌جایی بکشید یا از فلش‌ها استفاده کنید. روی خود پیش‌نمایش هم می‌توانید کلیک کنید.</p>
                {sections.map((s, i) => (
                  <div key={s.id} draggable onDragStart={(e) => { setDragId(s.id); e.dataTransfer.effectAllowed = "move"; }} onDragOver={(e) => { e.preventDefault(); setOverId(s.id); }} onDragLeave={() => setOverId(null)} onDrop={(e) => { e.preventDefault(); drop(s.id); setDragId(null); setOverId(null); }} onDragEnd={() => { setDragId(null); setOverId(null); }}
                    className={`group flex items-center gap-1 rounded-2xl border bg-white pr-1 transition ${overId === s.id && dragId !== s.id ? "border-blue-500 shadow-md" : "border-ink/10 hover:border-ink/25"} ${dragId === s.id ? "opacity-40" : ""}`}>
                    <span className="grid h-10 w-7 flex-none cursor-grab place-items-center text-ink/72 active:cursor-grabbing" aria-hidden><GripVertical size={16} /></span>
                    <button className={`flex min-w-0 flex-1 items-center gap-3 py-2.5 text-right ${s.enabled ? "" : "italic"}`} onClick={() => choose(`sec:${s.id}`)}>
                      <span className="text-xs font-black text-ink/72">{(i + 1).toLocaleString("fa-IR")}</span>
                      <span className="min-w-0"><b className="block truncate text-sm">{SECTION_DEFS[s.type].label}</b><span className="block truncate text-xs text-ink/72">{sectionTitle(s)}</span></span>
                    </button>
                    <div className="flex flex-none items-center">
                      <button className="grid h-8 w-7 place-items-center rounded-lg text-ink/72 hover:bg-ink/5 disabled:opacity-25" aria-label="بالا" disabled={i === 0} onClick={() => move(s.id, -1)}><ArrowUp size={14} /></button>
                      <button className="grid h-8 w-7 place-items-center rounded-lg text-ink/72 hover:bg-ink/5 disabled:opacity-25" aria-label="پایین" disabled={i === sections.length - 1} onClick={() => move(s.id, 1)}><ArrowDown size={14} /></button>
                      <button className="grid h-8 w-8 place-items-center rounded-lg text-ink/75 hover:bg-ink/5" aria-label={s.enabled ? "مخفی کردن" : "نمایش"} title={s.enabled ? "مخفی کردن" : "نمایش"} onClick={() => toggle(s.id)}>{s.enabled ? <Eye size={15} /> : <EyeOff size={15} />}</button>
                    </div>
                  </div>
                ))}
                <button className="btn-primary w-full" onClick={() => setAdding(true)}><Plus size={16} />افزودن بخش جدید</button>
              </div>
            )}
            {tab === "site" && (
              <div className="space-y-2">
                {GROUPS.map((g) => (
                  <button key={g.id} onClick={() => choose(`g:${g.id}`)} className="flex w-full items-center gap-3 rounded-2xl border border-ink/10 bg-white p-3 text-right transition hover:border-ink/25">
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-stone-100 text-ink/75"><g.icon size={18} /></span>
                    <span><b className="block text-sm">{g.label}</b><span className="text-xs text-ink/72">{g.caption}</span></span>
                  </button>
                ))}
                <button className="btn-secondary mt-4 w-full" disabled={pending} onClick={() => setConfirm({ text: "همه‌ی محتوای پیش‌نویس به متن پیش‌فرض برمی‌گردد (نسخه‌ی منتشرشده تغییر نمی‌کند). ادامه می‌دهید؟", run: reset })}><RotateCcw size={15} />بازگشت به محتوای پیش‌فرض</button>
              </div>
            )}
            {tab === "history" && (
              <div className="space-y-2">
                <p className="px-1 pb-1 text-xs leading-6 text-ink/72">با هر انتشار یک نسخه ذخیره می‌شود. بازگردانی فقط پیش‌نویس را عوض می‌کند و تا انتشار روی سایت اثری ندارد.</p>
                {versions.length === 0 && <p className="rounded-2xl bg-stone-50 p-4 text-center text-xs text-ink/75">هنوز نسخه‌ای ثبت نشده است.</p>}
                {versions.map((v) => (
                  <div key={v.id} className="flex items-center gap-3 rounded-2xl border border-ink/10 bg-white p-3">
                    <div className="min-w-0 flex-1"><b className="block truncate text-sm">{v.note || "انتشار"}</b><span className="text-xs text-ink/72">{new Date(v.at).toLocaleString("fa-IR")}</span></div>
                    <button className="btn-secondary btn-sm" disabled={pending} onClick={() => restore(v.id)}><RotateCcw size={13} />بازگردانی</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="flex h-[100dvh] flex-col bg-[#eceee9]">
      {/* نوار بالا */}
      <header className="flex flex-wrap items-center gap-2 border-b border-ink/10 bg-white px-3 py-2 sm:px-4">
        <Link href="/admin" className="btn-ghost btn-sm" aria-label="بازگشت به پنل"><ArrowRight size={15} /><span className="hidden sm:inline">پنل</span></Link>
        <div className="min-w-0">
          <b className="block truncate text-sm">ویرایشگر صفحه‌ی اصلی</b>
          <span className={`flex items-center gap-1 text-xs font-bold ${status.c}`}>{save === "saving" ? <Loader2 size={11} className="animate-spin" /> : save === "saved" && !unpublished ? <CheckCircle2 size={11} /> : null}{status.t}</span>
        </div>
        <div className="mx-auto hidden items-center gap-1 rounded-xl bg-stone-100 p-1 lg:flex" role="group" aria-label="اندازه‌ی پیش‌نمایش">
          {([["desktop", Monitor, "دسکتاپ"], ["tablet", Tablet, "تبلت"], ["mobile", Smartphone, "موبایل"]] as const).map(([d, I, label]) => (
            <button key={d} onClick={() => setDevice(d)} aria-pressed={device === d} aria-label={label} title={label} className={`grid h-8 w-10 place-items-center rounded-lg transition ${device === d ? "bg-white shadow" : "text-ink/72 hover:text-ink"}`}><I size={16} /></button>
          ))}
        </div>
        <div className="mr-auto flex items-center gap-1.5 lg:mr-0">
          <button className="grid h-9 w-9 place-items-center rounded-xl hover:bg-ink/5 disabled:opacity-30" onClick={undo} disabled={hist.undo === 0} aria-label="واگرد" title="واگرد (Ctrl+Z)"><Undo2 size={16} /></button>
          <button className="grid h-9 w-9 place-items-center rounded-xl hover:bg-ink/5 disabled:opacity-30" onClick={redo} disabled={hist.redo === 0} aria-label="بازگرد" title="بازگرد (Ctrl+Shift+Z)"><Redo2 size={16} /></button>
          <a href="/" target="_blank" rel="noopener" className="btn-secondary btn-sm hidden sm:inline-flex"><ExternalLink size={14} />مشاهده سایت</a>
          <button className="btn-mint btn-sm" onClick={() => setPublishing(true)} disabled={save === "saving"}><UploadCloud size={15} />انتشار</button>
        </div>
      </header>

      {/* انتخاب پنل در موبایل */}
      <div className="grid grid-cols-2 gap-1 border-b border-ink/10 bg-white p-1.5 lg:hidden" role="tablist">
        {([["edit", "ویرایش"], ["preview", "پیش‌نمایش"]] as const).map(([id, l]) => <button key={id} role="tab" aria-selected={mobilePane === id} onClick={() => setMobilePane(id)} className={`min-h-9 rounded-lg text-xs font-bold ${mobilePane === id ? "bg-ink text-white" : "text-ink/75"}`}>{l}</button>)}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[400px_minmax(0,1fr)]">
        <aside className={`min-h-0 min-w-0 border-l border-ink/10 bg-[#f9faf6] ${mobilePane === "edit" ? "block" : "hidden"} lg:block`}>{panel}</aside>
        <section className={`relative min-h-0 min-w-0 overflow-auto p-0 lg:p-5 ${mobilePane === "preview" ? "block" : "hidden"} lg:block`} aria-label="پیش‌نمایش زنده">
          <div className="mx-auto h-full overflow-hidden bg-white shadow-[0_20px_60px_rgba(0,0,0,.18)] transition-[max-width] duration-300 lg:rounded-2xl" style={{ maxWidth: DEVICE_W[device] }}>
            <iframe ref={iframe} title="پیش‌نمایش صفحه‌ی اصلی" src="/landing-preview" className="h-full min-h-[480px] w-full border-0 bg-white" />
          </div>
        </section>
      </div>

      {/* افزودن بخش */}
      {adding && (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="افزودن بخش" onClick={() => setAdding(false)}>
          <div className="max-h-[88dvh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl sm:p-6" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between"><b className="text-base">کدام بخش را اضافه کنیم؟</b><button className="grid h-9 w-9 place-items-center rounded-xl hover:bg-ink/5" aria-label="بستن" onClick={() => setAdding(false)}><X size={18} /></button></div>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {SECTION_ORDER.map((t) => (
                <button key={t} onClick={() => add(t)} className="flex items-start gap-3 rounded-2xl border border-ink/10 p-3.5 text-right transition hover:border-ink/30 hover:bg-stone-50">
                  <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-ink/[.06]"><Icon name={({ hero: "rocket", logos: "users", stats: "chart", features: "layers", steps: "check", showcase: "sparkles", testimonials: "message", pricing: "credit", faq: "headset", cta: "zap", text: "file" } as Record<SectionType, string>)[t]} size={18} /></span>
                  <span><b className="block text-sm">{SECTION_DEFS[t].label}</b><span className="text-xs leading-5 text-ink/75">{SECTION_DEFS[t].description}</span></span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* انتشار */}
      {publishing && (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="انتشار">
          <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <b className="text-base">انتشار صفحه‌ی اصلی</b>
            <p className="mt-2 text-xs leading-7 text-ink/75">با انتشار، همه‌ی بازدیدکنندگان نسخه‌ی جدید را می‌بینند. نسخه‌ی فعلی در «نسخه‌ها» نگه‌داری می‌شود و هر زمان قابل بازگردانی است.</p>
            <label htmlFor="note" className="label mt-4">یادداشت (اختیاری)</label>
            <input id="note" className="input" value={note} maxLength={80} placeholder="مثلاً: اضافه شدن بخش قیمت" onChange={(e) => setNote(e.target.value)} />
            <div className="mt-5 flex gap-2">
              <button className="btn-mint flex-1" disabled={pending} onClick={publish}>{pending ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}انتشار نهایی</button>
              <button className="btn-secondary" disabled={pending} onClick={() => setPublishing(false)}>انصراف</button>
            </div>
          </div>
        </div>
      )}

      {confirm && <Confirm text={confirm.text} onNo={() => setConfirm(null)} onYes={() => { const r = confirm.run; setConfirm(null); r(); }} />}

      {toast && (
        <div role="status" className={`fixed bottom-5 left-1/2 z-[90] -translate-x-1/2 rounded-2xl px-5 py-3 text-sm font-bold shadow-2xl ${toast.bad ? "bg-rose-600 text-white" : "bg-ink text-white"}`}>{toast.text}</div>
      )}
    </div>
  );
}
