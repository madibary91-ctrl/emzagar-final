"use client";

import { FIELD_TYPES, type FieldDef } from "@/modules/fields";

const NUMERIC = new Set(["nid", "phone", "number", "date"]);

/** فرم فیلدهای قابل‌پرکردن قرارداد برای امضاکننده (کد ملی، نشانی، تاریخ …) */
export default function SignFields({ fields, values, onChange }: { fields: FieldDef[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  if (fields.length === 0) return null;
  return (
    <section className="rounded-2xl border border-ink/10 bg-white p-5" aria-labelledby="sign-fields-title">
      <h3 id="sign-fields-title" className="mb-1 text-sm font-black">اطلاعات لازم در قرارداد</h3>
      <p className="mb-4 text-xs leading-6 text-ink/72">این اطلاعات در متن قرارداد درج و همراه امضای شما در سند نهایی قفل می‌شود؛ پس از امضا قابل ویرایش نیست.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => {
          const hint = FIELD_TYPES.find((t) => t.id === f.type)?.hint;
          const id = `ff-${f.key}`;
          const common = {
            id,
            name: f.key,
            value: values[f.key] ?? "",
            required: f.required,
            "aria-describedby": `${id}-hint`,
            dir: NUMERIC.has(f.type) || f.type === "email" ? ("ltr" as const) : ("rtl" as const),
            className: "input",
          };
          return (
            <div key={f.key} className={f.type === "address" ? "sm:col-span-2" : ""}>
              <label className="label" htmlFor={id}>
                {f.label}
                {f.required ? <span className="mr-1 text-rose-600" aria-label="الزامی">*</span> : <span className="mr-1 text-xs font-normal text-ink/72">(اختیاری)</span>}
              </label>
              {f.type === "address" ? (
                <textarea {...common} rows={3} maxLength={500} onChange={(e) => onChange({ ...values, [f.key]: e.target.value })} />
              ) : (
                <input
                  {...common}
                  type={f.type === "email" ? "email" : "text"}
                  inputMode={NUMERIC.has(f.type) ? "numeric" : f.type === "email" ? "email" : "text"}
                  maxLength={f.type === "text" ? 200 : 120}
                  autoComplete={f.type === "email" ? "email" : f.type === "phone" ? "tel" : "off"}
                  onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
                />
              )}
              <p id={`${id}-hint`} className="mt-1 text-xs text-ink/72">{hint}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
