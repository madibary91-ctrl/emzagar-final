"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldCheck, UploadCloud } from "lucide-react";
import { KYC_DOC_KINDS, KYC_MAX_FILE_BYTES, isValidNationalCode } from "@/modules/kyc/rules";

/** فرم ارسال مدارک هویتی؛ فایل‌ها با fetch چندبخشی (multipart) ارسال و سمت سرور رمزنگاری می‌شوند */
export default function KycForm({ defaultName }: { defaultName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const codeBad = code.length === 10 && !isValidNationalCode(code);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const fd = new FormData(e.currentTarget);
    for (const d of KYC_DOC_KINDS) {
      const f = fd.get(d.field);
      if (f instanceof File && f.size > KYC_MAX_FILE_BYTES) return setError(`حجم «${d.label}» بیش از ۵ مگابایت است`);
    }
    if (!isValidNationalCode(String(fd.get("nationalCode") || ""))) return setError("کد ملی معتبر نیست");
    setBusy(true);
    try {
      const r = await fetch("/api/kyc", { method: "POST", body: fd });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) setError(d.error || "ارسال ناموفق بود");
      else router.refresh();
    } catch {
      setError("خطای شبکه؛ دوباره تلاش کنید");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" encType="multipart/form-data">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="kyc-name">نام و نام خانوادگی (مطابق کارت ملی)</label>
          <input id="kyc-name" name="fullName" defaultValue={defaultName} className="input" required maxLength={100} autoComplete="name" />
        </div>
        <div>
          <label className="label" htmlFor="kyc-code">کد ملی</label>
          <input id="kyc-code" name="nationalCode" value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))} dir="ltr" inputMode="numeric" maxLength={10} aria-invalid={codeBad} className="input" required autoComplete="off" />
          {codeBad && <p className="mt-1 text-xs font-semibold text-red-600">کد ملی معتبر نیست</p>}
        </div>
        <div>
          <label className="label" htmlFor="kyc-birth">تاریخ تولد (اختیاری)</label>
          <input id="kyc-birth" name="birthDate" dir="ltr" placeholder="1370/01/15" maxLength={10} className="input" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {KYC_DOC_KINDS.map((d) => (
          <div key={d.kind} className="rounded-2xl border border-dashed border-ink/20 p-4">
            <label className="label flex items-center gap-1.5" htmlFor={`kyc-${d.field}`}><UploadCloud size={14} />{d.label}{d.required && <span className="text-red-600" aria-hidden="true">*</span>}</label>
            <input id={`kyc-${d.field}`} name={d.field} type="file" required={d.required} accept={d.kind === "other" ? "image/jpeg,image/png,image/webp,application/pdf" : "image/jpeg,image/png,image/webp"} className="block w-full text-xs file:ml-3 file:rounded-lg file:border-0 file:bg-ink file:px-3 file:py-2 file:text-xs file:font-bold file:text-white" />
            <p className="mt-1.5 text-xs text-ink/70">{d.hint}</p>
          </div>
        ))}
      </div>
      <p className="flex items-start gap-2 rounded-xl bg-stone-50 p-3 text-xs leading-6 text-ink/75"><ShieldCheck size={15} className="mt-1 shrink-0" />مدارک شما رمزنگاری‌شده (AES-256) ذخیره می‌شود و فقط مدیر پلتفرم برای بررسی می‌تواند آن را ببیند؛ هر مشاهده در لاگ ثبت می‌شود.</p>
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">{error}</p>}
      <button disabled={busy} className="btn-primary">{busy && <Loader2 size={15} className="animate-spin" />}ارسال برای بررسی</button>
    </form>
  );
}
