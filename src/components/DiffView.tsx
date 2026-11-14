import type { DiffPart } from "@/lib/diff";

/** نمایش تفاوت دو نسخه: افزوده‌ها سبز، حذف‌شده‌ها قرمز و خط‌خورده (متن به‌صورت متن ساده، بدون اجرای HTML) */
export default function DiffView({ parts }: { parts: DiffPart[] }) {
  return (
    <div className="whitespace-pre-wrap break-words rounded-2xl border border-ink/10 bg-white p-5 text-[13px] leading-8" dir="rtl">
      {parts.map((p, i) =>
        p.type === "same" ? (
          <span key={i}>{p.text}</span>
        ) : p.type === "add" ? (
          <ins key={i} className="rounded bg-emerald-100 px-0.5 text-emerald-900 no-underline" title="افزوده شد">{p.text}</ins>
        ) : (
          <del key={i} className="rounded bg-rose-100 px-0.5 text-rose-800 decoration-rose-500" title="حذف شد">{p.text}</del>
        ),
      )}
    </div>
  );
}
