"use client";

import { useActionState, useState } from "react";
import { Brand } from "@/components/Brand";
import { saveBrandingAction, type BrandingState } from "@/modules/branding/actions";

interface Props {
  name: string;
  tagline: string;
  primary: string;
  accent: string;
  theme: string;
  logoUrl: string | null;
}

export default function BrandingForm(p: Props) {
  const [state, action, pending] = useActionState<BrandingState, FormData>(saveBrandingAction, {});
  const [name, setName] = useState(p.name);
  const [tagline, setTagline] = useState(p.tagline);
  const [primary, setPrimary] = useState(p.primary);
  const [accent, setAccent] = useState(p.accent);
  const [preview, setPreview] = useState<string | null>(null);

  return (
    <form action={action} className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <div className="space-y-5">
        <section className="card grid gap-4 sm:grid-cols-2">
          <h2 className="font-bold sm:col-span-2">هویت برند</h2>
          <div>
            <label htmlFor="branding-form-site_name" className="label">نام برند / سایت</label>
            <input id="branding-form-site_name" name="site_name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="input" required />
          </div>
          <div>
            <label htmlFor="branding-form-brand_tagline" className="label">شعار کوتاه (اختیاری)</label>
            <input id="branding-form-brand_tagline" name="brand_tagline" value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={60} className="input" />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="branding-form-logo" className="label">لوگو (PNG، JPG یا WebP، حداکثر ۴۰۰ کیلوبایت)</label>
            <input id="branding-form-logo"
              name="logo"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="input !py-2"
              onChange={(e) => {
                const f = e.target.files?.[0];
                setPreview(f ? URL.createObjectURL(f) : null);
              }}
            />
            {p.logoUrl && (
              <label className="mt-2 flex items-center gap-2 text-xs text-ink/75"><input type="checkbox" name="removeLogo" /> حذف لوگوی فعلی و بازگشت به نشان پیش‌فرض</label>
            )}
          </div>
        </section>

        <section className="card grid gap-4 sm:grid-cols-2">
          <h2 className="font-bold sm:col-span-2">رنگ‌ها و حالت نمایش</h2>
          <div>
            <label className="label">رنگ اصلی (تیره — برای دکمه‌ها و سایدبار)</label>
            <div className="flex gap-2">
              <input type="color" value={primary} onChange={(e) => setPrimary(e.target.value)} className="h-[46px] w-14 cursor-pointer rounded-xl border border-ink/10 bg-transparent p-1" aria-label="انتخاب رنگ اصلی" />
              <input name="brand_primary" aria-label="کد رنگ اصلی (مثلاً #102c31)" value={primary} onChange={(e) => setPrimary(e.target.value)} dir="ltr" className="input" pattern="#[0-9a-fA-F]{6}" />
            </div>
          </div>
          <div>
            <label className="label">رنگ تأکیدی (روشن — برای دکمه‌های اصلی و برجسته‌سازی)</label>
            <div className="flex gap-2">
              <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} className="h-[46px] w-14 cursor-pointer rounded-xl border border-ink/10 bg-transparent p-1" aria-label="انتخاب رنگ تأکیدی" />
              <input name="brand_accent" aria-label="کد رنگ تأکیدی (مثلاً #41e4ad)" value={accent} onChange={(e) => setAccent(e.target.value)} dir="ltr" className="input" pattern="#[0-9a-fA-F]{6}" />
            </div>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="branding-form-brand_theme" className="label">حالت پیش‌فرض نمایش (هر کاربر می‌تواند خودش تغییر دهد)</label>
            <select id="branding-form-brand_theme" name="brand_theme" defaultValue={p.theme} className="input">
              <option value="light">روشن</option>
              <option value="dark">تاریک</option>
              <option value="system">مطابق تنظیم دستگاه کاربر</option>
            </select>
          </div>
        </section>

        {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{state.error}</p>}
        {state.ok && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">برندینگ ذخیره شد و در همه‌ی صفحه‌ها اعمال می‌شود.</p>}
        <button disabled={pending} className="btn-primary">{pending ? "در حال ذخیره…" : "ذخیره برندینگ"}</button>
      </div>

      <aside className="space-y-3 lg:sticky lg:top-24 lg:self-start">
        <p className="text-xs font-bold text-ink/75">پیش‌نمایش زنده</p>
        <div className="overflow-hidden rounded-3xl border border-ink/10">
          <div className="p-6" style={{ background: primary }}>
            <Brand light name={name || "برند"} tagline={tagline} logoUrl={preview ?? p.logoUrl} href="#" />
            <div className="mt-6 flex gap-2">
              <span className="rounded-xl px-4 py-2 text-xs font-bold" style={{ background: accent, color: primary }}>دکمه‌ی اصلی</span>
              <span className="rounded-xl border border-white/20 px-4 py-2 text-xs font-bold text-white">دکمه‌ی ثانویه</span>
            </div>
          </div>
          <div className="space-y-2 bg-white p-4">
            <div className="h-2 w-2/3 rounded-full" style={{ background: primary, opacity: 0.85 }} />
            <div className="h-2 w-1/2 rounded-full" style={{ background: accent }} />
          </div>
        </div>
        <p className="text-xs leading-6 text-ink/72">تضاد رنگ‌ها هنگام ذخیره بررسی می‌شود تا متن‌ها خوانا بمانند.</p>
      </aside>
    </form>
  );
}
