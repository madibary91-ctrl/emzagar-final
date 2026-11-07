import Link from "next/link";
import { Archive, ArchiveRestore, Banknote, Tags } from "lucide-react";
import { archiveContractAction, updateMetaAction } from "@/modules/contracts/actions";
import { parseTags } from "@/modules/contracts/service";
import { fa } from "@/lib/jalali";

/** برچسب‌ها، ارزش مالی و بایگانی هر قرارداد */
export default function ContractMetaCard({
  contractId,
  tags,
  value,
  status,
  archivedAt,
  canWrite,
  saved,
}: {
  contractId: number;
  tags: string;
  value: number | null;
  status: string;
  archivedAt: Date | null;
  canWrite: boolean;
  saved?: boolean;
}) {
  const list = parseTags(tags);
  const archivable = ["signed", "rejected", "expired", "cancelled"].includes(status);
  if (!canWrite && list.length === 0 && !value && !archivedAt) return null;
  return (
    <section id="meta" className="panel-solid space-y-4 p-5 sm:p-6" aria-labelledby="meta-title">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-mint"><Tags size={18} /></span>
        <div className="min-w-0 flex-1">
          <h2 id="meta-title" className="text-sm font-black">دسته‌بندی و بایگانی</h2>
          <p className="mt-0.5 text-xs text-ink/72">برچسب و ارزش قرارداد برای جستجو و گزارش؛ قراردادهای پایان‌یافته را می‌توان بایگانی کرد (چیزی حذف نمی‌شود).</p>
        </div>
        {archivedAt && <span className="badge border border-stone-300 bg-stone-100 text-stone-700"><Archive size={12} />بایگانی‌شده • {fa(archivedAt)}</span>}
      </div>
      {saved && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">ذخیره شد.</p>}
      {list.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="برچسب‌ها">
          {list.map((t) => (
            <li key={t}><Link href={`/admin?tag=${encodeURIComponent(t)}`} className="badge border border-ink/15 bg-white hover:bg-stone-50">#{t}</Link></li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <form action={updateMetaAction} className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
          <input type="hidden" name="id" value={contractId} />
          <div>
            <label className="label" htmlFor="meta-tags">برچسب‌ها (با ویرگول جدا کنید)</label>
            <input id="meta-tags" name="tags" defaultValue={list.join("، ")} maxLength={200} className="input" placeholder="مثلاً: سالانه، مشتری ویژه" />
          </div>
          <div>
            <label className="label" htmlFor="meta-value"><Banknote size={12} className="ml-1 inline" />ارزش (تومان)</label>
            <input id="meta-value" name="contractValue" inputMode="numeric" dir="ltr" defaultValue={value ?? ""} className="input" placeholder="—" />
          </div>
          <button className="btn-secondary">ذخیره</button>
        </form>
      ) : (
        value ? <p className="text-xs text-ink/75">ارزش قرارداد: <b>{value.toLocaleString("fa-IR")} تومان</b></p> : null
      )}
      {canWrite && (archivable || archivedAt) && (
        <form action={archiveContractAction} className="border-t border-ink/10 pt-4">
          <input type="hidden" name="id" value={contractId} />
          <input type="hidden" name="archive" value={archivedAt ? "0" : "1"} />
          <button className="btn-secondary">{archivedAt ? <><ArchiveRestore size={15} />خروج از بایگانی</> : <><Archive size={15} />انتقال به بایگانی</>}</button>
        </form>
      )}
    </section>
  );
}
